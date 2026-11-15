const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const NICK_RE = /^[一-龥A-Za-z0-9_·]{1,8}$/;
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/;
const SVG_NS = 'http://www.w3.org/2000/svg';

const SHAPES = {
  pebble: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16z',
  tile: 'M5 5h14v14H5z',
  gem: 'M12 3l8 9-8 9-8-9z',
  sail: 'M12 4l9 16H3z',
  hive: 'M7.5 4h9l4.5 8-4.5 8h-9L3 12z',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z',
  ring: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z',
  bolt: 'M9 3h6v6h6v6h-6v6H9v-6H3V9h6z',
};
const MARKET_RATE = { limit_up: '现金 +10%', bull: '现金 +20%', limit_down: '现金 −10%', bear: '现金 −20%' };
const RAIL_COLOR = '#8d7b6a';

const home = document.getElementById('home');
const room = document.getElementById('room');
const nickInput = document.getElementById('nick');
const codeInput = document.getElementById('code');
const pwInput = document.getElementById('pw');
const newPwInput = document.getElementById('new-pw');
const homeError = document.getElementById('home-error');
const toastEl = document.getElementById('toast');
const side = document.querySelector('.side');

let ws = null;
let state = null;
let welcomed = false;
let manualClose = false;
let busy = false;
let selected = null;
let sheet = null;
let lastDiceKey = '';
let seenMarket = null;
let marketReady = false;
let marketTimer = 0;
let editingRules = false;
let seenChat = null;
let unread = 0;
let auctionTicker = 0;
let kickedMessage = '';
let session = { roomCode: '', nickname: '', password: '', token: '' };

boot();

function boot() {
  const invite = readInvite();
  const last = readJSON('dafuweng:last');
  if (last?.nickname) nickInput.value = last.nickname;
  if (invite) {
    codeInput.value = invite.room;
    pwInput.value = invite.pw;
    history.replaceState(null, '', location.pathname + location.search);
    if (!nickInput.value) nickInput.focus();
  } else if (last?.roomCode) {
    codeInput.value = last.roomCode;
    pwInput.value = last.password || '';
  }
  if (last?.roomCode) {
    const saved = readJSON(storageKey(last.roomCode, last.nickname));
    if (saved?.token) {
      const resume = document.getElementById('btn-resume');
      document.getElementById('resume-code').textContent = last.roomCode;
      resume.hidden = false;
      resume.addEventListener('click', () => {
        connect(last.roomCode, last.nickname, saved.password || last.password || '', saved.token);
      });
    }
  }
  document.getElementById('btn-create').addEventListener('click', createRoom);
  document.getElementById('btn-join').addEventListener('click', joinRoom);
  document.getElementById('join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (codeInput.value.trim()) joinRoom();
    else createRoom();
  });
  document.getElementById('btn-copy').addEventListener('click', copyInvite);
  document.getElementById('btn-rules').addEventListener('click', () => {
    document.getElementById('rules').hidden = false;
  });
  document.getElementById('btn-leave').addEventListener('click', leave);
  document.getElementById('btn-reconnect').addEventListener('click', () => {
    document.getElementById('disconnected').hidden = true;
    connect(session.roomCode, session.nickname, session.password, session.token);
  });
  document.getElementById('sheet-close').addEventListener('click', closeSheet);
  document.getElementById('sheet').addEventListener('click', (event) => {
    if (event.target.id === 'sheet') closeSheet();
  });
  document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => {
      button.closest('.overlay').hidden = true;
    });
  });
  document.getElementById('rules').addEventListener('click', (event) => {
    if (event.target.id === 'rules') event.currentTarget.hidden = true;
  });
  document.getElementById('market').addEventListener('click', (event) => {
    if (event.target.id === 'market' || event.target.closest('[data-dismiss]')) document.getElementById('market').hidden = true;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeSheet();
      document.getElementById('rules').hidden = true;
      document.getElementById('market').hidden = true;
    }
  });
  const boardWrap = document.querySelector('.board-wrap');
  if (boardWrap && 'ResizeObserver' in window) new ResizeObserver(() => layoutPieces(false)).observe(boardWrap);
  window.addEventListener('resize', () => layoutPieces(false));
  document.querySelectorAll('.tabs button').forEach((button) => {
    button.addEventListener('click', () => setTab(button.dataset.tab));
  });
  document.querySelectorAll('.seg button[data-feed]').forEach((button) => {
    button.addEventListener('click', () => setFeed(button.dataset.feed));
  });
  document.getElementById('chat-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    send({ type: 'chat', text }, true);
    input.value = '';
  });
}

function readInvite() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const code = (params.get('room') || '').toUpperCase();
  if (!CODE_RE.test(code)) return null;
  return { room: code, pw: (params.get('pw') || '').slice(0, 16) };
}

function setTab(tab) {
  side.dataset.tab = tab;
  document.querySelectorAll('.tabs button').forEach((item) => item.setAttribute('aria-selected', String(item.dataset.tab === tab)));
  if (tab === 'log' || tab === 'chat') setFeed(tab);
}

function setFeed(feed) {
  side.dataset.feed = feed;
  document.querySelectorAll('.seg button[data-feed]').forEach((item) => item.setAttribute('aria-selected', String(item.dataset.feed === feed)));
  if (feed === 'chat') {
    unread = 0;
    paintUnread();
    const list = document.getElementById('chat');
    list.scrollTop = list.scrollHeight;
  } else {
    const list = document.getElementById('log');
    list.scrollTop = list.scrollHeight;
  }
}

function createRoom() {
  const nickname = cleanNick(nickInput.value);
  if (!nickname) return showHomeError('昵称请用 1 到 8 位中文、字母或数字');
  const password = newPwInput.value.trim().slice(0, 16);
  if (!password) {
    newPwInput.focus();
    return showHomeError('创建房间要设一个密码');
  }
  const code = makeCode();
  connect(code, nickname, password, '');
}

function joinRoom() {
  const nickname = cleanNick(nickInput.value);
  const code = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  codeInput.value = code;
  if (!nickname) return showHomeError('昵称请用 1 到 8 位中文、字母或数字');
  if (!CODE_RE.test(code)) return showHomeError('房间号是 5 位，请避开 0、O、1、I、L');
  const saved = readJSON(storageKey(code, nickname));
  connect(code, nickname, pwInput.value.trim().slice(0, 16), saved?.token || '');
}

