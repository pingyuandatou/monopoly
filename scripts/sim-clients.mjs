/**
 * 用 3 个 WebSocket 客户端走一遍房间：创建、加入、错误密码、
 * 房主开始、走若干回合、断线重连、观战和聊天。
 * 先在另一个终端运行 npm run dev。
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8791';
const WS_BASE = BASE.replace(/^http/, 'ws');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const room = Array.from(crypto.getRandomValues(new Uint8Array(5)), (n) => ALPHABET[n % ALPHABET.length]).join('');
const password = '8888';
const transcript = [];

function say(line) {
  transcript.push(line);
  console.log(line);
}

class Client {
  constructor(name) {
    this.name = name;
    this.ws = null;
    this.welcome = null;
    this.state = null;
    this.errors = [];
  }

  connect(code) {
    const url = `${WS_BASE}/api/ws?room=${code}`;
    this.ws = new WebSocket(url);
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'welcome') this.welcome = msg;
      else if (msg.type === 'state') this.state = msg.state;
      else if (msg.type === 'error') this.errors.push(msg.message);
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name} 连接超时`)), 12000);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`${this.name} WebSocket 失败`));
      });
    });
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  async until(pred, label, ms = 8000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (pred()) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const tail = (this.state?.log || []).slice(-6).map((item) => item.text).join(' / ');
    throw new Error(`${this.name} 等待「${label}」超时。最近错误：${this.errors.at(-1) || '无'}。记录：${tail}`);
  }

  close() {
    this.ws?.close();
  }
}

function decide(state) {
  const me = state.players.find((p) => p.id === state.you);
  if (state.phase === 'await_jail') return { type: 'skipJail' };
  if (state.phase === 'await_roll') return { type: 'roll' };
  if (state.phase === 'await_buy') {
    const sq = state.squares[state.pendingBuy];
    if (sq && me && sq.price != null && me.cash >= sq.price) return { type: 'buy' };
    return { type: 'decline' };
  }
  if (state.phase === 'await_manage') return { type: state.rollAgain ? 'roll' : 'end' };
  if (state.phase === 'await_debt') {
    const shortfall = (state.debt?.amount ?? 0) - (me?.cash ?? 0);
    const lots = state.squares
      .filter((sq) => sq.ownerId === me?.id && sq.price != null)
      .map((sq) => ({ index: sq.index, proceeds: sq.bankSale ?? 0 }));
    if (!lots.length) return { type: 'bankrupt' };
    const enough = lots.filter((lot) => lot.proceeds >= shortfall).sort((a, b) => a.proceeds - b.proceeds || a.index - b.index);
    const richest = [...lots].sort((a, b) => b.proceeds - a.proceeds || a.index - b.index);
    const pick = enough[0] || richest[0];
    return { type: 'liquidate', square: pick.index };
  }
  return null;
}

async function waitHealth() {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < 30000) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
      last = `${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`服务没起来（${last}）。先运行 npm run dev`);
}

async function step(actor) {
  const before = actor.state?.seq ?? 0;
  const errors = actor.errors.length;
  const action = decide(actor.state);
  if (!action) throw new Error(`${actor.name} 在阶段 ${actor.state?.phase} 无操作`);
  actor.send(action);
  await actor.until(() => (actor.state?.seq ?? 0) > before || actor.errors.length > errors, action.type);
  if (actor.errors.length > errors) {
    throw new Error(`${actor.name} 的 ${action.type} 被拒绝：${actor.errors.at(-1)}`);
  }
}

async function main() {
  await waitHealth();
  say(`房间 ${room}，密码 ${password}`);

  const a = new Client('小陈');
  const b = new Client('小林');
  const c = new Client('小周');
  await a.connect(room);
  await b.connect(room);
  await c.connect(room);
  a.send({ type: 'join', nickname: '小陈', password });
  await a.until(() => a.welcome && a.state?.status === 'lobby', '小陈进入大厅');
  if (!a.state.players[0]?.isHost) throw new Error('第一位玩家应该是房主');
  say(`小陈创建房间，身份 ${a.welcome.playerId}`);

  b.send({ type: 'join', nickname: '小林', password });
  c.send({ type: 'join', nickname: '小周', password });
  await b.until(() => b.welcome?.role === 'player', '小林入座');
  await c.until(() => c.welcome?.role === 'player', '小周入座');
  await a.until(() => a.state.players.length === 3, '大厅三人');
  say('小林、小周已入座');

  const d = new Client('路人');
  await d.connect(room);
  d.send({ type: 'join', nickname: '路人', password: '不是这个' });
  await d.until(() => d.errors.length > 0, '错误密码');
  if (d.welcome) throw new Error('错误密码不应进入房间');
  if (!d.errors[0].includes('密码')) throw new Error(`错误提示不像密码问题：${d.errors[0]}`);
  d.close();
  say(`错误密码被拒绝：${d.errors[0]}`);

  const bErrors = b.errors.length;
  b.send({ type: 'start' });
  await b.until(() => b.errors.length > bErrors, '非房主开始');
  if (!b.errors.at(-1).includes('房主')) throw new Error(`非房主开始的提示不对：${b.errors.at(-1)}`);
  say(`非房主不能开始：${b.errors.at(-1)}`);

  const rules = { ...a.state.rules, startingMoney: 2000 };
  a.send({ type: 'settings', rules, password: null });
  await b.until(() => b.state.rules.startingMoney === 2000 && b.state.rules.auction === true, '小林看到起步资金');
  say(`房主把起步资金改成 ${b.state.rules.startingMoney}`);

  b.send({ type: 'appearance', color: '#3b6cff', avatar: 'star' });
  await a.until(() => a.state.players.some((p) => p.id === b.welcome.playerId && p.avatar === 'star'), '小林换棋子');
  say('小林换成星星棋子');

  a.send({ type: 'start' });
  await a.until(() => a.state.status === 'playing', '开始对局');
  await b.until(() => b.state.status === 'playing', '小林看到开局');
  await c.until(() => c.state.status === 'playing', '小周看到开局');
  const startTurn = a.state.turnIndex;
  say(`房主开始。每人 ¥${a.state.players[0].cash}，轮到 ${a.state.players.find((p) => p.id === a.state.currentPlayerId)?.nickname}`);

  const early = b.errors.length;
  b.send({ type: 'roll' });
  await b.until(() => b.errors.length > early, '非当前玩家掷骰');
  if (!b.errors.at(-1).includes('还没轮到你')) throw new Error(`越权掷骰提示不对：${b.errors.at(-1)}`);
  say('还没轮到小林时，掷骰被拒绝');

  const players = [a, b, c];
  let steps = 0;
  let auctionDone = false;
  let ownAuctionDone = false;
  while (steps < 180) {
    const s = a.state;
    if (s.status === 'finished') break;
    const actor = players.find((p) => p.welcome.playerId === s.currentPlayerId);
    if (!actor) throw new Error('找不到当前玩家的连接');
    await actor.until(() => actor.state?.seq === s.seq, '同步');

    if (s.phase === 'await_auction' && s.auction) {
      const sellerId = s.auction.sellerId;
      const amount = Math.max(30, s.auction.minBid || 1);
      const bidder = players.find((p) => p.welcome.playerId !== s.currentPlayerId && (p.state.players.find((q) => q.id === p.welcome.playerId)?.cash ?? 0) >= amount);
      if (!bidder) throw new Error('没有人出得起起拍价');
      const beforeBid = a.state.seq;
      bidder.send({ type: 'bid', amount });
      await a.until(() => a.state.seq > beforeBid || a.state.auction?.highBid === amount, '有人出价');
      for (const client of players) {
        if (client.welcome.playerId === bidder.welcome.playerId) continue;
        if (client.welcome.playerId === sellerId) continue;
        if (a.state.phase !== 'await_auction') break;
        const beforePass = a.state.seq;
        client.send({ type: 'pass' });
        await a.until(() => a.state.seq > beforePass || a.state.phase !== 'await_auction', '其他人不出价');
      }
      await a.until(() => a.state.phase !== 'await_auction', '拍卖结束');
      if (!a.state.log.some((item) => item.text.includes('拍下') || item.text.includes('无人成交'))) {
        throw new Error('拍卖没有写进记录');
      }
      auctionDone = true;
      say(`拍卖结束：${a.state.log.filter((item) => item.text.includes('拍')).at(-1)?.text}`);
      steps += 1;
      continue;
    }

    if (!ownAuctionDone && auctionDone && s.phase === 'await_roll') {
      const mine = s.squares.find((sq) => sq.ownerId === s.currentPlayerId && !sq.mortgaged && sq.auctionStart != null);
      const rich = players.some((p) => p.welcome.playerId !== s.currentPlayerId && (s.players.find((q) => q.id === p.welcome.playerId)?.cash ?? 0) >= (mine?.auctionStart ?? Infinity));
      if (mine && rich) {
        const beforeOwn = a.state.seq;
        actor.send({ type: 'auctionOwn', square: mine.index });
        await a.until(() => a.state.seq > beforeOwn && a.state.auction?.sellerId === s.currentPlayerId, '开始拍卖自己的地');
        if (a.state.auction.minBid !== mine.auctionStart) throw new Error('起拍价和格子上标的不一样');
        say(`${actor.name} 拍卖自己的「${mine.name}」，起拍价 ¥${mine.auctionStart}`);
        ownAuctionDone = true;
        steps += 1;
        continue;
      }
    }

    const bought = s.log.some((item) => item.text.includes('买下') || item.text.includes('放弃购买') || item.text.includes('拍下'));
    const atB = s.currentPlayerId === b.welcome.playerId && s.phase === 'await_roll' && !s.rollAgain && s.turnIndex >= startTurn + 3;
    if (atB && bought && auctionDone && ownAuctionDone) break;
    if (s.phase === 'await_buy' && !auctionDone) {
      const beforeDecline = actor.state.seq;
      actor.send({ type: 'decline' });
      await actor.until(() => (actor.state?.seq ?? 0) > beforeDecline || actor.errors.length, '放弃购买');
      steps += 1;
      continue;
    }
    await step(actor);
    steps += 1;
  }
  if (!auctionDone) throw new Error('这局里没有完成拍卖');
  if (!ownAuctionDone) throw new Error('这局里没有拍卖过自己的地');
  await a.until(() => a.state.currentPlayerId === b.welcome.playerId && a.state.phase === 'await_roll', '停在小林回合');
  const view = a.state;
  const bought = view.log.some((item) => item.text.includes('买下') || item.text.includes('放弃购买'));
  const rolled = view.log.some((item) => item.text.includes('掷出'));
  if (!bought) throw new Error('走了多回合，记录里却没有买下或放弃购买');
  if (!rolled) throw new Error('记录里没有掷骰');
  if (!Number.isInteger(view.lastDice) || view.lastDice < 1 || view.lastDice > 6) {
    throw new Error(`骰子不是服务器给出的 1 到 6：${JSON.stringify(view.lastDice)}`);
  }
  if (view.turnIndex < startTurn + 3) throw new Error(`回合太少：${view.turnIndex}（从 ${startTurn} 起）`);
  const before = view.players.find((p) => p.id === b.welcome.playerId);
  const snap = {
    cash: before.cash,
    position: before.position,
    phase: view.phase,
    current: view.currentPlayerId,
    seq: view.seq,
  };
  say(`已走 ${steps} 步，回合 ${view.turnIndex}，骰子 ${view.lastDice}。小林现金 ${snap.cash}，位置 ${snap.position}`);

  b.close();
  await a.until(() => {
    const player = a.state.players.find((p) => p.id === b.welcome.playerId);
    return player && player.connected === false && player.cash === snap.cash && player.position === snap.position && a.state.phase === snap.phase && a.state.currentPlayerId === snap.current;
  }, '小林离线且局面不变');
  say('小林断开后座位还在，现金、位置和回合没有被托管改掉');

  const token = b.welcome.token;
  const id = b.welcome.playerId;
  const back = new Client('小林');
  await back.connect(room);
  back.send({ type: 'join', nickname: '小林', token });
  await back.until(() => back.welcome?.playerId === id && back.state, '凭令牌回来');
  const restored = back.state.players.find((p) => p.id === id);
  if (back.welcome.role !== 'player') throw new Error('重连后不应该变成观战');
  if (!restored?.connected || restored.cash !== snap.cash || restored.position !== snap.position) {
    throw new Error(`座位没有原样回来：${JSON.stringify(restored)}`);
  }
  if (back.state.phase !== snap.phase || back.state.currentPlayerId !== snap.current) {
    throw new Error('重连后回合变了');
  }
  say(`小林用令牌回到原座位 ${id}`);

  const f = new Client('观众');
  await f.connect(room);
  f.send({ type: 'join', nickname: '观众', password });
  await f.until(() => f.welcome?.role === 'spectator', '观众加入');
  await a.until(() => a.state.spectators.some((s) => s.nickname === '观众'), '房主看到观众');
  say('开局后新昵称只能观战');

  const markB = `小林在 ${Date.now()}`;
  const markF = `观众在 ${Date.now()}`;
  back.send({ type: 'chat', text: markB });
  f.send({ type: 'chat', text: markF });
  await a.until(() => a.state.chat.some((item) => item.text === markB) && a.state.chat.some((item) => item.text === markF), '聊天同步');
  say('观战和玩家的聊天都到了房主那里');

  say('房间流程通过');
  for (const client of [a, c, d, back, f]) client.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  console.error('--- 过程 ---');
  for (const line of transcript) console.error(line);
  process.exit(1);
});
