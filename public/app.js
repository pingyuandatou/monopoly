const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const NICK_RE = /^[\u4e00-\u9fa5A-Za-z0-9_\u00B7]{1,8}$/;
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/;

const home = document.getElementById('home');
const room = document.getElementById('room');
const nickInput = document.getElementById('nick');
const codeInput = document.getElementById('code');
const pwInput = document.getElementById('pw');
const homeError = document.getElementById('home-error');
const toastEl = document.getElementById('toast');

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
let session = { roomCode: '', nickname: '', password: '', token: '' };

boot();

function boot() {
  const last = readJSON('dafuweng:last');
  if (last?.roomCode) {
    codeInput.value = last.roomCode;
    nickInput.value = last.nickname || '';
    pwInput.value = last.password || '';
    const saved = readJSON(storageKey(last.roomCode, last.nickname));
    if (saved?.token) {
      document.getElementById('resume-wrap').hidden = false;
      document.getElementById('btn-resume').addEventListener('click', () => {
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
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeSheet();
      document.getElementById('rules').hidden = true;
    }
  });
  const boardWrap = document.querySelector('.board-wrap');
  if (boardWrap && 'ResizeObserver' in window) new ResizeObserver(() => layoutPieces(false)).observe(boardWrap);
  window.addEventListener('resize', () => layoutPieces(false));
  document.querySelectorAll('.tabs button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((item) => item.classList.toggle('on', item === button));
      document.querySelectorAll('.pane').forEach((pane) => pane.classList.toggle('on', pane.dataset.pane === button.dataset.tab));
    });
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

function createRoom() {
  const nickname = cleanNick(nickInput.value);
  if (!nickname) return showHomeError('昵称请用 1 到 8 位中文、字母或数字');
  const code = makeCode();
  codeInput.value = code;
  connect(code, nickname, pwInput.value.slice(0, 16), '');
}

function joinRoom() {
  const nickname = cleanNick(nickInput.value);
  const code = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  codeInput.value = code;
  if (!nickname) return showHomeError('昵称请用 1 到 8 位中文、字母或数字');
  if (!CODE_RE.test(code)) return showHomeError('房间号是 5 位，请避开 0、O、1、I、L');
  const saved = readJSON(storageKey(code, nickname));
  connect(code, nickname, pwInput.value.slice(0, 16), saved?.token || '');
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
      localStorage.setItem(storageKey(msg.roomCode, msg.nickname), JSON.stringify({ token: msg.token, password }));
      localStorage.setItem('dafuweng:last', JSON.stringify({ roomCode: msg.roomCode, nickname: msg.nickname, password }));
      document.getElementById('disconnected').hidden = true;
      setBusy(false);
    } else if (msg.type === 'state') {
      busy = false;
      render(msg.state);
    } else if (msg.type === 'error') {
      busy = false;
      if (!welcomed) showHomeError(msg.message);
      else toast(msg.message);
    }
  });
  ws.addEventListener('close', () => {
    setBusy(false);
    busy = false;
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
  document.getElementById('disconnected').hidden = true;
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
  renderTurn(next);
  const lobby = document.getElementById('lobby');
  const play = document.getElementById('play');
  if (next.status === 'lobby') {
    lobby.hidden = false;
    play.hidden = true;
    renderLobby(next);
  } else {
    lobby.hidden = true;
    play.hidden = false;
    renderBoard(next);
    renderInspect(next);
    syncPieces(next);
  }
  if (next.status === 'lobby') clearPieces();
  renderPeople(next);
  renderLog(next);
  renderChat(next);
  renderActions(next);
  renderMarket(next);
  renderJail(next);
  renderLiquidate(next);
  if (sheet && sheet !== 'trade') renderSheet();
}

function renderTurn(next) {
  const chip = document.getElementById('turn-chip');
  if (next.status === 'lobby') {
    chip.textContent = `${next.players.length} 人在房间`;
    return;
  }
  if (next.status === 'finished') {
    const winner = next.players.find((p) => p.id === next.winnerId);
    chip.textContent = winner ? `${winner.nickname} 获胜` : '对局结束';
    return;
  }
  const current = next.players.find((p) => p.id === next.currentPlayerId);
  chip.textContent = current ? `轮到 ${current.nickname}` : '对局中';
}

function renderLobby(next) {
  const lobby = document.getElementById('lobby');
  const typing = lobby.contains(document.activeElement);
  if (typing && lobby.dataset.hold === '1') return;
  lobby.replaceChildren();
  lobby.append(el('p', 'eyebrow', '等待开局'));
  lobby.append(el('h2', '', '把房间号发给朋友'));
  lobby.append(el('div', 'code-xl', next.roomCode));
  lobby.append(el('p', '', next.hasPassword ? '这个房间设了密码。人到齐后，房主可以开始。' : '没有密码。人到齐后，房主可以开始。'));
  const me = next.players.find((p) => p.id === next.you);
  for (const player of next.players) {
    const row = el('div', 'person');
    const name = el('span', '');
    const dot = el('i', 'dot');
    dot.style.background = player.color;
    name.append(dot, document.createTextNode(`${player.nickname} · ${avatarLabel(next, player.avatar)}`));
    if (player.isHost) name.append(document.createTextNode(' · 房主'));
    if (player.id === next.you) name.append(document.createTextNode(' · 你'));
    row.append(name);
    row.append(el('span', '', player.connected ? '在线' : '离线'));
    lobby.append(row);
  }
  if (me && next.youRole === 'player') lobby.append(appearancePicker(next, me));
  lobby.append(settingsCard(next, me));
  if (next.youRole === 'spectator') {
    lobby.append(el('p', '', '座位已满，你先观战。'));
  } else if (me?.isHost) {
    const button = el('button', 'primary', '开始');
    button.disabled = next.players.length < (next.meta?.minPlayers || 2);
    button.addEventListener('click', () => send({ type: 'start' }));
    lobby.append(button);
    if (button.disabled) lobby.append(el('p', '', '还差至少 1 人。'));
  } else {
    const host = next.players.find((p) => p.isHost);
    lobby.append(el('p', '', host?.connected ? '等待房主开始。' : '房主离线了，等 ta 回来点开始。'));
  }
}

function avatarLabel(next, id) {
  return next.meta?.avatars?.find((item) => item.id === id)?.label || '棋子';
}

function appearancePicker(next, me) {
  const box = el('div', 'settings');
  box.append(el('h3', '', '棋子'));
  const colors = el('div', 'swatches');
  for (const color of next.meta?.colors || []) {
    const button = el('button', me.color === color.hex ? 'swatch on' : 'swatch');
    button.type = 'button';
    button.style.background = color.hex;
    button.title = color.label;
    button.setAttribute('aria-label', color.label);
    button.addEventListener('click', () => send({ type: 'appearance', color: color.hex, avatar: me.avatar }));
    colors.append(button);
  }
  const avatars = el('div', 'avatars');
  for (const avatar of next.meta?.avatars || []) {
    const button = el('button', me.avatar === avatar.id ? 'avatar-btn on' : 'avatar-btn', avatar.label);
    button.type = 'button';
    button.addEventListener('click', () => send({ type: 'appearance', color: me.color, avatar: avatar.id }));
    avatars.append(button);
  }
  box.append(colors, avatars);
  return box;
}

function settingsCard(next, me) {
  const box = el('div', 'settings');
  box.append(el('h3', '', '房间设置'));
  const rules = next.rules;
  if (!me?.isHost) {
    box.append(el('p', '', `起步 ${yuan(rules.startingMoney)} · 起点 ${yuan(rules.goSalary)} · ${rules.auction ? '不买就拍卖' : '不拍卖'} · 最多 ${rules.maxPlayers} 人`));
    box.append(el('p', '', '保释金不在这里设，停进监狱时现算。'));
    return box;
  }
  const grid = el('div', 'setting-grid');
  grid.append(numberField('起步资金', 'startingMoney', rules.startingMoney, 500, 5000));
  grid.append(numberField('起点薪水', 'goSalary', rules.goSalary, 0, 1000));
  grid.append(numberField('人数上限', 'maxPlayers', rules.maxPlayers, next.meta?.minPlayers || 2, 6));
  box.append(grid);
  const switches = el('div', 'switches');
  switches.append(checkField('不买就拍卖', 'auction', rules.auction));
  box.append(switches);
  const save = el('button', 'primary', '保存设置');
  save.type = 'button';
  save.addEventListener('click', () => {
    const nextRules = { ...rules };
    for (const input of box.querySelectorAll('input')) {
      if (input.type === 'number') nextRules[input.name] = Number(input.value);
      if (input.type === 'checkbox') nextRules[input.name] = input.checked;
    }
    lobbyHold(false);
    send({ type: 'settings', rules: nextRules, password: null });
  });
  box.append(save);
  box.addEventListener('focusin', () => lobbyHold(true));
  box.addEventListener('focusout', () => lobbyHold(false));
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
  const field = el('label', '');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.name = name;
  input.checked = checked;
  field.append(input, document.createTextNode(label));
  return field;
}

function renderJail(next) {
  const box = document.getElementById('jail');
  if (!box) return;
  const show = next.status === 'playing' && next.phase === 'await_jail' && next.bail;
  box.hidden = !show;
  if (!show) return;
  const body = document.getElementById('jail-body');
  body.replaceChildren();
  body.append(el('p', 'delta', yuan(next.bail.amount)));
  const who = next.players.find((p) => p.id === next.currentPlayerId);
  body.append(el('p', '', `${who?.nickname || '当前玩家'} 可以交保释金，下一回合照常走；或者跳过下一回合。`));
  if (next.yourTurn) {
    const row = el('div', 'rowline');
    row.append(actionButton(`付保释金 ${yuan(next.bail.amount)}`, { type: 'payJail' }, true));
    row.append(actionButton('跳过下回合', { type: 'skipJail' }));
    body.append(row);
  }
}

function renderLiquidate(next) {
  const box = document.getElementById('liquidate');
  if (!box) return;
  const show = next.status === 'playing' && next.phase === 'await_debt' && next.debt;
  box.hidden = !show;
  if (!show) return;
  const body = document.getElementById('liquidate-body');
  body.replaceChildren();
  const who = next.players.find((p) => p.id === next.currentPlayerId);
  const shortfall = Math.max(0, (next.debt.amount || 0) - (who?.cash || 0));
  body.append(el('p', '', `${who?.nickname || '当前玩家'} 还差 ${yuan(shortfall)}。选一块地卖给银行，不能跳过。`));
  const owned = next.squares.filter((sq) => sq.ownerId === who?.id && sq.price != null);
  if (!owned.length) {
    body.append(el('p', '', '已经没有地可以卖。'));
    return;
  }
  for (const sq of owned) {
    const proceeds = sq.mortgaged ? sq.price - (sq.mortgage || 0) : sq.price;
    const houses = sq.type === 'property' ? `${sq.houses} 栋房` : '铁路';
    const note = sq.mortgaged
      ? `已抵押，到手 ${yuan(proceeds)}（地价 ${yuan(sq.price)} 减去未还抵押款 ${yuan(sq.mortgage || 0)}）`
      : `到手 ${yuan(proceeds)}`;
    const row = el('div', 'rowline');
    row.append(el('span', 'grow', `${sq.name} · ${houses} · ${note}`));
    if (next.yourTurn) {
      const button = el('button', 'primary', '卖给银行');
      button.type = 'button';
      button.addEventListener('click', () => send({ type: 'liquidate', square: sq.index }));
      row.append(button);
    }
    body.append(row);
  }
  body.append(el('p', '', '只按买入价计算。房子不另算钱，跟着地一起消失。卖完还不够，再选一块。'));
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
  const who = next.players.find((p) => p.id === event.playerId);
  const place = next.squares[event.square]?.name || '交易所';
  card.append(el('p', 'code', place));
  card.append(el('h3', '', event.title));
  const candles = el('div', 'candles');
  for (let i = 0; i < 4; i += 1) candles.append(document.createElement('i'));
  card.append(candles);
  const sign = event.delta > 0 ? '+' : '';
  card.append(el('p', 'delta', `${sign}${yuan(event.delta)}`));
  card.append(el('p', '', `${who?.nickname || '有人'} 停在${place}`));
  box.append(card);
  box.hidden = false;
  window.clearTimeout(marketTimer);
  marketTimer = window.setTimeout(() => {
    box.hidden = true;
  }, 4500);
}

function renderBoard(next) {
  const board = document.getElementById('board');
  if (!board.querySelector('.center')) {
    const center = el('div', 'center');
    center.append(el('p', 'mark', '大富翁'));
    const dice = el('div', 'dice-row');
    dice.id = 'dice';
    center.append(dice);
    const note = el('p', 'center-note');
    note.id = 'center-note';
    center.append(note);
    const winner = el('p', 'winner-banner');
    winner.id = 'winner-banner';
    winner.hidden = true;
    center.append(winner);
    board.append(center);
  }
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
        selected = sq.index;
        renderBoard(state);
        renderInspect(state);
      });
      board.append(cell);
    }
    paintCell(cell, sq, next);
  }
  paintDice(next.lastDice);
  const note = document.getElementById('center-note');
  const current = next.players.find((p) => p.id === next.currentPlayerId);
  note.textContent = next.status === 'finished' ? '' : current ? `${current.nickname} 的回合` : '';
  const banner = document.getElementById('winner-banner');
  const winner = next.players.find((p) => p.id === next.winnerId);
  banner.hidden = next.status !== 'finished';
  banner.textContent = winner ? `${winner.nickname} 赢了` : '';
}

