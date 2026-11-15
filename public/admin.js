const KEY_STORE = 'dafuweng:admin-key';
const STATUS = { lobby: '等待开局', playing: '对局中', finished: '已结束' };

const loginForm = document.getElementById('login');
const panel = document.getElementById('panel');
const roomsBox = document.getElementById('rooms');
const toastEl = document.getElementById('toast');

let key = readKey();
let rooms = [];
let serverNow = Date.now();
let filter = 'all';
let openCode = null;
let refreshTimer = 0;

boot();

function boot() {
  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    key = document.getElementById('key').value.trim();
    document.getElementById('login-error').textContent = '';
    const ok = await loadRooms(true);
    if (ok) saveKey(key);
  });
  document.getElementById('btn-refresh').addEventListener('click', () => loadRooms());
  document.getElementById('btn-logout').addEventListener('click', () => {
    key = '';
    saveKey('');
    showLogin('');
  });
  document.querySelectorAll('[data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      filter = button.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-selected', String(b === button)));
      renderRooms();
    });
  });
  document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => closeDetail());
  });
  document.getElementById('detail').addEventListener('click', (event) => {
    if (event.target.id === 'detail') closeDetail();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!document.getElementById('confirm').hidden) document.getElementById('confirm-no').click();
    else closeDetail();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && key) loadRooms();
  });
  if (key) loadRooms(true);
  else showLogin('');
}

function showLogin(message) {
  window.clearInterval(refreshTimer);
  refreshTimer = 0;
  panel.hidden = true;
  loginForm.hidden = false;
  document.getElementById('btn-refresh').hidden = true;
  document.getElementById('btn-logout').hidden = true;
  document.getElementById('login-error').textContent = message;
  document.getElementById('key').focus();
}