function connect(roomCode, nickname, password, token) {
  manualClose = false;
  welcomed = false;
  session = { roomCode, nickname, password, token: token || '' };
  showHomeError('');
  setBusy(true);
  if (ws) {
    ws.onclose = null;
    try { ws.close(); } catch { /* ignore */ }
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/api/ws?room=${encodeURIComponent(roomCode)}`);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'join', nickname, password, token: token || undefined }));
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'welcome') {
      welcomed = true;
      session.token = msg.token;
      session.nickname = msg.nickname;
      session.roomCode = msg.roomCode;
      writeJSON(storageKey(msg.roomCode, msg.nickname), { token: msg.token, password: session.password });
      writeJSON('dafuweng:last', { roomCode: msg.roomCode, nickname: msg.nickname, password: session.password });
      document.getElementById('disconnected').hidden = true;
      setBusy(false);
    } else if (msg.type === 'state') {
      busy = false;
      render(msg.state);
    } else if (msg.type === 'error') {
      busy = false;
      if (!welcomed) showHomeError(msg.message);
      else toast(msg.message);
    } else if (msg.type === 'kicked') {
      kickedMessage = msg.message;
    }
  });
  ws.addEventListener('close', (event) => {
    setBusy(false);
    busy = false;
    if (event.code === 4001 || event.code === 4003) {
      if (event.code === 4001) {
        try {
          localStorage.removeItem(storageKey(session.roomCode, session.nickname));
          localStorage.removeItem('dafuweng:last');
        } catch {
          /* 存不了也没关系 */
        }
        document.getElementById('btn-resume').hidden = true;
      }
      leave();
      showHomeError(kickedMessage || (event.code === 4001 ? '房间已被删除' : '你被移出了房间'));
      kickedMessage = '';
      return;
    }
    if (manualClose) return;
    if (!welcomed) {
      showHomeError(homeError.textContent || '没能进入房间');
      return;
    }
    document.getElementById('disconnected').hidden = false;
  });
  ws.addEventListener('error', () => {
    if (!welcomed) showHomeError('连接失败');
  });
}

function leave() {
  manualClose = true;
  if (ws) ws.close();
  state = null;
  room.hidden = true;
  home.hidden = false;
  document.body.classList.remove('in-lobby');
  document.getElementById('disconnected').hidden = true;
  document.title = '大富翁';
}

function send(payload, allowBusy) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    toast('连接已断开');
    return;
  }
  if (busy && !allowBusy) return;
  if (!allowBusy) busy = true;
  ws.send(JSON.stringify(payload));
}

function render(next) {
  state = next;
  const entered = room.hidden;
  home.hidden = true;
  room.hidden = false;
  if (entered) window.scrollTo(0, 0);
  document.title = `房间 ${next.roomCode} · 大富翁`;
  document.getElementById('room-label').textContent = next.roomCode;
  document.body.classList.toggle('in-lobby', next.status === 'lobby');
  renderTurn(next);
  const lobby = document.getElementById('lobby');
  const play = document.getElementById('play');
  if (next.status === 'lobby') {
    lobby.hidden = false;
    play.hidden = true;
    renderLobby(next);
    clearPieces();
  } else {
    lobby.hidden = true;
    play.hidden = false;
    renderBoard(next);
    renderInspect(next);
    syncPieces(next);
  }
  renderPeople(next);
  renderLog(next);
  renderChat(next);
  renderActions(next);
  renderMarket(next);
  renderJail(next);
  renderLiquidate(next);
  syncAuctionTicker(next);
  if (sheet) renderSheet();
}

function renderTurn(next) {
  const chip = document.getElementById('turn-chip');
  chip.replaceChildren();
  if (next.status === 'lobby') {
    chip.append(document.createTextNode(`${next.players.length} 人在房间`));
    return;
  }
  if (next.status === 'finished') {
    const winner = next.players.find((p) => p.id === next.winnerId);
    chip.append(document.createTextNode(winner ? `${winner.nickname} 获胜` : '对局结束'));
    return;
  }
  const current = next.players.find((p) => p.id === next.currentPlayerId);
  chip.append(el('span', 'pulse'));
  chip.append(document.createTextNode(next.yourTurn ? '轮到你' : current ? `${current.nickname}的回合` : '对局中'));
}

/* ---------- 大厅 ---------- */

function renderLobby(next) {
  const lobby = document.getElementById('lobby');
  if (lobby.contains(document.activeElement) && lobby.dataset.hold === '1') return;
  lobby.replaceChildren();
  const me = next.players.find((p) => p.id === next.you);

  const title = el('div', 'title-row');
  title.append(el('h2', '', '等待开局'));
  title.append(el('span', '', `${next.players.length} / ${next.rules.maxPlayers} 人`));
  lobby.append(title);

  const invite = el('section', 'card');
  invite.setAttribute('aria-label', '邀请朋友');
  const grid = el('div', 'invite-grid');
  const codeBox = el('div');
  codeBox.append(el('p', '', '房间号'), el('b', '', next.roomCode));
  const pwBox = el('div');
  pwBox.append(el('p', '', '密码'), el('b', '', session.password || (next.hasPassword ? '问房主' : '没有设')));
  grid.append(codeBox, pwBox);
  invite.append(grid);
  const copy = el('button', 'copy-link');
  copy.type = 'button';
  copy.append(icon('link', 18), document.createTextNode('复制邀请链接'));
  copy.addEventListener('click', copyInvite);
  invite.append(copy);
  invite.append(el('p', 'note', '链接里带着房间号和密码。朋友打开后填个昵称，点「加入房间」就行。'));
  lobby.append(invite);

  const seats = el('section', 'card');
  const head = el('div', 'card-head');
  head.append(el('h2', '', '玩家'), el('span', '', `${next.players.length} / ${next.rules.maxPlayers}`));
  seats.append(head);
  for (const player of next.players) {
    const row = el('div', 'seat');
    row.append(token(player, false));
    row.append(el('b', '', player.nickname));
    row.append(el('span', 'shape', avatarLabel(next, player.avatar)));
    if (player.isHost) row.append(el('span', 'badge host', '房主'));
    if (player.id === next.you) row.append(el('span', 'badge you', '你'));
    const online = el('span', player.connected ? 'online' : 'online no');
    online.append(el('i'), document.createTextNode(player.connected ? '在线' : '离线'));
    row.append(online);
    seats.append(row);
  }
  const left = next.rules.maxPlayers - next.players.length;
  if (left > 0) seats.append(el('div', 'empty-seat', `还能再进 ${left} 人`));
  if (next.spectators.length) seats.append(el('p', 'watchers', `观战：${next.spectators.map((s) => s.nickname).join('、')}`));
  lobby.append(seats);

  if (me && next.youRole === 'player') lobby.append(appearancePicker(next, me));
  lobby.append(rulesCard(next, me));

  const bar = el('div', 'start-bar');
  if (next.youRole === 'spectator') {
    bar.append(el('p', '', '座位已满，你先观战。'));
  } else if (me?.isHost) {
    const button = el('button', 'primary', '开始游戏');
    button.type = 'button';
    const min = next.meta?.minPlayers || 2;
    button.disabled = next.players.length < min;
    button.addEventListener('click', () => send({ type: 'start' }));
    bar.append(button);
    bar.append(el('p', '', button.disabled ? `还差至少 ${min - next.players.length} 人` : '开始后，新进来的人只能观战'));
  } else {
    const host = next.players.find((p) => p.isHost);
    bar.append(el('p', '', host?.connected ? '等房主点开始。' : '房主离线了，等 ta 回来点开始。'));
  }
  lobby.append(bar);
}

function avatarLabel(next, id) {
  return next.meta?.avatars?.find((item) => item.id === id)?.label || '棋子';
}

function appearancePicker(next, me) {
  const box = el('section', 'card');
  const head = el('div', 'card-head');
  head.append(el('h2', '', '我的棋子'));
  box.append(head);
  const colors = el('div', 'swatches');
  colors.setAttribute('role', 'radiogroup');
  colors.setAttribute('aria-label', '颜色');
  for (const color of next.meta?.colors || []) {
    const taken = next.players.some((p) => p.id !== me.id && p.color === color.hex);
    const button = el('button', taken ? 'swatch taken' : 'swatch');
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(me.color === color.hex));
    button.setAttribute('aria-label', taken ? `${color.label}，已被选` : color.label);
    button.style.background = color.hex;
    button.disabled = taken;
    if (taken) button.append(icon('x', 14, '#fff'));
    button.addEventListener('click', () => send({ type: 'appearance', color: color.hex, avatar: me.avatar }));
    colors.append(button);
  }
  box.append(colors);
  const shapes = el('div', 'shapes');
  shapes.setAttribute('role', 'radiogroup');
  shapes.setAttribute('aria-label', '形状');
  for (const avatar of next.meta?.avatars || []) {
    const button = el('button', 'shape-btn');
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(me.avatar === avatar.id));
    button.setAttribute('aria-label', avatar.label);
    button.append(shapeIcon(avatar.id));
    button.addEventListener('click', () => send({ type: 'appearance', color: me.color, avatar: avatar.id }));
    shapes.append(button);
  }
  box.append(shapes);
  return box;
}

function rulesCard(next, me) {
  const box = el('section', 'card');
  const rules = next.rules;
  const summary = `起步 ${yuan(rules.startingMoney)} · 起点 ${yuan(rules.goSalary)} · ${rules.auction ? '不买就拍卖' : '不拍卖'} · 最多 ${rules.maxPlayers} 人`;
  if (!me?.isHost || !editingRules) {
    const row = el('div', 'rules-row');
    const text = el('div', 'text');
    text.append(el('b', '', '房间规则'), el('span', '', summary));
    row.append(text);
    if (me?.isHost) {
      const edit = el('button', 'secondary', '修改');
      edit.type = 'button';
      edit.addEventListener('click', () => {
        editingRules = true;
        renderLobby(state);
      });
      row.append(edit);
    }
    box.append(row);
    return box;
  }
  const form = el('form', 'rule-form');
  const grid = el('div', 'rule-grid');
  grid.append(numberField('起步资金', 'startingMoney', rules.startingMoney, 500, 5000));
  grid.append(numberField('起点薪水', 'goSalary', rules.goSalary, 0, 1000));
  grid.append(numberField('人数上限', 'maxPlayers', rules.maxPlayers, next.meta?.minPlayers || 2, 6));
  form.append(grid);
  form.append(checkField('不买就进入拍卖', 'auction', rules.auction));
  const row = el('div', 'actions');
  const buttons = el('div', 'row');
  const cancel = el('button', 'secondary', '取消');
  cancel.type = 'button';
  cancel.addEventListener('click', () => {
    editingRules = false;
    lobbyHold(false);
    renderLobby(state);
  });
  const save = el('button', 'primary', '保存');
  save.type = 'submit';
  buttons.append(cancel, save);
  row.append(buttons);
  form.append(row);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const nextRules = { ...rules };
    for (const input of form.querySelectorAll('input')) {
      if (input.type === 'number') nextRules[input.name] = Number(input.value);
      if (input.type === 'checkbox') nextRules[input.name] = input.checked;
    }
    editingRules = false;
    lobbyHold(false);
    send({ type: 'settings', rules: nextRules, password: null });
  });
  form.addEventListener('focusin', () => lobbyHold(true));
  form.addEventListener('focusout', () => lobbyHold(false));
  box.append(form);
  return box;
}

function lobbyHold(on) {
  document.getElementById('lobby').dataset.hold = on ? '1' : '0';
}

function numberField(label, name, value, min, max) {
  const field = el('label', '', label);
  const input = document.createElement('input');
  input.type = 'number';
  input.name = name;
  input.min = String(min);
  input.max = String(max);
  input.step = '1';
  input.value = String(value);
  field.append(input);
  return field;
}

function checkField(label, name, checked) {
  const field = el('label', 'check');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.name = name;
  input.checked = checked;
  field.append(input, document.createTextNode(label));
  return field;
}

/* ---------- 弹窗：监狱、卖地、行情 ---------- */

function renderJail(next) {
  const box = document.getElementById('jail');
  const show = next.status === 'playing' && next.phase === 'await_jail' && next.bail;
  box.hidden = !show;
  if (!show) return;
  const body = document.getElementById('jail-body');
  body.replaceChildren();
  const amount = el('div');
  amount.append(el('p', 'label-sm', '保释金'), el('p', 'big-money', yuan(next.bail.amount)));
  body.append(amount);
  const who = next.players.find((p) => p.id === next.currentPlayerId);
  if (!next.yourTurn) {
    body.append(el('p', 'act-text', `${who?.nickname || '当前玩家'} 正在选择：交保释金照常走，或者跳过下一回合。`));
    return;
  }
  const me = who;
  const pay = choiceButton(`交保释金 ${yuan(next.bail.amount)}`, '下一回合照常走，地照常收租', true);
  pay.disabled = (me?.cash ?? 0) < next.bail.amount;
  pay.addEventListener('click', () => send({ type: 'payJail' }));
  const skip = choiceButton('跳过下一回合', '不花钱，但跳过之前别人停在你的地上不用交租', false);
  skip.addEventListener('click', () => send({ type: 'skipJail' }));
  body.append(pay, skip);
  if (pay.disabled) body.append(el('p', 'act-text', '现金不够交保释金，可以先在「抵押」里换点现金。'));
  const mortgage = el('button', 'secondary', '抵押');
  mortgage.type = 'button';
  mortgage.addEventListener('click', () => openSheet('mortgage'));
  body.append(mortgage);
}

function choiceButton(title, detail, primary) {
  const button = el('button', primary ? 'primary choice' : 'secondary choice');
  button.type = 'button';
  button.append(el('b', '', title), el('span', '', detail));
  return button;
}

function renderLiquidate(next) {
  const box = document.getElementById('liquidate');
  const show = next.status === 'playing' && next.phase === 'await_debt' && next.debt;
  box.hidden = !show;
  if (!show) return;
  const body = document.getElementById('liquidate-body');
  body.replaceChildren();
  const who = next.players.find((p) => p.id === next.currentPlayerId);
  const cash = who?.cash || 0;
  const amount = next.debt.amount || 0;
  const shortfall = Math.max(0, amount - cash);
  const top = el('div', 'actions');
  top.append(el('p', 'debt-line', `${next.yourTurn ? '你' : who?.nickname || '当前玩家'}要付 ${yuan(amount)}，现金只有 ${yuan(cash)}`));
  top.append(el('p', 'debt-big', `还差 ${yuan(shortfall)}`));
  const bar = el('div', 'progress');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', '已凑到的钱');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', String(amount));
  bar.setAttribute('aria-valuenow', String(Math.min(cash, amount)));
  const fill = el('i');
  fill.style.width = `${amount ? Math.max(4, Math.min(100, (cash / amount) * 100)) : 0}%`;
  bar.append(fill);
  top.append(bar);
  body.append(top);
  const owned = next.squares.filter((sq) => sq.ownerId === who?.id && sq.price != null);
  if (!owned.length) {
    body.append(el('p', 'sheet-note', '已经没有地可以卖。'));
    return;
  }
  const list = el('div', 'sheet-list');
  for (const sq of owned) {
    const row = el('div', 'sell-row');
    const band = el('i');
    band.style.setProperty('--c', sq.color || RAIL_COLOR);
    row.append(band);
    const text = el('div', 'text');
    text.append(el('b', '', sq.name), el('span', '', saleDetail(sq)));
    row.append(text);
    row.append(el('span', 'get', yuan(sq.bankSale ?? 0)));
    if (next.yourTurn) {
      const button = el('button', '', '卖');
      button.type = 'button';
      button.setAttribute('aria-label', `卖掉${sq.name}，到手 ${yuan(sq.bankSale ?? 0)}`);
      button.addEventListener('click', () => send({ type: 'liquidate', square: sq.index }));
      row.append(button);
    }
    list.append(row);
  }
  body.append(list);
  body.append(el('p', 'sheet-note', '地价加上房子的造价，一起按八折卖给银行，房子跟着地一起卖掉。抵押中的地再扣掉没还的抵押款。卖完还不够就再选一块。'));
}

function saleDetail(sq) {
  const built = sq.type === 'property' && sq.houses > 0 ? `(${yuan(sq.price)} + ${yuan((sq.houseCost || 0) * sq.houses)}) 八折` : `${yuan(sq.price)} 八折`;
  const houses = sq.type === 'property' ? (sq.houses > 0 ? `${sq.houses} 栋房` : '空地') : '铁路';
  if (sq.mortgaged) return `抵押中 · ${built}，再扣未还 ${yuan(sq.mortgage || 0)}`;
  return `${houses} · ${built}`;
}

function renderMarket(next) {
  const box = document.getElementById('market');
  const event = next.market;
  const n = event?.n ?? 0;
  if (!marketReady) {
    seenMarket = n;
    marketReady = true;
    return;
  }
  if (!event || n === seenMarket) return;
  seenMarket = n;
  const up = event.delta >= 0;
  box.replaceChildren();
  const card = el('div', up ? 'market-card up' : 'market-card down');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', `${event.title}，${MARKET_RATE[event.code] || ''}`);
  const who = next.players.find((p) => p.id === event.playerId);
  const place = next.squares[event.square]?.name || '交易所';
  card.append(el('p', 'code', `${place} · 行情`));
  card.append(el('h3', '', event.title));
  const candles = el('div', 'candles');
  candles.setAttribute('aria-hidden', 'true');
  const pattern = up ? [['g', 22], ['r', 34], ['r', 44], ['g', 30], ['r', 66]] : [['r', 62], ['g', 44], ['r', 34], ['g', 52], ['g', 22]];
  for (const [kind, height] of pattern) {
    const candle = el('span', kind);
    const body = el('i');
    body.style.height = `${height}px`;
    candle.append(body);
    candles.append(candle);
  }
  card.append(candles);
  const sign = event.delta > 0 ? '+' : event.delta < 0 ? '−' : '';
  card.append(el('p', 'delta', `${sign}${yuan(Math.abs(event.delta))}`));
  card.append(el('p', 'rate', MARKET_RATE[event.code] || ''));
  if (who) card.append(el('p', 'who', `${who.nickname} 现金 ${yuan(who.cash - event.delta)} → ${yuan(who.cash)}`));
  const ok = el('button', 'outline', '知道了');
  ok.type = 'button';
  ok.dataset.dismiss = '1';
  card.append(ok);
  box.append(card);
  box.hidden = false;
  window.clearTimeout(marketTimer);
  marketTimer = window.setTimeout(() => {
    box.hidden = true;
  }, 5000);
}

/* ---------- 棋盘 ---------- */

function renderBoard(next) {
  const board = document.getElementById('board');
  if (!board.querySelector('.board-center')) {
    const center = el('div', 'board-center');
    const titles = el('div');
    titles.append(el('p', 'eyebrow', '中国城市 · 联机对战'), el('p', 'title', '大富翁'));
    center.append(titles);
    const row = el('div', 'center-row');
    const dice = el('div');
    dice.id = 'dice';
    row.append(dice);
    const deed = el('div');
    deed.id = 'deed-center';
    row.append(deed);
    center.append(row);
    const note = el('p', 'center-note');
    note.id = 'center-note';
    center.append(note);
    const winner = el('p', 'winner-banner');
    winner.id = 'winner-banner';
    winner.hidden = true;
    center.append(winner);
    board.append(center);
  }
  const focus = focusIndex(next);
  for (const sq of next.squares) {
    let cell = board.querySelector(`[data-index="${sq.index}"]`);
    if (!cell) {
      cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell';
      cell.dataset.index = String(sq.index);
      const pos = placement(sq.index);
      cell.style.gridColumn = String(pos.col);
      cell.style.gridRow = String(pos.row);
      cell.dataset.side = pos.side;
      cell.addEventListener('click', () => {
        selected = selected === sq.index ? null : sq.index;
        renderBoard(state);
        renderInspect(state);
      });
      board.append(cell);
    }
    paintCell(cell, sq, next, focus);
  }
  paintDice(next.lastDice);
  const note = document.getElementById('center-note');
  note.textContent = centerNote(next);
  const banner = document.getElementById('winner-banner');
  const winner = next.players.find((p) => p.id === next.winnerId);
  banner.hidden = next.status !== 'finished';
  banner.textContent = winner ? `${winner.nickname} 赢了` : '';
}

function centerNote(next) {
  if (next.status === 'finished') return '';
  const current = next.players.find((p) => p.id === next.currentPlayerId);
  if (!current) return '';
  const name = next.yourTurn ? '你' : current.nickname;
  if (next.phase === 'await_roll') return `轮到${name}掷骰`;
  if (next.phase === 'await_auction' && next.auction) {
    const sq = next.squares[next.auction.square];
    return `正在拍卖「${sq?.name || ''}」`;
  }
  const here = next.squares[current.position];
  if (next.lastDice && here) return `${name}${next.yourTurn ? '' : ' '}掷出 ${next.lastDice} 点，停在${here.name}`;
  return `${name}的回合`;
}

function focusIndex(next) {
  if (selected != null) return selected;
  if (next.status !== 'playing') return null;
  if (next.phase === 'await_auction' && next.auction) return next.auction.square;
  if (next.pendingBuy != null) return next.pendingBuy;
  const current = next.players.find((p) => p.id === next.currentPlayerId);
  if (current && next.phase !== 'await_roll') return current.position;
  return null;
}

function paintCell(cell, sq, next, focus) {
  const owner = next.players.find((p) => p.id === sq.ownerId);
  cell.classList.toggle('owned', Boolean(owner));
  cell.classList.toggle('mortgaged', sq.mortgaged);
  cell.classList.toggle('selected', focus === sq.index);
  cell.dataset.kind = sq.type;
  const steps = owner && sq.type === 'railroad' ? 5 : owner && sq.type === 'property' ? Math.min(5, (sq.houses || 0) + 1) : 0;
  cell.style.setProperty('--owner', owner?.color || 'transparent');
  cell.style.setProperty('--fill', steps ? `${steps * 20}%` : '0%');
  cell.style.setProperty('--group', sq.color || RAIL_COLOR);
  const toll = shownToll(sq, next);
  const label = [sq.name];
  if (owner) label.push(`${owner.nickname}的`);
  if (sq.mortgaged) label.push('抵押中');
  else if (toll != null) label.push(`过路费 ${yuan(toll)}`);
  else if (!owner && sq.price) label.push(`无主，售价 ${yuan(sq.price)}`);
  cell.setAttribute('aria-label', label.join('，'));
  cell.replaceChildren();
  if (steps) cell.append(el('span', 'fill'));
  if ((sq.type === 'property' && owner) || sq.type === 'railroad') cell.append(el('span', 'band'));
  if (sq.type === 'go' || sq.type === 'jail' || sq.type === 'exchange') {
    const corner = el('span', 'corner');
    corner.append(cornerIcon(sq.type));
    corner.append(el('span', 'nm', sq.short || sq.name));
    const cap = sq.type === 'go' ? `经过领 ${yuan(next.rules.goSalary)}` : sq.type === 'jail' ? '保释或停走' : '抽一次行情';
    corner.append(el('span', 'cap', cap));
    cell.append(corner);
    return;
  }
  const plate = el('span', 'plate');
  plate.append(el('span', 'nm', sq.short || sq.name));
  let sub = '';
  if (sq.mortgaged) sub = '抵押';
  else if (toll != null) sub = yuan(toll);
  else if (!owner && sq.price) sub = yuan(sq.price);
  if (sub) plate.append(el('span', 'sub', sub));
  cell.append(plate);
}

function shownToll(sq, next) {
  if (!sq.ownerId || sq.mortgaged || !sq.rentTable) return null;
  if (sq.type === 'property') return sq.rentTable[Math.max(0, Math.min(4, sq.houses || 0))];
  if (sq.type === 'railroad') {
    const count = next.squares.filter((item) => item.type === 'railroad' && item.ownerId === sq.ownerId).length;
    return sq.rentTable[Math.max(0, Math.min(sq.rentTable.length - 1, count - 1))];
  }
  return null;
}

function paintDice(dice) {
  const row = document.getElementById('dice');
  if (!row) return;
  const key = dice ? String(dice) : '';
  const rolling = Boolean(key && key !== lastDiceKey);
  lastDiceKey = key;
  row.replaceChildren();
  const die = el('div', rolling ? 'die rolling' : 'die');
  die.setAttribute('role', 'img');
  die.setAttribute('aria-label', dice ? `骰子 ${dice} 点` : '还没掷骰');
  if (dice) die.dataset.pips = String(dice);
  for (let i = 0; i < 9; i += 1) die.append(document.createElement('i'));
  row.append(die);
}

function renderInspect(next) {
  const center = document.getElementById('deed-center');
  const sideBox = document.getElementById('deed-side');
  if (center) center.replaceChildren();
  sideBox.replaceChildren();
  if (next.status === 'lobby') return;
  const index = focusIndex(next);
  const sq = index == null ? null : next.squares[index];
  if (!sq) return;
  if (center) center.append(deedCard(next, sq));
  sideBox.append(miniDeed(next, sq));
}

function deedCard(next, sq) {
  const owner = next.players.find((p) => p.id === sq.ownerId);
  const card = el('div', 'deed');
  card.style.setProperty('--group', sq.color || (sq.type === 'railroad' ? RAIL_COLOR : '#6b5f52'));
  const head = el('div', 'deed-head');
  const kind = sq.type === 'property' ? sq.groupName || '地产' : sq.type === 'railroad' ? '铁路' : '角落';
  const status = owner ? `${owner.nickname}的${sq.mortgaged ? ' · 抵押中' : ''}` : sq.price ? '无人拥有' : '';
  head.append(el('p', '', [kind, status].filter(Boolean).join(' · ')));
  head.append(el('h4', '', sq.name));
  card.append(head);
  const body = el('div', 'deed-body');
  if (sq.type === 'property' && sq.rentTable) {
    const names = ['空地', '一栋', '二栋', '三栋', '四栋'];
    sq.rentTable.forEach((rent, i) => {
      const row = el('div', owner && !sq.mortgaged && (sq.houses || 0) === i ? 'on' : '');
      row.append(el('span', '', names[i] || `${i} 栋`), el('span', '', yuan(rent)));
      body.append(row);
    });
    const foot = el('div', 'foot');
    foot.append(el('span', '', `售价 ${yuan(sq.price)}`), el('span', '', `每栋 ${yuan(sq.houseCost)}`));
    body.append(foot);
  } else if (sq.type === 'railroad' && sq.rentTable) {
    const count = owner ? next.squares.filter((item) => item.type === 'railroad' && item.ownerId === owner.id).length : 0;
    sq.rentTable.forEach((rent, i) => {
      const row = el('div', owner && !sq.mortgaged && count === i + 1 ? 'on' : '');
      row.append(el('span', '', `${i + 1} 条`), el('span', '', yuan(rent)));
      body.append(row);
    });
    const foot = el('div', 'foot');
    foot.append(el('span', '', `售价 ${yuan(sq.price)}`), el('span', '', '不能建房'));
    body.append(foot);
  } else {
    body.append(el('span', 'text', sq.hint));
  }
  card.append(body);
  return card;
}

function miniDeed(next, sq) {
  const owner = next.players.find((p) => p.id === sq.ownerId);
  const card = el('div', 'mini-deed');
  const band = el('i');
  band.style.background = sq.color || (sq.type === 'railroad' ? RAIL_COLOR : '#6b5f52');
  card.append(band);
  const body = el('div', 'body');
  const top = el('div', 'top');
  top.append(el('b', '', sq.name));
  const kind = sq.type === 'property' ? sq.groupName || '地产' : sq.type === 'railroad' ? '铁路' : '';
  const status = owner ? `${owner.nickname}的${sq.mortgaged ? ' · 抵押中' : ''}` : sq.price ? '无人拥有' : '';
  top.append(el('span', '', [kind, status].filter(Boolean).join(' · ')));
  body.append(top);
  let line = sq.hint;
  if (sq.type === 'property' && sq.rentTable) {
    const toll = shownToll(sq, next);
    line = toll != null ? `现在过路费 ${yuan(toll)} · ${sq.houses || 0} 栋房 · 四栋 ${yuan(sq.rentTable[4])}` : `过路费 ${yuan(sq.rentTable[0])} 起，四栋 ${yuan(sq.rentTable[4])} · 每栋 ${yuan(sq.houseCost)}`;
  } else if (sq.type === 'railroad' && sq.rentTable) {
    const toll = shownToll(sq, next);
    line = toll != null ? `现在过路费 ${yuan(toll)} · 不能建房` : `过路费 ${sq.rentTable.map((n) => yuan(n)).join(' / ')}（1–4 条）`;
  }
  body.append(el('p', '', line));
  card.append(body);
  return card;
}

/* ---------- 棋子 ---------- */

const pieceAt = new Map();
const pieceGoal = new Map();
const pieceWalk = new Map();
let pieceState = null;

function clearPieces() {
  pieceAt.clear();
  pieceGoal.clear();
  pieceWalk.clear();
  pieceState = null;
  const layer = document.getElementById('token-layer');
  if (layer) layer.replaceChildren();
}

function syncPieces(next) {
  pieceState = next;
  const layer = document.getElementById('token-layer');
  if (!layer) return;
  const live = new Set(next.players.filter((p) => !p.bankrupt).map((p) => p.id));
  for (const id of [...pieceAt.keys()]) {
    if (!live.has(id)) {
      pieceAt.delete(id);
      pieceGoal.delete(id);
      layer.querySelector(`[data-player="${CSS.escape(id)}"]`)?.remove();
    }
  }
  for (const player of next.players) {
    if (player.bankrupt) continue;
    let piece = layer.querySelector(`[data-player="${CSS.escape(player.id)}"]`);
    if (!piece) {
      piece = el('span', 'piece');
      piece.dataset.player = player.id;
      layer.append(piece);
    }
    piece.textContent = player.nickname.slice(0, 1);
    piece.title = player.inJail ? `${player.nickname} · 停走` : player.nickname;
    piece.style.setProperty('--piece', player.color);
    piece.classList.toggle('turn', player.id === next.currentPlayerId && next.status === 'playing');
    piece.classList.toggle('off', !player.connected);
    const goal = player.position;
    if (!pieceAt.has(player.id)) {
      pieceAt.set(player.id, goal);
      pieceGoal.set(player.id, goal);
      continue;
    }
    if (pieceGoal.get(player.id) !== goal) {
      pieceGoal.set(player.id, goal);
      enqueueWalk(player.id);
    }
  }
  layoutPieces(pieceWalk.size > 0);
}

function enqueueWalk(id) {
  if (pieceWalk.has(id)) return;
  const run = async () => {
    while (pieceAt.get(id) !== pieceGoal.get(id)) {
      const from = pieceAt.get(id);
      const to = pieceGoal.get(id);
      const steps = (to - from + 40) % 40;
      if (from == null || steps === 0 || steps > 6) {
        pieceAt.set(id, to);
        layoutPieces(false);
        break;
      }
      for (let i = 1; i <= steps; i += 1) {
        if (pieceGoal.get(id) !== to) break;
        pieceAt.set(id, (from + i) % 40);
        layoutPieces(true);
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }
    pieceWalk.delete(id);
    if (pieceAt.get(id) !== pieceGoal.get(id)) enqueueWalk(id);
  };
  pieceWalk.set(id, run());
}

/** 棋子摆在格子靠外的一侧，不挡住地名。 */
function layoutPieces(animate) {
  const wrap = document.querySelector('.board-wrap');
  const layer = document.getElementById('token-layer');
  if (!wrap || !layer || !pieceState) return;
  const groups = new Map();
  for (const [id, index] of pieceAt) {
    if (!groups.has(index)) groups.set(index, []);
    groups.get(index).push(id);
  }
  const wrapRect = wrap.getBoundingClientRect();
  const current = pieceState.currentPlayerId;
  for (const [index, ids] of groups) {
    const cell = document.querySelector(`.cell[data-index="${index}"]`);
    if (!cell) continue;
    ids.sort((a, b) => (a === current ? -1 : b === current ? 1 : a < b ? -1 : 1));
    const rect = cell.getBoundingClientRect();
    const side = placement(index).side;
    const corner = index % 10 === 0;
    const vertical = !corner && (side === 'left' || side === 'right');
    const size = Math.min(rect.width, rect.height);
    const gap = Math.max(10, Math.min(size * 0.42, 26));
    const span = (ids.length - 1) * gap;
    let cx = rect.left - wrapRect.left + rect.width / 2;
    let cy = rect.top - wrapRect.top + rect.height / 2;
    const inset = size < 40 ? 3 : 12;
    if (!corner) {
      if (side === 'bottom') cy = rect.bottom - wrapRect.top - inset;
      if (side === 'top') cy = rect.top - wrapRect.top + inset;
      if (side === 'left') cx = rect.left - wrapRect.left + inset;
      if (side === 'right') cx = rect.right - wrapRect.left - inset;
    } else {
      cy = rect.bottom - wrapRect.top - inset;
    }
    ids.forEach((id, i) => {
      const piece = layer.querySelector(`[data-player="${CSS.escape(id)}"]`);
      if (!piece) return;
      const offset = i * gap - span / 2;
      piece.dataset.index = String(index);
      piece.style.transition = animate ? 'left 120ms linear, top 120ms linear' : 'none';
      piece.style.left = `${cx + (vertical ? 0 : offset)}px`;
      piece.style.top = `${cy + (vertical ? offset : 0)}px`;
    });
  }
}

/* ---------- 玩家、记录、聊天 ---------- */

function renderPeople(next) {
  const box = document.getElementById('people');
  box.replaceChildren();
  document.getElementById('people-meta').textContent = `${next.players.length} 人 · 起步 ${yuan(next.rules.startingMoney)}`;
  const playing = next.status !== 'lobby';
  for (const player of next.players) {
    const now = playing && next.status === 'playing' && player.id === next.currentPlayerId;
    const row = el('div', now ? 'who turn' : 'who');
    row.append(token(player, now));
    const info = el('div', 'info');
    const name = el('div', 'name');
    name.append(document.createTextNode(player.nickname));
    if (player.id === next.you) name.append(el('span', 'badge you', '你'));
    if (player.isHost) name.append(el('span', 'badge host', '房主'));
    if (now) name.append(el('span', 'badge now', '回合中'));
    if (player.bankrupt) name.append(el('span', 'badge', '破产'));
    if (player.inJail) name.append(el('span', 'badge', '停走一回合'));
    if (!player.connected) name.append(el('span', 'badge off', playing ? '离线 · 托管' : '离线'));
    info.append(name);
    const owned = next.squares.filter((sq) => sq.ownerId === player.id);
    if (owned.length) {
      const lots = el('div', 'lots');
      lots.setAttribute('aria-label', `名下 ${owned.length} 块地：${owned.map((sq) => sq.name).join('、')}`);
      for (const sq of owned) {
        const chip = el('i', sq.mortgaged ? 'm' : '');
        chip.style.setProperty('--c', sq.color || RAIL_COLOR);
        chip.title = `${sq.name}${sq.mortgaged ? '（抵押）' : sq.type === 'property' && sq.houses ? `（${sq.houses} 栋）` : ''}`;
        lots.append(chip);
      }
      info.append(lots);
    }
    row.append(info);
    if (playing) row.append(el('span', 'cash', yuan(player.cash)));
    box.append(row);
  }
  if (next.spectators.length) {
    box.append(el('p', 'watchers', `观战：${next.spectators.map((s) => `${s.nickname}${s.connected ? '' : '（离线）'}`).join('、')}`));
  }
}

function token(player, turn) {
  const node = el('span', `token${turn ? ' turn' : ''}${player.connected ? '' : ' off'}`, player.nickname.slice(0, 1));
  node.style.background = player.color;
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function renderLog(next) {
  const list = document.getElementById('log');
  const follow = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
  list.replaceChildren();
  for (const item of next.log) {
    const li = document.createElement('li');
    li.append(el('span', 'time', clock(item.ts)));
    li.append(el('span', '', item.text));
    list.append(li);
  }
  if (follow) list.scrollTop = list.scrollHeight;
}

function renderChat(next) {
  const list = document.getElementById('chat');
  const follow = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
  list.replaceChildren();
  if (!next.chat.length) list.append(el('li', 'time', '还没有人说话。'));
  for (const item of next.chat) {
    const li = document.createElement('li');
    li.append(el('span', 'time', clock(item.ts)));
    const text = el('span');
    text.append(el('b', '', item.from), document.createTextNode(`：${item.text}`));
    li.append(text);
    list.append(li);
  }
  if (follow) list.scrollTop = list.scrollHeight;
  const newest = next.chat.at(-1)?.n ?? 0;
  if (seenChat == null) seenChat = newest;
  if (newest > seenChat) {
    const fresh = next.chat.filter((item) => item.n > seenChat && item.from !== session.nickname).length;
    seenChat = newest;
    if (side.dataset.feed !== 'chat' || (window.innerWidth <= 900 && side.dataset.tab !== 'chat')) unread += fresh;
  }
  paintUnread();
}

function paintUnread() {
  for (const id of ['unread-d', 'unread-m']) {
    const badge = document.getElementById(id);
    badge.hidden = unread <= 0;
    badge.textContent = String(Math.min(unread, 99));
  }
}

/* ---------- 操作 ---------- */

function renderActions(next) {
  const phase = document.getElementById('phase');
  const actions = document.getElementById('actions');
  phase.replaceChildren();
  actions.replaceChildren();
  const me = next.players.find((p) => p.id === next.you);
  const current = next.players.find((p) => p.id === next.currentPlayerId);
  if (next.status === 'lobby') {
    phase.append(actHead('等待开局'));
    phase.append(el('p', 'act-text', '人齐了就由房主开始。聊天可以先用起来。'));
    return;
  }
  if (next.status === 'finished') {
    const winner = next.players.find((p) => p.id === next.winnerId);
    phase.append(actHead('对局结束'));
    phase.append(el('p', 'act-text', winner ? `${winner.nickname} 是最后没破产的人。` : '这局结束了。'));
    return;
  }

  if (next.phase === 'await_auction' && next.auction) {
    renderAuction(next, me, phase, actions);
    return;
  }

  const here = current ? next.squares[current.position] : null;
  const pill = next.phase !== 'await_roll' && here ? `停在 ${here.name}` : '';
  if (!next.yourTurn) {
    let title = current ? `等待 ${current.nickname}` : '等待下一位';
    if (next.youRole === 'spectator') title = current ? `观战 · ${current.nickname}的回合` : '观战中';
    if (me?.bankrupt) title = '你已破产';
    phase.append(actHead(title, pill));
    let text = '';
    if (current && !current.connected) text = `${current.nickname} 离线了，大约 20 秒后自动托管。`;
    else if (next.youRole === 'spectator') text = '你在观战，棋子不能动，聊天可以。';
    else if (me?.bankrupt) text = '可以留下看完，也可以聊天。';
    else text = otherPhaseLine(next, current);
    if (text) phase.append(el('p', 'act-text', text));
    return;
  }

  phase.append(actHead('轮到你了', pill));
  if (next.phase === 'await_roll') {
    phase.append(el('p', 'act-text', '掷骰前可以拍卖或抵押自己的地。玩家之间不能私下交易。'));
    actions.append(bigButton('掷骰子', { type: 'roll' }));
    const row = el('div', 'row');
    row.append(plainButton('拍卖我的地', () => openSheet('auction')));
    row.append(plainButton('抵押', () => openSheet('mortgage')));
    actions.append(row);
  } else if (next.phase === 'await_buy') {
    const sq = next.squares[next.pendingBuy];
    const price = sq?.price ?? 0;
    const lack = (me?.cash ?? 0) < price;
    const auctionOn = next.rules.auction && next.players.filter((p) => !p.bankrupt).length >= 2;
    phase.append(el('p', 'act-text', lack
      ? `这块地还没有主人，但现金不够 ${yuan(price)}。可以先抵押别的地，${auctionOn ? '或者放弃让大家拍卖。' : '或者放弃。'}`
      : `${sq?.type === 'railroad' ? '这条铁路还没有主人。铁路不能建房，过路费随名下铁路条数增加' : '这块地还没有主人。买下后再停到这里，每次可以加盖一栋房'}；${auctionOn ? '不买就进入 15 秒拍卖。' : '不买就留给银行。'}`));
    const buy = bigButton(`购买 · ${yuan(price)}`, { type: 'buy' });
    buy.disabled = lack;
    actions.append(buy);
    const row = el('div', 'row');
    row.append(plainButton(auctionOn ? '不买，去拍卖' : '不买', () => send({ type: 'decline' })));
    row.append(plainButton('抵押', () => openSheet('mortgage')));
    actions.append(row);
  } else if (next.phase === 'await_manage') {
    const lot = next.squares[next.landedOn];
    const canBuild = lot && lot.ownerId === next.you && lot.type === 'property' && !lot.mortgaged && lot.houses < 4;
    if (lot && lot.ownerId === next.you && lot.type === 'property') {
      phase.append(el('p', 'act-text', canBuild ? `停在自己的地上，这一下可以盖第 ${lot.houses + 1} 栋。` : lot.mortgaged ? '停在自己的地上，但抵押中不能建房。' : '已经有四栋房，盖满了。'));
    } else if (next.rollAgain) {
      phase.append(el('p', 'act-text', '掷出 6，处理完还要再掷一次。'));
    }
    if (canBuild) {
      const build = bigButton(`盖第 ${lot.houses + 1} 栋 · ${yuan(lot.houseCost)}`, { type: 'build', square: lot.index });
      build.disabled = (me?.cash ?? 0) < (lot.houseCost ?? 0);
      actions.append(build);
    }
    const row = el('div', 'row');
    const next1 = next.rollAgain ? '再掷一次' : '结束回合';
    const payload = next.rollAgain ? { type: 'roll' } : { type: 'end' };
    if (canBuild) row.append(plainButton(next1, () => send(payload)));
    else actions.append(bigButton(next1, payload));
    row.append(plainButton('抵押', () => openSheet('mortgage')));
    actions.append(row);
  } else if (next.phase === 'await_jail') {
    phase.append(el('p', 'act-text', '在弹窗里选：交保释金，或者跳过下一回合。'));
  } else if (next.phase === 'await_debt') {
    phase.append(el('p', 'act-text', '现金不够，必须在弹窗里选一块地卖给银行。'));
  }
}

function otherPhaseLine(next, current) {
  if (!current) return '';
  if (next.phase === 'await_roll') return `${current.nickname} 准备掷骰。`;
  if (next.phase === 'await_buy') {
    const sq = next.squares[next.pendingBuy];
    return sq ? `${current.nickname} 在考虑要不要买「${sq.name}」。` : '';
  }
  if (next.phase === 'await_jail') return `${current.nickname} 停在监狱，正在选择。`;
  if (next.phase === 'await_debt') return `${current.nickname} 现金不够，正在卖地还债。`;
  return '';
}

function renderAuction(next, me, phase, actions) {
  const auction = next.auction;
  const sq = next.squares[auction.square];
  const seller = auction.sellerId ? next.players.find((p) => p.id === auction.sellerId) : null;
  const high = next.players.find((p) => p.id === auction.highBidderId);
  phase.append(actHead('拍卖中', seller ? `${seller.id === next.you ? '你' : seller.nickname}拍卖自己的地` : '银行拍卖'));
  const box = el('div', 'auction-box');
  box.style.setProperty('--group', sq?.color || RAIL_COLOR);
  const lot = el('div', 'lot');
  lot.append(el('i'), document.createTextNode(`「${sq?.name || ''}」${sq?.type === 'property' && sq.houses ? ` · 连 ${sq.houses} 栋房` : ''}`));
  box.append(lot);
  box.append(el('div', 'price', high ? yuan(auction.highBid) : `起拍 ${yuan(auction.minBid || 1)}`));
  const meta = el('div', 'meta');
  meta.append(document.createTextNode(high ? `最高出价：${high.id === next.you ? '你' : high.nickname} · ` : '还没人出价 · '));
  const left = el('span');
  left.dataset.countdown = '1';
  meta.append(left);
  box.append(meta);
  const timer = el('div', 'timer');
  const bar = el('i');
  bar.dataset.timerBar = '1';
  timer.append(bar);
  box.append(timer);
  phase.append(box);
  paintCountdown();
  if (next.youRole !== 'player' || !me || me.bankrupt) return;
  if (auction.sellerId === next.you) {
    phase.append(el('p', 'act-text', '等别人出价。成交的钱归你，房子跟着地走；没人出价就还在你手里。'));
    return;
  }
  if (auction.highBidderId === next.you) {
    phase.append(el('p', 'act-text', '你是目前最高出价。别人加价会延长几秒。'));
    return;
  }
  const first = auction.highBidderId ? auction.highBid + 10 : auction.minBid || 1;
  const bid = bigButton(`出价 ${yuan(first)}`, { type: 'bid', amount: first });
  bid.disabled = me.cash < first;
  actions.append(bid);
  const row = el('div', 'row');
  const more = first + 50;
  const raise = plainButton(`出价 ${yuan(more)}`, () => send({ type: 'bid', amount: more }));
  raise.disabled = me.cash < more;
  row.append(raise);
  const passed = auction.passed?.includes(next.you);
  const pass = plainButton(passed ? '已放弃' : '不出价', () => send({ type: 'pass' }));
  pass.disabled = Boolean(passed);
  row.append(pass);
  actions.append(row);
}

function syncAuctionTicker(next) {
  const active = next.status === 'playing' && next.phase === 'await_auction' && next.auction;
  if (active && !auctionTicker) auctionTicker = window.setInterval(paintCountdown, 500);
  if (!active && auctionTicker) {
    window.clearInterval(auctionTicker);
    auctionTicker = 0;
  }
}

function paintCountdown() {
  const auction = state?.auction;
  if (!auction) return;
  const leftMs = Math.max(0, auction.endsAt - Date.now());
  const total = Math.max(1, auction.endsAt - auction.startedAt);
  document.querySelectorAll('[data-countdown]').forEach((node) => {
    node.textContent = `剩 ${Math.ceil(leftMs / 1000)} 秒`;
  });
  document.querySelectorAll('[data-timer-bar]').forEach((node) => {
    node.style.width = `${Math.min(100, (leftMs / total) * 100)}%`;
  });
}

function actHead(title, pill) {
  const head = el('div', 'act-head');
  head.append(el('h2', '', title));
  if (pill) head.append(el('span', 'pill', pill));
  return head;
}

function bigButton(label, payload) {
  const button = el('button', 'primary big', label);
  button.type = 'button';
  button.addEventListener('click', () => send(payload));
  return button;
}

function plainButton(label, onClick) {
  const button = el('button', 'secondary', label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

/* ---------- 抵押和拍卖清单 ---------- */

function openSheet(kind) {
  sheet = kind;
  document.getElementById('sheet').hidden = false;
  renderSheet();
}

function closeSheet() {
  sheet = null;
  document.getElementById('sheet').hidden = true;
}

function renderSheet() {
  if (!state || !sheet) return;
  if (sheet === 'auction' && (state.phase !== 'await_roll' || !state.yourTurn)) {
    closeSheet();
    return;
  }
  document.getElementById('sheet-title').textContent = sheet === 'auction' ? '拍卖我的地' : '抵押和赎回';
  const body = document.getElementById('sheet-body');
  body.replaceChildren();
  body.append(sheet === 'auction' ? auctionSheet(state) : mortgageSheet(state));
}

function lotRow(sq, detail, buttons) {
  const row = el('div', 'sheet-row');
  const band = el('i');
  band.style.setProperty('--c', sq.color || RAIL_COLOR);
  row.append(band);
  const text = el('div', 'text');
  text.append(el('b', '', sq.name), el('span', '', detail));
  row.append(text);
  const box = el('div', 'btns');
  for (const button of buttons) box.append(button);
  row.append(box);
  return row;
}

function mortgageSheet(next) {
  const frag = document.createDocumentFragment();
  const owned = next.squares.filter((sq) => sq.ownerId === next.you && sq.mortgage != null);
  if (!owned.length) {
    frag.append(el('p', 'sheet-note', '你还没有可以抵押的地产。'));
    return frag;
  }
  const list = el('div', 'sheet-list');
  for (const sq of owned) {
    const houses = sq.type === 'property' ? `${sq.houses || 0} 栋房 · ` : '';
    const detail = sq.mortgaged ? `${houses}抵押中，赎回要 ${yuan(sq.unmortgageCost)}` : `${houses}抵押可得 ${yuan(sq.mortgage)}`;
    const buttons = [];
    if (sq.houses > 0 && next.phase !== 'await_debt') {
      const sell = el('button', '', '卖一栋');
      sell.type = 'button';
      sell.addEventListener('click', () => send({ type: 'sell', square: sq.index }));
      buttons.push(sell);
    }
    const toggle = el('button', 'primary', sq.mortgaged ? '赎回' : '抵押');
    toggle.type = 'button';
    toggle.addEventListener('click', () => send({ type: sq.mortgaged ? 'unmortgage' : 'mortgage', square: sq.index }));
    buttons.push(toggle);
    list.append(lotRow(sq, detail, buttons));
  }
  frag.append(list);
  frag.append(el('p', 'sheet-note', '有房子也能抵押，房子留在地上，抵押款只按地价的一半。抵押期间不收租。赎回再加一成。卖一栋房退回造价的一半。'));
  return frag;
}

function auctionSheet(next) {
  const frag = document.createDocumentFragment();
  const owned = next.squares.filter((sq) => sq.ownerId === next.you && sq.price != null);
  if (!owned.length) {
    frag.append(el('p', 'sheet-note', '你还没有地可以拍卖。'));
    return frag;
  }
  const list = el('div', 'sheet-list');
  for (const sq of owned) {
    const houses = sq.type === 'property' ? (sq.houses > 0 ? `连 ${sq.houses} 栋房` : '空地') : '铁路';
    const detail = sq.mortgaged ? `${houses} · 抵押中，先赎回才能拍` : `${houses} · 起拍价 ${yuan(sq.auctionStart)}`;
    const button = el('button', 'primary', '拍卖');
    button.type = 'button';
    button.disabled = sq.mortgaged;
    button.setAttribute('aria-label', `拍卖${sq.name}，起拍价 ${yuan(sq.auctionStart)}`);
    button.addEventListener('click', () => {
      closeSheet();
      send({ type: 'auctionOwn', square: sq.index });
    });
    list.append(lotRow(sq, detail, [button]));
  }
  frag.append(list);
  frag.append(el('p', 'sheet-note', `起拍价是地价加房屋造价的一半。别人有 ${15} 秒出价，成交的钱归你，房子跟着地走；没人出价就还在你手里。`));
  return frag;
}

/* ---------- 工具 ---------- */

function copyInvite() {
  if (!state) return;
  const params = new URLSearchParams({ room: state.roomCode });
  if (session.password) params.set('pw', session.password);
  const link = `${location.origin}/#${params.toString()}`;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(link).then(() => toast('已复制邀请链接')).catch(() => toast(link));
  } else toast(link);
}