function paintCell(cell, sq, next) {
  const owner = next.players.find((p) => p.id === sq.ownerId);
  const here = next.players.some((p) => !p.bankrupt && p.position === sq.index);
  cell.classList.toggle('owned', Boolean(owner));
  cell.classList.toggle('mortgaged', sq.mortgaged);
  cell.classList.toggle('selected', selected === sq.index);
  cell.classList.toggle('here', here);
  cell.dataset.kind = sq.type;
  if (owner) cell.dataset.owner = owner.id;
  else delete cell.dataset.owner;
  const steps = owner && sq.type === 'railroad' ? 5 : owner && sq.type === 'property' ? Math.min(5, (sq.houses || 0) + 1) : 0;
  cell.dataset.fill = String(steps);
  cell.dataset.houses = sq.type === 'property' ? String(sq.houses || 0) : '';
  cell.style.setProperty('--owner', owner?.color || 'transparent');
  cell.style.setProperty('--fill', steps ? `${steps * 20}%` : '0%');
  cell.setAttribute('aria-label', owner ? `${sq.name}，${owner.nickname}的` : sq.name);
  cell.replaceChildren();
  if (steps) cell.append(el('div', 'fill'));
  cell.append(el('div', 'nm', sq.short || sq.name));
  let sub = '';
  const toll = shownToll(sq, next);
  if (sq.mortgaged) sub = '抵押';
  else if (toll != null) sub = yuan(toll);
  else if (!owner && sq.price) sub = yuan(sq.price);
  if (toll != null && !sq.mortgaged) cell.dataset.toll = String(toll);
  else delete cell.dataset.toll;
  if (sub) cell.append(el('div', 'sub', sub));
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
  if (dice) {
    die.dataset.pips = String(dice);
    die.setAttribute('aria-label', `${dice} 点`);
  }
  for (let i = 0; i < 9; i += 1) die.append(document.createElement('i'));
  row.append(die);
}

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
      piece = el('span', 'piece', player.nickname.slice(0, 1));
      piece.dataset.player = player.id;
      layer.append(piece);
    }
    piece.textContent = player.nickname.slice(0, 1);
    piece.title = player.inJail ? `${player.nickname} · 停走` : player.nickname;
    piece.style.setProperty('--piece', player.color);
    piece.style.background = player.color;
    piece.classList.toggle('turn', player.id === next.currentPlayerId && next.status === 'playing');
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
  const radius = window.innerWidth < 720 ? 18 : 24;
  for (const [index, ids] of groups) {
    const cell = document.querySelector(`.cell[data-index="${index}"]`);
    if (!cell) continue;
    ids.sort((a, b) => (a === current ? -1 : b === current ? 1 : a < b ? -1 : 1));
    const rect = cell.getBoundingClientRect();
    const cx = rect.left - wrapRect.left + rect.width / 2;
    const cy = rect.top - wrapRect.top + rect.height / 2;
    ids.forEach((id, i) => {
      const piece = layer.querySelector(`[data-player="${CSS.escape(id)}"]`);
      if (!piece) return;
      const angle = ids.length === 1 ? 0 : (Math.PI * 2 * i) / ids.length - Math.PI / 2;
      const dist = ids.length === 1 ? 0 : radius;
      piece.dataset.index = String(index);
      piece.style.transition = animate ? 'left 120ms linear, top 120ms linear' : 'none';
      piece.style.left = `${cx + Math.cos(angle) * dist}px`;
      piece.style.top = `${cy + Math.sin(angle) * dist}px`;
    });
  }
}