async function api(path, options = {}) {
  const res = await fetch(`/api/admin/${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.status === 401 || res.status === 503) {
    showLogin(data?.error || '管理密钥不对');
    throw new Error('auth');
  }
  if (!res.ok || !data?.ok) throw new Error(data?.error || `出错了（${res.status}）`);
  return data;
}

async function loadRooms(first) {
  try {
    const data = await api('rooms');
    rooms = data.rooms;
    serverNow = data.now;
    loginForm.hidden = true;
    panel.hidden = false;
    document.getElementById('btn-refresh').hidden = false;
    document.getElementById('btn-logout').hidden = false;
    renderRooms();
    if (!refreshTimer) refreshTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') loadRooms();
    }, 20000);
    return true;
  } catch (err) {
    if (err.message !== 'auth') {
      if (first) showLogin(err.message);
      else toast(err.message);
    }
    return false;
  }
}

function renderRooms() {
  const playing = rooms.filter((r) => r.status === 'playing').length;
  const online = rooms.reduce((sum, r) => sum + (r.online || 0), 0);
  document.getElementById('summary').textContent = `${rooms.length} 个房间 · ${playing} 局在进行 · ${online} 人在线`;
  roomsBox.replaceChildren();
  const list = rooms.filter((r) => filter === 'all' || r.status === filter);
  if (!list.length) {
    roomsBox.append(el('p', 'admin-empty', rooms.length ? '这一类没有房间。' : '还没有登记的房间。'));
    return;
  }
  for (const room of list) roomsBox.append(roomCard(room));
}

function roomCard(room) {
  const card = el('article', 'card admin-room');
  const head = el('div', 'admin-room-head');
  head.append(el('b', 'admin-code', room.code));
  head.append(el('span', `status-pill s-${room.status}`, STATUS[room.status] || room.status));
  card.append(head);
  const players = parsePlayers(room.players);
  const row = el('div', 'admin-tokens');
  if (!players.length) row.append(el('span', 'note', '没有玩家'));
  for (const p of players) {
    const chip = el('span', `admin-chip${p.on ? '' : ' off'}${p.b ? ' out' : ''}`);
    const dot = el('i', '', p.n.slice(0, 1));
    dot.style.background = p.c;
    chip.append(dot, document.createTextNode(p.n));
    if (p.h) chip.append(el('em', '', '房主'));
    row.append(chip);
  }
  card.append(row);
  const meta = el('p', 'admin-meta');
  const bits = [`${room.online} 人在线`, `${room.player_count} 名玩家`];
  if (room.spectators) bits.push(`${room.spectators} 人观战`);
  bits.push(`最后活动 ${ago(room.last_active)}`);
  meta.textContent = bits.join(' · ');
  card.append(meta);
  const actions = el('div', 'admin-actions');
  actions.append(button('详情', 'secondary', () => openDetail(room.code)));
  if (room.status === 'playing') actions.append(button('结束对局', 'secondary', () => endGame(room.code)));
  actions.append(button('删除', 'danger', () => removeRoom(room.code)));
  card.append(actions);
  return card;
}

async function openDetail(code) {
  openCode = code;
  const box = document.getElementById('detail');
  document.getElementById('detail-title').textContent = `房间 ${code}`;
  const body = document.getElementById('detail-body');
  body.replaceChildren(el('p', 'act-text', '正在读取……'));
  box.hidden = false;
  try {
    const data = await api(`rooms/${code}`);
    if (openCode === code) renderDetail(data.room);
  } catch (err) {
    if (err.message !== 'auth') body.replaceChildren(el('p', 'act-text', err.message));
  }
}

function closeDetail() {
  openCode = null;
  document.getElementById('detail').hidden = true;
}

function renderDetail(room) {
  const body = document.getElementById('detail-body');
  body.replaceChildren();
  const facts = el('div', 'invite-grid admin-facts');
  facts.append(fact('状态', STATUS[room.status] || room.status));
  facts.append(fact('密码', room.password || '没有设'));
  facts.append(fact('创建', when(room.createdAt)));
  facts.append(fact('最后活动', ago(room.lastActiveAt)));
  body.append(facts);

  const people = el('section', 'admin-people');
  people.append(el('h4', '', `玩家 ${room.players.length}`));
  for (const p of room.players) {
    const row = el('div', 'seat');
    const tok = el('span', `token${p.connected ? '' : ' off'}`, p.nickname.slice(0, 1));
    tok.style.background = p.color;
    tok.setAttribute('aria-hidden', 'true');
    row.append(tok);
    const info = el('div', 'grow admin-person');
    const name = el('div', 'name');
    name.append(el('b', '', p.nickname));
    if (p.isHost) name.append(el('span', 'badge host', '房主'));
    if (room.currentPlayerId === p.id && room.status === 'playing') name.append(el('span', 'badge now', '回合中'));
    if (room.winnerId === p.id) name.append(el('span', 'badge host', '赢家'));
    if (p.bankrupt) name.append(el('span', 'badge', '出局'));
    if (p.inJail) name.append(el('span', 'badge', '停走'));
    name.append(el('span', p.connected ? 'badge' : 'badge off', p.connected ? '在线' : '离线'));
    info.append(name);
    if (room.status !== 'lobby') {
      const houses = p.lots.reduce((sum, lot) => sum + lot.houses, 0);
      const mortgaged = p.lots.filter((lot) => lot.mortgaged).length;
      const extra = [`${p.lots.length} 块地`, houses ? `${houses} 栋房` : '', mortgaged ? `抵押 ${mortgaged}` : ''].filter(Boolean).join(' · ');
      info.append(el('span', 'admin-sub', `现金 ${yuan(p.cash)} · ${extra}`));
    }
    row.append(info);
    if (!p.bankrupt && room.status !== 'finished') {
      row.append(button('请离开', 'secondary small', () => kick(room.roomCode, p.id, p.nickname, room.status)));
    }
    people.append(row);
  }
  for (const s of room.spectators) {
    const row = el('div', 'seat');
    row.append(el('span', 'admin-sub grow', `${s.nickname} · 观战${s.connected ? '' : ' · 离线'}`));
    row.append(button('请离开', 'secondary small', () => kick(room.roomCode, s.id, s.nickname, 'spectator')));
    people.append(row);
  }
  body.append(people);

  if (room.log.length) {
    const log = el('section', 'admin-people');
    log.append(el('h4', '', '最近记录'));
    const list = el('ol', 'list');
    for (const item of [...room.log].reverse()) {
      const li = el('li');
      li.append(el('span', 'time', clock(item.ts)), el('span', '', item.text));
      list.append(li);
    }
    log.append(list);
    body.append(log);
  }

  const actions = el('div', 'actions');
  const rowBox = el('div', 'row');
  if (room.status === 'playing') rowBox.append(button('结束对局', 'secondary', () => endGame(room.roomCode)));
  rowBox.append(button('删除房间', 'danger', () => removeRoom(room.roomCode)));
  actions.append(rowBox);
  body.append(actions);
}

async function endGame(code) {
  const yes = await confirmBox('结束这局？', `房间 ${code} 会马上结束，按现金加地产造价定第一名。玩家还能看到结果和聊天。`, '结束对局');
  if (!yes) return;
  await run(`rooms/${code}/end`, null, '已结束对局', code);
}

async function kick(code, id, name, status) {
  const text =
    status === 'playing'
      ? `${name} 会被断开，按出局处理，名下的地退给银行。`
      : status === 'spectator'
        ? `${name} 会被断开，不再观战。`
        : `${name} 会被断开并让出座位。`;
  const yes = await confirmBox(`请 ${name} 离开？`, text, '请离开');
  if (!yes) return;
  await run(`rooms/${code}/kick`, { id }, `已请 ${name} 离开`, code);
}

async function removeRoom(code) {
  const yes = await confirmBox(`删除房间 ${code}？`, '房间里的人会被断开，存档、记录和聊天都会清掉，不能恢复。之后再用这个房间号进来，会是一个新的空房间。', '删除');
  if (!yes) return;
  const ok = await run(`rooms/${code}/delete`, null, `房间 ${code} 已删除`, null);
  if (ok && openCode === code) closeDetail();
}

async function run(path, body, done, reopen) {
  try {
    const data = await api(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
    toast(done);
    if (reopen && openCode === reopen && data.room) renderDetail(data.room);
    window.setTimeout(() => loadRooms(), 600);
    return true;
  } catch (err) {
    if (err.message !== 'auth') toast(err.message);
    return false;
  }
}

function confirmBox(title, text, yesLabel) {
  const box = document.getElementById('confirm');
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-text').textContent = text;
  const yes = document.getElementById('confirm-yes');
  const no = document.getElementById('confirm-no');
  yes.textContent = yesLabel;
  box.hidden = false;
  no.focus();
  return new Promise((resolve) => {
    const finish = (value) => {
      box.hidden = true;
      yes.onclick = null;
      no.onclick = null;
      resolve(value);
    };
    yes.onclick = () => finish(true);
    no.onclick = () => finish(false);
  });
}

function fact(label, value) {
  const box = el('div');
  box.append(el('p', '', label), el('b', '', value));
  return box;
}

function parsePlayers(raw) {
  try {
    return JSON.parse(raw) || [];
  } catch {
    return [];
  }
}

function button(label, kind, onClick) {
  const node = el('button', kind, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function ago(ts) {
  const diff = Math.max(0, (serverNow || Date.now()) - ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function when(ts) {
  return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function clock(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function yuan(value) {
  return `¥${Number(value || 0).toLocaleString('zh-CN')}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function readKey() {
  try {
    return sessionStorage.getItem(KEY_STORE) || '';
  } catch {
    return '';
  }
}

function saveKey(value) {
  try {
    if (value) sessionStorage.setItem(KEY_STORE, value);
    else sessionStorage.removeItem(KEY_STORE);
  } catch {
    /* 隐私模式下存不了，刷新后重新输入 */
  }
}

let toastTimer = 0;
function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2800);
}