function cornerIcon(type) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const add = (tag, attrs) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.append(node);
  };
  if (type === 'go') {
    svg.setAttribute('stroke', '#8a5a12');
    svg.setAttribute('stroke-width', '2.2');
    add('path', { d: 'M20 12H5' });
    add('path', { d: 'M11 6l-6 6 6 6' });
  } else if (type === 'jail') {
    svg.setAttribute('stroke', '#3e352c');
    svg.setAttribute('stroke-width', '2');
    add('rect', { x: '3', y: '4', width: '18', height: '16', rx: '2' });
    add('path', { d: 'M8 4v16M12 4v16M16 4v16' });
  } else {
    svg.setAttribute('stroke-width', '2');
    add('path', { d: 'M7 3v18', stroke: '#b3261e' });
    add('rect', { x: '4.5', y: '7', width: '5', height: '9', rx: '1', fill: '#b3261e', stroke: '#b3261e' });
    add('path', { d: 'M17 4v16', stroke: '#1f7a4d' });
    add('rect', { x: '14.5', y: '9', width: '5', height: '6', rx: '1', fill: '#1f7a4d', stroke: '#1f7a4d' });
  }
  return svg;
}

function shapeIcon(id) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', SHAPES[id] || SHAPES.pebble);
  svg.append(path);
  return svg;
}