function renderInspect(next) {
  const box = document.getElementById('inspect');
  box.replaceChildren();
  const sq = next.squares.find((item) => item.index === selected);
  if (!sq) {
    box.append(el('p', '', '点一格，查看地名、售价和主人。'));
    return;
  }
  box.append(el('strong', '', sq.name));
  box.append(el('p', '', sq.hint));
  const owner = next.players.find((p) => p.id === sq.ownerId);
  if (owner) {
    const line = owner.bankrupt ? `${owner.nickname} 曾拥有这里` : `${owner.nickname} 拥有`;
    const extra = sq.mortgaged ? '，抵押中' : sq.type === 'property' ? `，现在 ${sq.houses} 栋房屋` : '';
    box.append(el('p', '', line + extra));
  }
  if (sq.type === 'property' && sq.rentTable) {
    const names = ['空地', '一栋', '二栋', '三栋', '四栋'];
    box.append(el('p', '', sq.rentTable.map((n, i) => `${names[i] || i} ${yuan(n)}`).join(' · ')));
  }
  if (sq.type === 'railroad' && sq.rentTable) {
    box.append(el('p', '', sq.rentTable.map((n, i) => `${i + 1} 条 ${yuan(n)}`).join(' · ')));
  }
}

function renderPeople(next) {
  const box = document.getElementById('people');
  box.replaceChildren();
  for (const player of next.players) {
    const card = el('article', player.id === next.currentPlayerId && next.status === 'playing' ? 'player-card turn' : 'player-card');
    card.style.borderLeftColor = player.color;
    const who = el('div', 'who');
    const badge = el('span', player.id === next.currentPlayerId && next.status === 'playing' ? 'piece mini turn' : 'piece mini', player.nickname.slice(0, 1));
    badge.style.setProperty('--piece', player.color);
    badge.style.background = player.color;
    badge.title = player.nickname;
    const name = el('b', '', `${player.nickname}${player.id === next.you ? ' · 你' : ''}${player.isHost ? ' · 房主' : ''}`);
    name.style.flex = '1';
    who.append(badge, name);
    if (next.status !== 'lobby') who.append(el('span', 'cash', yuan(player.cash)));
    card.append(who);
    const badges = el('div', 'badges');
    if (player.bankrupt) badges.append(el('span', 'badge', '破产'));
    if (player.inJail) badges.append(el('span', 'badge', '停走'));
    if (!player.connected) badges.append(el('span', 'badge off', '离线'));
    if (badges.childElementCount) card.append(badges);
    const owned = next.squares.filter((sq) => sq.ownerId === player.id);
    if (owned.length) {
      const props = el('div', 'props');
      for (const sq of owned) {
        const label = sq.mortgaged ? `${sq.short}·押` : sq.type === 'property' ? `${sq.short}·${sq.houses}` : sq.short;
        const chip = el('span', 'chip', label);
        if (sq.color) chip.style.borderColor = sq.color;
        props.append(chip);
      }
      card.append(props);
    }
    box.append(card);
  }
  for (const spectator of next.spectators) {
    box.append(el('p', '', `${spectator.nickname} 在观战${spectator.connected ? '' : '（离线）'}`));
  }
}

function renderLog(next) {
  const list = document.getElementById('log');
  const follow = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
  list.replaceChildren();
  for (const item of next.log) {
    const li = document.createElement('li');
    li.append(el('span', 'time', clock(item.ts)));
    li.append(document.createTextNode(item.text));
    list.append(li);
  }
  if (follow) list.scrollTop = list.scrollHeight;
}

function renderChat(next) {
  const list = document.getElementById('chat');
  const follow = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
  list.replaceChildren();
  if (!next.chat.length) list.append(el('li', '', '还没有人说话。'));
  for (const item of next.chat) {
    const li = document.createElement('li');
    li.append(el('span', 'time', clock(item.ts)));
    li.append(el('b', '', item.from));
    li.append(document.createTextNode(`：${item.text}`));
    list.append(li);
  }
  if (follow) list.scrollTop = list.scrollHeight;
}

function renderActions(next) {
  const phase = document.getElementById('phase');
  const actions = document.getElementById('actions');
  phase.replaceChildren();
  actions.replaceChildren();
  const me = next.players.find((p) => p.id === next.you);
  if (next.status === 'lobby') {
    phase.append(el('p', '', '人齐了就由房主开始。聊天可以先用起来。'));
    return;
  }
  if (next.youRole === 'spectator') phase.append(el('p', '', '你在观战，棋子不能动，聊天可以。'));
  else if (me?.bankrupt) phase.append(el('p', '', '你破产了，可以留下看完，也可以聊天。'));
  else if (next.status === 'finished') {
    const winner = next.players.find((p) => p.id === next.winnerId);
    phase.append(el('p', '', winner ? `${winner.nickname} 是最后没破产的人。` : '这局结束了。'));
  } else phase.append(el('p', '', phaseLine(next, me)));

  if (next.lastDice && next.status !== 'lobby') {
    phase.append(el('p', '', `最近一次骰子：${next.lastDice}`));
  }
  if (next.trade) actions.append(tradeCard(next));
  if (next.phase === 'await_auction' && next.auction && next.youRole === 'player' && !me?.bankrupt) {
    const sq = next.squares[next.auction.square];
    phase.append(el('p', '', `正在拍卖「${sq?.name ?? ''}」。当前 ${yuan(next.auction.highBid)}。`));
    const bid = actionButton('出价 +10', { type: 'bid', amount: Math.max(10, next.auction.highBid + 10) }, true);
    actions.append(bid);
    if (next.auction.highBidderId !== next.you) actions.append(actionButton('不出价', { type: 'pass' }));
  }
  if (!next.yourTurn || next.status !== 'playing') return;

  if (next.phase === 'await_roll') {
    actions.append(actionButton('掷骰子', { type: 'roll' }, true));
    actions.append(actionButton('抵押', null, false, () => openSheet('mortgage')));
    actions.append(actionButton('交易', null, false, () => openSheet('trade')));
  } else if (next.phase === 'await_buy') {
    actions.append(actionButton('购买', { type: 'buy' }, true));
    actions.append(actionButton('不买', { type: 'decline' }));
    actions.append(actionButton('抵押', null, false, () => openSheet('mortgage')));
  } else if (next.phase === 'await_manage') {
    if (next.rollAgain) actions.append(actionButton('掷骰子', { type: 'roll' }, true));
    else actions.append(actionButton('结束回合', { type: 'end' }, true));
    const lot = next.squares[next.landedOn];
    if (lot && lot.ownerId === next.you && lot.type === 'property' && !lot.mortgaged && lot.houses < 4) {
      const label = `在${lot.name}建到 ${lot.houses + 1} 栋`;
      actions.append(actionButton(label, { type: 'build', square: lot.index }, true));
    }
    actions.append(actionButton('抵押', null, false, () => openSheet('mortgage')));
    actions.append(actionButton('交易', null, false, () => openSheet('trade')));
  } else if (next.phase === 'await_jail') {
    const fine = next.bail?.amount ?? 50;
    actions.append(actionButton(`付保释金 ${yuan(fine)}`, { type: 'payJail' }, true));
    actions.append(actionButton('跳过下回合', { type: 'skipJail' }));
    actions.append(actionButton('抵押', null, false, () => openSheet('mortgage')));
  } else if (next.phase === 'await_debt') {
    phase.append(el('p', '', '现金不够，必须卖一块地给银行。'));
  }
}