function icon(name, size, color) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', color || 'currentColor');
  svg.setAttribute('stroke-width', name === 'x' ? '3' : '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const paths = name === 'x' ? ['M6 6l12 12M18 6L6 18'] : ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'];
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function placement(index) {
  if (index <= 10) return { col: 11 - index, row: 11, side: 'bottom' };
  if (index <= 20) return { col: 1, row: 11 - (index - 10), side: index === 20 ? 'top' : 'left' };
  if (index <= 30) return { col: 1 + (index - 20), row: 1, side: 'top' };
  return { col: 11, row: 1 + (index - 30), side: 'right' };
}

function yuan(value) {
  return `¥${Number(value || 0).toLocaleString('zh-CN')}`;
}

function clock(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function cleanNick(value) {
  const text = value.normalize('NFKC').replace(/[​-‍﻿\s]+/g, '').slice(0, 8);
  return NICK_RE.test(text) ? text : '';
}

function makeCode() {
  const buf = new Uint32Array(5);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => ALPHABET[n % ALPHABET.length]).join('');
}

function storageKey(roomCode, nickname) {
  return `dafuweng:${roomCode}:${nickname}`;
}

function readJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式下存不了，不影响这一局 */
  }
}

function showHomeError(text) {
  homeError.textContent = text;
}

function setBusy(on) {
  document.getElementById('btn-create').disabled = on;
  document.getElementById('btn-join').disabled = on;
}

let toastTimer = 0;
function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2800);
}