function phaseLine(next, me) {
  if (!next.yourTurn) {
    const current = next.players.find((p) => p.id === next.currentPlayerId);
    if (!current) return '等待下一位。';
    return current.connected ? `等待 ${current.nickname}。` : `${current.nickname} 离线了，大约 20 秒后自动托管。`;
  }
  if (next.phase === 'await_jail') {
    return next.bail ? `停在监狱。保释金 ${yuan(next.bail.amount)}。可以照常走，或跳过下一回合。` : '停在监狱。可以交保释金，或跳过下一回合。';
  }
  if (next.phase === 'await_roll') return '轮到你了。可以先抵押或交易，然后掷骰子。';
  if (next.phase === 'await_buy') {
    const sq = next.squares[next.pendingBuy];
    return sq ? `停在「${sq.name}」。要花 ${yuan(sq.price)} 买下吗？` : '要购买这块地吗？';
  }
  if (next.phase === 'await_debt') return '现金不够，请在弹窗里选一块地卖给银行。';
  if (next.phase === 'await_manage' && next.landedOn != null) {
    const sq = next.squares[next.landedOn];
    const extra = next.rollAgain ? '然后还要再掷一次。' : '也可以结束回合。';
    return sq ? `停在自己的「${sq.name}」。这一下可以升一级。${extra}` : '可以处理资产，或者结束回合。';
  }
  if (next.phase === 'await_manage' && next.rollAgain) return '掷出 6。可以先处理资产，然后必须再掷一次。';
  if (next.phase === 'await_manage') return '可以抵押、提议交易，或者结束回合。';
  return '轮到你了。';
}

function tradeCard(next) {
  const card = el('div', 'trade-card');
  card.append(el('p', '', describeTrade(next)));
  const trade = next.trade;
  const responding = (trade.stage === 'offer' && trade.toId === next.you) || (trade.stage === 'counter' && trade.fromId === next.you);
  if (responding) {
    const row = el('div', 'rowline');
    row.append(actionButton('同意', { type: 'tradeAnswer', accept: true }, true));
    row.append(actionButton('拒绝', { type: 'tradeAnswer', accept: false }));
    card.append(row);
    if (trade.stage === 'offer' && trade.toId === next.you) {
      const cash = document.createElement('input');
      cash.type = 'number';
      cash.min = '0';
      cash.step = '1';
      cash.value = String(trade.offerCash);
      const revise = el('button', '', '只改现金并退回');
      revise.type = 'button';
      revise.addEventListener('click', () => send({ type: 'tradeCounter', cash: Number(cash.value || 0) }));
      const line = el('div', 'rowline');
      line.append(cash, revise);
      card.append(line);
    }
  } else if (trade.fromId === next.you && trade.stage === 'offer') {
    card.append(actionButton('取消交易', { type: 'tradeCancel' }));
  }
  return card;
}

function describeTrade(next) {
  const trade = next.trade;
  const from = next.players.find((p) => p.id === trade.fromId);
  const to = next.players.find((p) => p.id === trade.toId);
  const offer = bits(next, trade.offerSquares, trade.offerCash);
  const ask = bits(next, trade.requestSquares, 0);
  const revised = trade.stage === 'counter' ? '对方改过现金。' : '';
  return `${revised}${from?.nickname || '玩家'} 用${offer}，换 ${to?.nickname || '对方'} 的${ask}`;
}

function bits(next, squares, cash) {
  const names = squares.map((index) => `「${next.squares[index]?.name || index}」`).join('、');
  return [cash ? yuan(cash) : '', names].filter(Boolean).join('、') || '空';
}

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
  const title = { mortgage: '抵押和卖房', trade: '交易' }[sheet] || '操作';
  document.getElementById('sheet-title').textContent = title;
  const body = document.getElementById('sheet-body');
  body.replaceChildren();
  if (sheet === 'mortgage') body.append(mortgageSheet(state));
  else body.append(tradeSheet(state));
}

function mortgageSheet(next) {
  const frag = document.createDocumentFragment();
  const owned = next.squares.filter((sq) => sq.ownerId === next.you && sq.mortgage != null);
  if (!owned.length) {
    frag.append(el('p', '', '你还没有可以抵押的地产。'));
    return frag;
  }
  for (const sq of owned) {
    const row = el('div', 'rowline');
    const houses = sq.type === 'property' ? ` · ${sq.houses} 栋` : '';
    row.append(el('span', 'grow', `${sq.name}${houses} · ${sq.mortgaged ? `赎回 ${yuan(sq.unmortgageCost)}` : `抵押得 ${yuan(sq.mortgage)}`}`));
    if (sq.houses > 0) {
      const sell = el('button', '', '卖一栋');
      sell.addEventListener('click', () => send({ type: 'sell', square: sq.index }));
      row.append(sell);
    }
    const button = el('button', '', sq.mortgaged ? '赎回' : '抵押');
    button.addEventListener('click', () => send({ type: sq.mortgaged ? 'unmortgage' : 'mortgage', square: sq.index }));
    row.append(button);
    frag.append(row);
  }
  frag.append(el('p', '', '有房子也能抵押，房子留在地上，抵押款只按地价的一半。抵押期间不收租。赎回再加一成。卖房退回造价的一半。'));
  return frag;
}

function tradeSheet(next) {
  const frag = document.createDocumentFragment();
  const others = next.players.filter((p) => p.id !== next.you && !p.bankrupt);
  if (!others.length) {
    frag.append(el('p', '', '现在没有可以交易的对手。'));
    return frag;
  }
  const form = document.createElement('form');
  form.className = 'group';
  const pick = document.createElement('select');
  for (const player of others) {
    const option = document.createElement('option');
    option.value = player.id;
    option.textContent = player.nickname;
    pick.append(option);
  }
  form.append(el('span', '', '跟谁换'), pick);
  const offerCash = numberInput('你支付的现金，可以是 0');
  form.append(offerCash.label);
  form.append(el('span', '', '你给出的地'));
  form.append(checkList(next, next.you, 'offer'));
  form.append(el('span', '', '你想要的地'));
  const wanted = document.createElement('div');
  wanted.className = 'checks';
  form.append(wanted);
  const refreshWanted = () => {
    wanted.replaceChildren();
    const list = checkList(next, pick.value, 'want');
    wanted.append(list);
  };
  pick.addEventListener('change', refreshWanted);
  refreshWanted();
  const submit = el('button', 'primary', '提议交易');
  submit.type = 'submit';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    send({
      type: 'trade',
      toId: pick.value,
      offerCash: Number(offerCash.input.value || 0),
      offerSquares: checked(form, 'offer'),
      requestSquares: checked(form, 'want'),
    });
    closeSheet();
  });
  form.append(submit);
  frag.append(form);
  frag.append(el('p', '', '用现金和自己的地，换对方的地。房子随地一起走。对方只能同意、拒绝，或改现金后再退回来。'));
  return frag;
}

function checkList(next, ownerId, name) {
  const box = el('div', 'checks');
  const squares = next.squares.filter((sq) => sq.ownerId === ownerId && sq.price != null);
  if (!squares.length) box.append(el('span', '', '没有地产'));
  for (const sq of squares) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = name;
    input.value = String(sq.index);
    label.append(input, document.createTextNode(`${sq.name}${sq.mortgaged ? '（抵押）' : ''}${sq.houses ? '（有房）' : ''}`));
    box.append(label);
  }
  return box;
}

function numberInput(text) {
  const label = document.createElement('label');
  label.textContent = text;
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.step = '1';
  input.value = '0';
  label.append(input);
  return { label, input };
}

function checked(form, name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => Number(input.value));
}

function actionButton(label, payload, primary, onClick) {
  const button = el('button', primary ? 'primary' : '', label);
  button.type = 'button';
  button.addEventListener('click', () => {
    if (onClick) onClick();
    else send(payload);
  });
  return button;
}

function copyInvite() {
  if (!state) return;
  const password = session.password ? `，密码 ${session.password}` : '';
  const text = `大富翁房间 ${state.roomCode}${password}。打开 ${location.origin} 加入。`;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => toast('已复制房间信息')).catch(() => toast(text));
  } else toast(text);
}

function placement(index) {
  if (index <= 10) return { col: 11 - index, row: 11, side: 'bottom' };
  if (index <= 20) return { col: 1, row: 11 - (index - 10), side: index === 20 ? 'top' : 'left' };
  if (index <= 30) return { col: 1 + (index - 20), row: 1, side: 'top' };
  return { col: 11, row: 1 + (index - 30), side: 'right' };
}

function me(next) {
  return next.players.find((p) => p.id === next.you) || null;
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
  const text = value.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF\s]+/g, '').slice(0, 8);
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
