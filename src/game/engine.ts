import { BOARD_SIZE, SETTINGS, SQUARES } from './content';
import type {
  Auction,
  GameAction,
  JailQuote,
  LogKind,
  MarketCode,
  MarketEvent,
  Ownership,
  Player,
  PropertyRent,
  PublicState,
  PublicSquare,
  RailRent,
  Resume,
  RoomRules,
  RoomState,
  Square,
} from './types';

export interface Rng {
  dice(): number;
  /** 半开区间 [0, 1) 上的均匀随机数，交易所行情用它抽签。 */
  unit(): number;
}

export interface MarketQuote {
  code: MarketCode;
  title: string;
  /** 正为赚钱，负为亏钱。 */
  sign: 1 | -1;
  rate: number;
}

const MARKET_TABLE: { until: number; quote: MarketQuote }[] = [
  { until: 0.25, quote: { code: 'limit_up', title: '涨停', sign: 1, rate: 0.1 } },
  { until: 0.375, quote: { code: 'bull', title: '疯牛', sign: 1, rate: 0.2 } },
  { until: 0.75, quote: { code: 'limit_down', title: '跌停', sign: -1, rate: 0.1 } },
  { until: 1, quote: { code: 'bear', title: '熊市', sign: -1, rate: 0.2 } },
];

/** 1/4 涨停、1/8 疯牛、3/8 跌停、1/4 熊市。 */
export function marketQuote(unit: number): MarketQuote {
  const x = Math.min(0.999999, Math.max(0, unit));
  return (MARKET_TABLE.find((row) => x < row.until) ?? MARKET_TABLE[3]!).quote;
}

/** 按当前现金四舍五入到整数元。现金不大于 0 时金额为 0。 */
export function marketDelta(cash: number, quote: MarketQuote): number {
  if (cash <= 0) return 0;
  return quote.sign * Math.round(cash * quote.rate);
}

interface Ctx {
  rng: Rng;
  depth: number;
}

export function defaultRules(): RoomRules {
  return {
    startingMoney: SETTINGS.startingMoney,
    goSalary: SETTINGS.goSalary,
    maxPlayers: SETTINGS.maxPlayers,
    auction: true,
  };
}

export function makeRng(preset?: { dice?: number[]; units?: number[]; seed?: number }): Rng {
  const diceQueue = preset?.dice ? [...preset.dice] : [];
  const unitQueue = preset?.units ? [...preset.units] : [];
  let seed = preset?.seed ?? 0x12345678;
  const seeded = preset?.seed != null;
  const nextSeeded = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    dice() {
      const next = diceQueue.shift();
      if (next != null) return next;
      if (seeded) return Math.floor(nextSeeded() * 6) + 1;
      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      return (buf[0]! % 6) + 1;
    },
    unit() {
      const next = unitQueue.shift();
      if (next != null) return next;
      if (seeded) return nextSeeded();
      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      return (buf[0] ?? 0) / 4294967296;
    },
  };
}

export function money(n: number): string {
  return `${SETTINGS.currency}${n}`;
}

export function makePlayer(id: string, nickname: string, token: string, color: string, avatar: string, isHost: boolean): Player {
  return {
    id,
    nickname,
    token,
    color,
    avatar,
    cash: 0,
    position: 0,
    inJail: false,
    jailTurns: 0,
    bankrupt: false,
    connected: true,
    isHost,
  };
}

export function createRoomState(roomCode: string, password: string): RoomState {
  return {
    v: 5,
    roomCode,
    password,
    rules: defaultRules(),
    status: 'lobby',
    players: [],
    spectators: [],
    ownership: blankOwnership(),
    currentPlayerId: null,
    phase: 'lobby',
    rollAgain: false,
    lastDice: null,
    pendingBuy: null,
    debt: null,
    auction: null,
    market: null,
    bail: null,
    landedOn: null,
    pot: 0,
    hostLeftAt: null,
    turnAwayId: null,
    turnAwayAt: null,
    log: [],
    chat: [],
    seq: 1,
    winnerId: null,
    turnIndex: 0,
    createdAt: Date.now(),
    logSeq: 0,
    chatSeq: 0,
  };
}

export function updateRules(state: RoomState, byId: string, patch: Partial<RoomRules>, password: string | null): string | null {
  if (state.status !== 'lobby') return '游戏已经开始，不能再改规则';
  const host = state.players.find((p) => p.isHost);
  if (!host || host.id !== byId) return '只有房主可以改规则';
  const next: RoomRules = { ...state.rules, ...patch };
  if (!Number.isInteger(next.startingMoney) || next.startingMoney < 500 || next.startingMoney > 5000) return '起步资金要在 500 到 5000 之间';
  if (!Number.isInteger(next.goSalary) || next.goSalary < 0 || next.goSalary > 1000) return '起点薪水要在 0 到 1000 之间';
  if (!Number.isInteger(next.maxPlayers) || next.maxPlayers < SETTINGS.minPlayers || next.maxPlayers > SETTINGS.maxPlayers) {
    return `人数上限要在 ${SETTINGS.minPlayers} 到 ${SETTINGS.maxPlayers} 之间`;
  }
  if (next.maxPlayers < state.players.length) return '人数上限不能小于已经入座的人数';
  if (typeof next.auction !== 'boolean') return '开关设置无效';
  if (password != null && !password.trim()) return '房间密码不能为空';
  const passwordNext = password != null ? password.slice(0, 16) : state.password;
  if (JSON.stringify(state.rules) === JSON.stringify(next) && state.password === passwordNext) return null;
  state.rules = next;
  state.password = passwordNext;
  state.seq += 1;
  return null;
}

export function setAppearance(state: RoomState, playerId: string, color: string, avatar: string): string | null {
  if (state.status !== 'lobby') return '开局后不能换棋子';
  const player = playerById(state, playerId);
  if (!player) return '你不在房间里';
  if (!SETTINGS.playerColors.some((item) => item.hex === color)) return '没有这个颜色';
  if (!SETTINGS.avatars.some((item) => item.id === avatar)) return '没有这个棋子';
  const taken = state.players.some((p) => p.id !== player.id && p.color === color);
  if (taken) return '这个颜色已经有人用了';
  player.color = color;
  player.avatar = avatar;
  state.seq += 1;
  return null;
}

export function touchHost(state: RoomState, now: number): void {
  const host = state.players.find((p) => p.isHost);
  if (!host) return;
  if (host.connected) state.hostLeftAt = null;
  else if (state.hostLeftAt == null) state.hostLeftAt = now;
  const current = state.currentPlayerId ? state.players.find((p) => p.id === state.currentPlayerId) : undefined;
  if (current && !current.connected && !current.bankrupt && state.status === 'playing') {
    if (state.turnAwayId !== current.id || state.turnAwayAt == null) {
      state.turnAwayId = current.id;
      state.turnAwayAt = now;
    }
  } else {
    state.turnAwayId = null;
    state.turnAwayAt = null;
  }
}

export function maybeTransferHost(state: RoomState, now: number): boolean {
  const host = state.players.find((p) => p.isHost);
  if (!host || host.connected || state.hostLeftAt == null) return false;
  if (now - state.hostLeftAt < SETTINGS.hostGraceMs) return false;
  const start = state.players.findIndex((p) => p.id === host.id);
  let next: Player | null = null;
  for (let n = 1; n <= state.players.length; n += 1) {
    const candidate = state.players[(start + n) % state.players.length];
    if (candidate && candidate.connected) {
      next = candidate;
      break;
    }
  }
  if (!next) {
    for (let n = 1; n <= state.players.length; n += 1) {
      const candidate = state.players[(start + n) % state.players.length];
      if (candidate) {
        next = candidate;
        break;
      }
    }
  }
  if (!next || next.id === host.id) return false;
  host.isHost = false;
  next.isHost = true;
  state.hostLeftAt = next.connected ? null : now;
  pushLog(state, `${host.nickname} 离线较久，房主交给 ${next.nickname}`);
  state.seq += 1;
  return true;
}

export function startGame(state: RoomState, byId: string, _rng: Rng): string | null {
  if (state.status !== 'lobby') return '游戏已经开始';
  const host = state.players.find((p) => p.isHost);
  if (!host || host.id !== byId) return '只有房主可以开始';
  if (state.players.length < SETTINGS.minPlayers) return `至少需要 ${SETTINGS.minPlayers} 人才能开始`;
  if (state.players.length > state.rules.maxPlayers) return `最多 ${state.rules.maxPlayers} 人`;
  state.status = 'playing';
  state.ownership = blankOwnership();
  for (const p of state.players) {
    p.cash = state.rules.startingMoney;
    p.position = 0;
    p.inJail = false;
    p.jailTurns = 0;
    p.bankrupt = false;
  }
  state.currentPlayerId = host.id;
  state.phase = 'await_roll';
  state.rollAgain = false;
  state.lastDice = null;
  state.pendingBuy = null;
  state.debt = null;
  state.auction = null;
  state.market = null;
  state.pot = 0;
  state.winnerId = null;
  state.turnIndex = 1;
  pushLog(state, `游戏开始。玩家：${state.players.map((p) => p.nickname).join('、')}`);
  pushLog(state, `每人 ${money(state.rules.startingMoney)}。轮到 ${host.nickname}`);
  state.seq += 1;
  return null;
}

export function apply(state: RoomState, playerId: string, action: GameAction, rng: Rng): { ok: boolean; error?: string } {
  const player = playerById(state, playerId);
  if (!player) return { ok: false, error: '你不在对局中' };
  if (player.bankrupt) return { ok: false, error: '你已破产' };
  if (state.status === 'finished' || state.phase === 'finished') return { ok: false, error: '这局已经结束' };
  if (state.status !== 'playing') return { ok: false, error: '游戏还没开始' };
  const ctx: Ctx = { rng, depth: 0 };
  const error = dispatch(state, player, action, ctx);
  if (error) return { ok: false, error };
  state.seq += 1;
  return { ok: true };
}

export function resolveAuction(state: RoomState, now: number): boolean {
  if (state.phase !== 'await_auction' || !state.auction) return false;
  if (now < state.auction.endsAt) return false;
  const auction = state.auction;
  const player = playerById(state, state.currentPlayerId);
  state.auction = null;
  const sq = squareAt(auction.square);
  const own = state.ownership[auction.square];
  const winner = auction.highBidderId ? playerById(state, auction.highBidderId) : null;
  const minBid = auction.minBid ?? 1;
  const sellerId = auction.sellerId ?? null;
  const valid = Boolean(winner && !winner.bankrupt && winner.cash >= auction.highBid && auction.highBid >= minBid && auction.highBid > 0);
  if (sellerId) {
    const seller = playerById(state, sellerId);
    if (valid && winner && seller && own && own.ownerId === seller.id && winner.id !== seller.id) {
      winner.cash -= auction.highBid;
      seller.cash += auction.highBid;
      own.ownerId = winner.id;
      const houses = sq.type === 'property' && own.houses > 0 ? `，${own.houses} 栋房一起归他` : '';
      pushLog(state, `${winner.nickname} 以 ${money(auction.highBid)} 拍下 ${seller.nickname} 的「${sq.name}」${houses}`, 'auction');
    } else {
      pushLog(state, `「${sq.name}」没人出价，还在 ${seller?.nickname ?? '原主人'} 手里`, 'auction');
    }
    if (player && !player.bankrupt && state.status === 'playing') state.phase = 'await_roll';
    state.seq += 1;
    return true;
  }
  if (valid && winner && own) {
    winner.cash -= auction.highBid;
    own.ownerId = winner.id;
    own.houses = 0;
    own.mortgaged = false;
    pushLog(state, `${winner.nickname} 以 ${money(auction.highBid)} 拍下「${sq.name}」`, 'auction');
  } else {
    pushLog(state, `「${sq.name}」无人成交，留给银行`, 'auction');
  }
  if (player) finishLanding(state, player);
  state.seq += 1;
  return true;
}

/** 断线托管走一步：不买地、不建房、不参与拍卖。还债时整块卖给银行。 */
export function autoStep(state: RoomState, rng: Rng): boolean {
  if (state.status !== 'playing' || state.phase === 'finished' || state.phase === 'lobby' || state.phase === 'await_auction') return false;
  const id = state.currentPlayerId;
  if (!id) return false;
  const player = playerById(state, id);
  if (!player || player.bankrupt) return false;
  if (state.phase === 'await_jail') return apply(state, id, { type: 'skipJail' }, rng).ok;
  if (state.phase === 'await_roll') return apply(state, id, { type: 'roll' }, rng).ok;
  if (state.phase === 'await_buy') return apply(state, id, { type: 'decline' }, rng).ok;
  if (state.phase === 'await_manage') {
    if (state.rollAgain) return apply(state, id, { type: 'roll' }, rng).ok;
    return apply(state, id, { type: 'end' }, rng).ok;
  }
  if (state.phase === 'await_debt') {
    const index = pickLiquidation(state, player);
    if (index == null) return apply(state, id, { type: 'bankrupt' }, rng).ok;
    return apply(state, id, { type: 'liquidate', square: index }, rng).ok;
  }
  return false;
}

export function computeRent(state: RoomState, index: number): number {
  const own = state.ownership[index];
  const sq = SQUARES[index];
  if (!own || !sq || !own.ownerId || own.mortgaged) return 0;
  const owner = playerById(state, own.ownerId);
  if (!owner || owner.bankrupt) return 0;
  if (owner.inJail) return 0;
  if (sq.type === 'property' && isPropertyRent(sq.rent)) {
    return propertyRent(sq.rent, own.houses);
  }
  if (sq.type === 'railroad' && isRailRent(sq.rent)) {
    const n = Math.min(4, countOwned(state, owner.id, 'railroad'));
    const table = [0, sq.rent.owned1, sq.rent.owned2, sq.rent.owned3, sq.rent.owned4];
    return table[n] ?? 0;
  }
  return 0;
}

export function project(state: RoomState, viewerId: string | null): PublicState {
  const player = viewerId ? state.players.find((p) => p.id === viewerId) : undefined;
  const spec = viewerId ? state.spectators.find((s) => s.id === viewerId) : undefined;
  const youRole = player ? 'player' : spec ? 'spectator' : null;
  return {
    seq: state.seq,
    roomCode: state.roomCode,
    hasPassword: state.password.length > 0,
    status: state.status,
    phase: state.phase,
    currentPlayerId: state.currentPlayerId,
    rollAgain: state.rollAgain,
    lastDice: state.lastDice,
    pendingBuy: state.pendingBuy,
    debt: state.debt ? { amount: state.debt.amount, reason: state.debt.reason } : null,
    auction: state.auction,
    market: state.market,
    bail: state.bail,
    landedOn: state.landedOn,
    pot: state.pot,
    winnerId: state.winnerId,
    turnIndex: state.turnIndex,
    you: viewerId,
    youRole,
    yourTurn: Boolean(
      player && !player.bankrupt && state.status === 'playing' && state.phase !== 'finished' && state.currentPlayerId === player.id,
    ),
    rules: state.rules,
    meta: {
      currency: SETTINGS.currency,
      minPlayers: SETTINGS.minPlayers,
      hostGraceMs: SETTINGS.hostGraceMs,
      disconnectGraceMs: SETTINGS.disconnectGraceMs,
      colors: SETTINGS.playerColors,
      avatars: SETTINGS.avatars,
    },
    players: state.players.map((p) => ({
      id: p.id,
      nickname: p.nickname,
      color: p.color,
      avatar: p.avatar,
      cash: p.cash,
      position: p.position,
      inJail: p.inJail,
      jailTurns: p.jailTurns,
      bankrupt: p.bankrupt,
      connected: p.connected,
      isHost: p.isHost,
    })),
    spectators: state.spectators.map((s) => ({ id: s.id, nickname: s.nickname, connected: s.connected })),
    squares: SQUARES.map((sq, index) => toPublicSquare(state, sq, index)),
    log: state.log.slice(-40),
    chat: state.chat.slice(-40),
  };
}

function dispatch(state: RoomState, player: Player, action: GameAction, ctx: Ctx): string | null {
  if (action.type === 'bid') return bid(state, player, action.amount);
  if (action.type === 'pass') return passAuction(state, player);
  if (action.type === 'liquidate') return liquidate(state, player, action.square, ctx);
  if (state.phase === 'await_auction') return '拍卖进行中';
  if (state.currentPlayerId !== player.id) return '还没轮到你';

  switch (action.type) {
    case 'roll':
      return doRoll(state, player, ctx);
    case 'buy':
      return buy(state, player);
    case 'decline':
      return decline(state, player);
    case 'build':
      return build(state, player, action.square);
    case 'sell':
      return sell(state, player, action.square, ctx);
    case 'mortgage':
      return mortgage(state, player, action.square, ctx);
    case 'unmortgage':
      return unmortgage(state, player, action.square);
    case 'end':
      return endTurn(state);
    case 'payJail':
      return payJail(state, player);
    case 'skipJail':
      return skipJail(state, player);
    case 'bankrupt':
      return declareBankruptcy(state, player, ctx);
    case 'auctionOwn':
      return startOwnerAuction(state, player, action.square);
    default:
      return '未知操作';
  }
}

function doRoll(state: RoomState, player: Player, ctx: Ctx): string | null {
  const again = state.phase === 'await_manage' && state.rollAgain;
  if (state.phase !== 'await_roll' && !again) return '现在不能掷骰子';
  const face = ctx.rng.dice();
  if (!validDie(face)) return '骰子结果无效';
  state.lastDice = face;
  state.rollAgain = false;
  state.pendingBuy = null;
  pushLog(state, `${player.nickname} 掷出 ${face}${face === 6 ? '，可以再掷一次' : ''}`);
  state.landedOn = null;
  moveForward(state, player, face, ctx);
  return null;
}

function payJail(state: RoomState, player: Player): string | null {
  if (state.phase !== 'await_jail' || !state.bail) return '现在不用付保释金';
  const fine = state.bail.amount;
  if (player.cash < fine) return '现金不足，可以先抵押地产';
  player.cash -= fine;
  player.inJail = false;
  player.jailTurns = 0;
  pushLog(state, `${player.nickname} 支付保释金 ${money(fine)}，下一回合照常行动`, 'jail');
  advanceTurn(state);
  return null;
}

function skipJail(state: RoomState, player: Player): string | null {
  if (state.phase !== 'await_jail') return '现在不用做这个选择';
  player.inJail = true;
  player.jailTurns = 0;
  pushLog(state, `${player.nickname} 选择跳过下一回合。在此之前，别人停在你的地上不用交租`, 'jail');
  advanceTurn(state);
  return null;
}

function buy(state: RoomState, player: Player): string | null {
  if (state.phase !== 'await_buy' || state.pendingBuy == null) return '现在不能购买';
  const index = state.pendingBuy;
  const sq = squareAt(index);
  const own = state.ownership[index];
  if (!own || own.ownerId) return '这块地已经有主人';
  const price = sq.price ?? 0;
  if (player.cash < price) return '现金不足，可以先抵押其他地产';
  player.cash -= price;
  own.ownerId = player.id;
  own.houses = 0;
  own.mortgaged = false;
  state.pendingBuy = null;
  pushLog(state, `${player.nickname} 以 ${money(price)} 买下「${sq.name}」`, 'buy');
  finishLanding(state, player);
  return null;
}

function decline(state: RoomState, player: Player): string | null {
  if (state.phase !== 'await_buy' || state.pendingBuy == null) return '现在没有要放弃的地产';
  const index = state.pendingBuy;
  const sq = squareAt(index);
  state.pendingBuy = null;
  pushLog(state, `${player.nickname} 放弃购买「${sq.name}」`, 'buy');
  if (state.rules.auction && alive(state).length >= 2) {
    const now = Date.now();
    const auction: Auction = {
      square: index,
      sellerId: null,
      minBid: 1,
      highBid: 0,
      highBidderId: null,
      startedAt: now,
      endsAt: now + SETTINGS.auctionSeconds * 1000,
      passed: [],
    };
    state.auction = auction;
    state.phase = 'await_auction';
    pushLog(state, `「${sq.name}」开始拍卖，${SETTINGS.auctionSeconds} 秒内出价`, 'auction');
    return null;
  }
  finishLanding(state, player);
  return null;
}

function bid(state: RoomState, player: Player, amount: number): string | null {
  const auction = state.auction;
  if (state.phase !== 'await_auction' || !auction) return '现在没有拍卖';
  if (auction.sellerId === player.id) return '不能给自己拍卖的地出价';
  const min = auction.highBidderId ? auction.highBid + 1 : Math.max(1, auction.minBid ?? 1);
  if (!Number.isInteger(amount) || amount < min) return auction.highBidderId ? '出价要高于当前价格' : `起拍价是 ${money(min)}`;
  if (player.cash < amount) return '现金不够这个出价';
  auction.highBid = amount;
  auction.highBidderId = player.id;
  auction.passed = auction.passed.filter((id) => id !== player.id);
  const now = Date.now();
  const extended = now + SETTINGS.auctionExtendSeconds * 1000;
  const cap = auction.startedAt + SETTINGS.auctionMaxSeconds * 1000;
  if (auction.endsAt - now < SETTINGS.auctionExtendSeconds * 1000) {
    auction.endsAt = Math.min(cap, Math.max(auction.endsAt, extended));
  }
  pushLog(state, `${player.nickname} 出价 ${money(amount)}`, 'auction');
  closeAuctionIfReady(state);
  return null;
}

function passAuction(state: RoomState, player: Player): string | null {
  const auction = state.auction;
  if (state.phase !== 'await_auction' || !auction) return '现在没有拍卖';
  if (auction.sellerId === player.id) return '这是你拍卖的地，等别人出价';
  if (auction.highBidderId === player.id) return '你是当前最高出价，不能放弃';
  if (!auction.passed.includes(player.id)) auction.passed.push(player.id);
  pushLog(state, `${player.nickname} 不参与这轮出价`, 'auction');
  closeAuctionIfReady(state);
  return null;
}

function closeAuctionIfReady(state: RoomState): void {
  const auction = state.auction;
  if (!auction) return;
  const waiting = alive(state).filter((p) => p.id !== auction.highBidderId && p.id !== auction.sellerId && !auction.passed.includes(p.id));
  if (waiting.length === 0) {
    auction.endsAt = 0;
    resolveAuction(state, Date.now());
  }
}

function build(state: RoomState, player: Player, index: number): string | null {
  if (state.phase !== 'await_manage') return '只有停下之后才能建房';
  if (state.landedOn !== index) return '这一回合只能在刚停下的自己的地上建房';
  const sq = squareAt(index);
  const own = state.ownership[index];
  if (!own || sq.type !== 'property' || !isPropertyRent(sq.rent)) return '这里不能建房';
  if (own.ownerId !== player.id) return '这不是你的地产';
  if (own.mortgaged) return '抵押中的地不能建房';
  if (own.houses >= 4) return '已经有四栋房';
  const cost = sq.houseCost ?? 0;
  if (player.cash < cost) return '现金不足';
  player.cash -= cost;
  own.houses += 1;
  state.landedOn = null;
  pushLog(state, `${player.nickname} 在「${sq.name}」建到 ${own.houses} 栋`, 'build');
  return null;
}

function sell(state: RoomState, player: Player, index: number, ctx: Ctx): string | null {
  if (state.phase === 'await_debt') return '还债时只能把地整块卖给银行';
  if (!moneyPhase(state)) return '现在不能出售房屋';
  const err = sellBuilding(state, player, index, false);
  if (err) return err;
  maybeSettle(state, player, ctx);
  return null;
}

function mortgage(state: RoomState, player: Player, index: number, ctx: Ctx): string | null {
  if (state.phase === 'await_debt') return '还债时只能把地卖给银行';
  if (!moneyPhase(state)) return '现在不能抵押';
  const err = mortgageProp(state, player, index);
  if (err) return err;
  maybeSettle(state, player, ctx);
  return null;
}

function unmortgage(state: RoomState, player: Player, index: number): string | null {
  if (!moneyPhase(state)) return '现在不能赎回';
  if (state.phase === 'await_debt') return '还债时不能赎回';
  const sq = squareAt(index);
  const own = state.ownership[index];
  if (!own || own.ownerId !== player.id) return '这不是你的地产';
  if (!own.mortgaged) return '这块地没有抵押';
  const cost = sq.unmortgageCost ?? Math.round((sq.mortgage ?? 0) * 1.1);
  if (player.cash < cost) return '现金不足以赎回';
  player.cash -= cost;
  own.mortgaged = false;
  pushLog(state, `${player.nickname} 花 ${money(cost)} 赎回「${sq.name}」`);
  return null;
}

function endTurn(state: RoomState): string | null {
  if (state.phase !== 'await_manage') return '现在不能结束回合';
  if (state.rollAgain) return '掷出了 6，请再掷一次';
  advanceTurn(state);
  return null;
}

function declareBankruptcy(state: RoomState, player: Player, ctx: Ctx): string | null {
  if (state.phase !== 'await_debt' || !state.debt) return '现在不用宣布破产';
  if (player.cash >= state.debt.amount) {
    maybeSettle(state, player, ctx);
    return null;
  }
  if (pickLiquidation(state, player) != null) return '还有地可以卖给银行';
  forceBankrupt(state, player);
  return null;
}

/** 轮到自己、还没掷骰时，把自己一块没抵押的地拿出来拍卖。起拍价是地价加房屋造价的一半，钱归自己。 */
function startOwnerAuction(state: RoomState, player: Player, index: number): string | null {
  if (state.phase !== 'await_roll') return '只有轮到你、还没掷骰时才能拍卖自己的地';
  if (state.auction) return '已经有一场拍卖在进行';
  if (!Number.isInteger(index) || index < 0 || index >= SQUARES.length) return '这块地不能拍卖';
  const sq = squareAt(index);
  const own = state.ownership[index];
  if (!own || own.ownerId !== player.id || sq.price == null) return '这不是你的地产';
  if (own.mortgaged) return '抵押中的地要先赎回才能拍卖';
  if (alive(state).length < 2) return '没有人可以出价';
  const now = Date.now();
  const minBid = auctionStartPrice(index, own.houses);
  state.auction = {
    square: index,
    sellerId: player.id,
    minBid,
    highBid: 0,
    highBidderId: null,
    startedAt: now,
    endsAt: now + SETTINGS.auctionSeconds * 1000,
    passed: [],
  };
  state.phase = 'await_auction';
  const houses = sq.type === 'property' && own.houses > 0 ? `（连 ${own.houses} 栋房）` : '';
  pushLog(state, `${player.nickname} 拍卖自己的「${sq.name}」${houses}，起拍价 ${money(minBid)}，${SETTINGS.auctionSeconds} 秒内出价`, 'auction');
  return null;
}

function moveForward(state: RoomState, player: Player, steps: number, ctx: Ctx): void {
  const passed = player.position + steps >= BOARD_SIZE;
  const next = (player.position + steps) % BOARD_SIZE;
  if (passed) collectGo(state, player, next === 0);
  player.position = next;
  if (next !== 0) pushLog(state, `${player.nickname} 走到「${squareAt(next).name}」`);
  resolveSquare(state, player, ctx);
}

function collectGo(state: RoomState, player: Player, exact: boolean): void {
  const salary = state.rules.goSalary;
  if (salary <= 0) return;
  player.cash += salary;
  pushLog(state, exact ? `${player.nickname} 正好停在起点，领取 ${money(salary)}` : `${player.nickname} 经过起点，领取 ${money(salary)}`);
}

function resolveSquare(state: RoomState, player: Player, ctx: Ctx): void {
  ctx.depth += 1;
  if (ctx.depth > 4) {
    ctx.depth -= 1;
    finishLanding(state, player);
    return;
  }
  if (state.status !== 'finished') resolveInner(state, player, ctx);
  ctx.depth -= 1;
}

function resolveInner(state: RoomState, player: Player, ctx: Ctx): void {
  const index = player.position;
  const sq = squareAt(index);
  if (sq.type === 'go') {
    finishLanding(state, player);
    return;
  }
  if (sq.type === 'jail') {
    const quote = jailBail(state);
    state.bail = quote;
    state.phase = 'await_jail';
    state.rollAgain = false;
    state.pendingBuy = null;
    state.landedOn = null;
    player.inJail = false;
    pushLog(state, `${player.nickname} 停在监狱。保释金 ${money(quote.amount)}`, 'jail');
    return;
  }
  if (sq.type === 'exchange') {
    resolveMarket(state, player, index, ctx);
    return;
  }
  resolveOwnable(state, player, index, ctx);
}

function resolveMarket(state: RoomState, player: Player, index: number, ctx: Ctx): void {
  const sq = squareAt(index);
  if (player.cash <= 0) {
    pushLog(state, `${player.nickname} 停在「${sq.name}」，手头没有现金，行情没有变化`, 'market');
    finishLanding(state, player);
    return;
  }
  const quote = marketQuote(ctx.rng.unit());
  const delta = marketDelta(player.cash, quote);
  if (delta > 0) player.cash += delta;
  if (delta < 0) player.cash += delta;
  const event: MarketEvent = {
    n: state.logSeq + 1,
    playerId: player.id,
    square: index,
    code: quote.code,
    title: quote.title,
    delta,
  };
  state.market = event;
  const verb = delta > 0 ? `增加 ${money(delta)}` : delta < 0 ? `减少 ${money(-delta)}` : '金额四舍五入后没有变化';
  pushLog(state, `${player.nickname} 在「${sq.name}」遇上${quote.title}，现金${verb}`, 'market');
  finishLanding(state, player);
}

function resolveOwnable(state: RoomState, player: Player, index: number, ctx: Ctx): void {
  const own = state.ownership[index];
  const sq = squareAt(index);
  if (!own) return;
  if (!own.ownerId) {
    state.pendingBuy = index;
    state.phase = 'await_buy';
    pushLog(state, `「${sq.name}」无人拥有，可以 ${money(sq.price ?? 0)} 购买`);
    return;
  }
  if (own.ownerId === player.id) {
    if (sq.type === 'property') state.landedOn = index;
    if (own.mortgaged) pushLog(state, `${player.nickname} 停在自己的「${sq.name}」，抵押中不能建房`);
    else if (sq.type === 'property' && own.houses >= 4) pushLog(state, `${player.nickname} 停在自己的「${sq.name}」，已经有四栋房`);
    else if (sq.type === 'property') pushLog(state, `${player.nickname} 停在自己的「${sq.name}」，可以建一级`);
    else pushLog(state, `${player.nickname} 停在自己的「${sq.name}」`);
    finishLanding(state, player);
    return;
  }
  const owner = playerById(state, own.ownerId);
  if (!owner || owner.bankrupt) {
    finishLanding(state, player);
    return;
  }
  if (own.mortgaged) {
    pushLog(state, `「${sq.name}」正在抵押，免付租金`);
    finishLanding(state, player);
    return;
  }
  if (owner.inJail) {
    pushLog(state, `${owner.nickname} 正在停走，这趟不收租`);
    finishLanding(state, player);
    return;
  }
  const rent = computeRent(state, index);
  if (rent <= 0) {
    finishLanding(state, player);
    return;
  }
  charge(state, player, [{ to: owner.id, amount: rent }], `${player.nickname} 向 ${owner.nickname} 支付「${sq.name}」租金 ${money(rent)}`, { kind: 'finish' }, ctx, 'rent');
}

function charge(
  state: RoomState,
  player: Player,
  splits: { to: string; amount: number }[],
  reason: string,
  resume: Resume,
  ctx: Ctx,
  kind: LogKind = 'info',
): void {
  const amount = splits.reduce((sum, part) => sum + part.amount, 0);
  if (amount <= 0) {
    resumeLater(state, player, resume, ctx);
    return;
  }
  if (player.cash >= amount) {
    paySplits(state, player, splits);
    pushLog(state, reason, kind);
    resumeLater(state, player, resume, ctx);
    return;
  }
  state.phase = 'await_debt';
  state.debt = { amount, reason, splits, resume };
  pushLog(state, `${reason}，现金不够（还差 ${money(amount - player.cash)}）`, kind);
  if (pickLiquidation(state, player) == null) forceBankrupt(state, player);
}

function maybeSettle(state: RoomState, player: Player, ctx: Ctx): void {
  if (state.phase !== 'await_debt' || !state.debt) return;
  if (state.currentPlayerId !== player.id) return;
  if (player.cash < state.debt.amount) return;
  const debt = state.debt;
  paySplits(state, player, debt.splits);
  state.debt = null;
  pushLog(state, `${player.nickname} 筹够现金，付清 ${money(debt.amount)}`);
  resumeLater(state, player, debt.resume, ctx);
}

function resumeLater(state: RoomState, player: Player, resume: Resume, ctx: Ctx): void {
  if (state.status === 'finished') return;
  if (resume.kind === 'finish') {
    finishLanding(state, player);
    return;
  }
  player.inJail = false;
  player.jailTurns = 0;
  pushLog(state, `${player.nickname} 离开监狱，前进 ${resume.dice} 格`, 'jail');
  moveForward(state, player, resume.dice, ctx);
}

function paySplits(state: RoomState, player: Player, splits: { to: string; amount: number }[]): void {
  player.cash -= splits.reduce((sum, part) => sum + part.amount, 0);
  for (const part of splits) {
    if (part.to === 'bank') continue;
    if (part.to === 'pot') {
      state.pot += part.amount;
      continue;
    }
    const to = playerById(state, part.to);
    if (to && !to.bankrupt) to.cash += part.amount;
  }
}

function bankruptTo(state: RoomState, player: Player, creditor: string): void {
  const receiver = creditor === 'bank' ? null : playerById(state, creditor);
  if (!receiver || receiver.bankrupt) {
    player.cash = 0;
    releaseToBank(state, player.id);
  } else {
    receiver.cash += Math.max(0, player.cash);
    player.cash = 0;
    for (const own of state.ownership) {
      if (own.ownerId === player.id) own.ownerId = receiver.id;
    }
  }
  player.bankrupt = true;
  player.inJail = false;
  player.jailTurns = 0;
  pushLog(state, `${player.nickname} 破产出局`);
  const living = alive(state);
  if (living.length <= 1) {
    state.status = 'finished';
    state.phase = 'finished';
    state.winnerId = living[0]?.id ?? null;
    state.pendingBuy = null;
    state.debt = null;
    state.auction = null;
    state.rollAgain = false;
    if (living[0]) pushLog(state, `${living[0].nickname} 赢得了这局`);
    return;
  }
  if (state.currentPlayerId === player.id) advanceTurn(state);
}

function finishLanding(state: RoomState, player: Player): void {
  if (state.status === 'finished' || state.phase === 'finished') return;
  if (player.bankrupt) {
    if (state.currentPlayerId === player.id) advanceTurn(state);
    return;
  }
  if (player.inJail) {
    advanceTurn(state);
    return;
  }
  state.phase = 'await_manage';
  state.rollAgain = state.lastDice === 6;
}

function advanceTurn(state: RoomState): void {
  if (state.status === 'finished') return;
  state.pendingBuy = null;
  state.rollAgain = false;
  state.auction = null;
  state.bail = null;
  state.landedOn = null;
  const living = alive(state);
  if (living.length <= 1) {
    state.status = 'finished';
    state.phase = 'finished';
    state.winnerId = living[0]?.id ?? null;
    if (living[0]) pushLog(state, `${living[0].nickname} 赢得了这局`);
    return;
  }
  let idx = state.players.findIndex((p) => p.id === state.currentPlayerId);
  if (idx < 0) idx = 0;
  for (let n = 0; n < state.players.length * 2; n += 1) {
    idx = (idx + 1) % state.players.length;
    const candidate = state.players[idx];
    if (!candidate || candidate.bankrupt) continue;
    if (candidate.inJail) {
      candidate.inJail = false;
      candidate.jailTurns = 0;
      state.turnIndex += 1;
      pushLog(state, `${candidate.nickname} 跳过这一回合`, 'jail');
      continue;
    }
    state.currentPlayerId = candidate.id;
    state.phase = 'await_roll';
    state.turnIndex += 1;
    pushLog(state, `轮到 ${candidate.nickname}`);
    return;
  }
}

function sellBuilding(state: RoomState, player: Player, index: number, _ignoreEven: boolean): string | null {
  const sq = squareAt(index);
  const own = state.ownership[index];
  if (!own || own.ownerId !== player.id) return '这不是你的地产';
  if (own.houses <= 0 || sq.type !== 'property') return '没有房屋可出售';
  own.houses -= 1;
  const refund = Math.floor((sq.houseCost ?? 0) / 2);
  player.cash += refund;
  pushLog(state, `${player.nickname} 卖掉「${sq.name}」的一栋建筑，收回 ${money(refund)}`, 'build');
  return null;
}

function mortgageProp(state: RoomState, player: Player, index: number): string | null {
  const sq = squareAt(index);
  const own = state.ownership[index];
  if (!own || own.ownerId !== player.id) return '这不是你的地产';
  if (own.mortgaged) return '已经抵押过了';
  if (sq.price == null || sq.mortgage == null) return '这块地不能抵押';
  own.mortgaged = true;
  player.cash += sq.mortgage;
  const kept = own.houses > 0 ? '，房子留在地上' : '';
  pushLog(state, `${player.nickname} 抵押「${sq.name}」，得到 ${money(sq.mortgage)}${kept}`);
  return null;
}

function moneyPhase(state: RoomState): boolean {
  return state.phase === 'await_roll' || state.phase === 'await_manage' || state.phase === 'await_buy' || state.phase === 'await_debt' || state.phase === 'await_jail';
}

/** 地价加上现有房屋的造价。 */
function lotValue(index: number, houses: number): number {
  const sq = SQUARES[index];
  if (!sq || sq.price == null) return 0;
  const built = sq.type === 'property' ? Math.max(0, Math.min(4, houses)) * (sq.houseCost ?? 0) : 0;
  return sq.price + built;
}

/** 卖给银行的到手金额：(地价 + 房屋造价) × 0.8，四舍五入；抵押中再扣掉未还的抵押款。 */
export function saleProceeds(index: number, mortgaged: boolean, houses = 0): number {
  const sq = SQUARES[index];
  if (!sq || sq.price == null) return 0;
  const gross = Math.round(lotValue(index, houses) * 0.8);
  return Math.max(0, gross - (mortgaged ? (sq.mortgage ?? 0) : 0));
}

/** 玩家拍卖自己地产的起拍价：(地价 + 房屋造价) × 0.5，四舍五入，至少 1。 */
export function auctionStartPrice(index: number, houses = 0): number {
  return Math.max(1, Math.round(lotValue(index, houses) * 0.5));
}

/**
 * 还债时选一块地。优先到手最少、但够补上差额的；没有一块够，就先卖到手最多的。
 * 金额相同取编号较小的。
 */
export function pickLiquidation(state: RoomState, player: Player): number | null {
  if (!state.debt) return null;
  const shortfall = state.debt.amount - player.cash;
  const lots: { index: number; proceeds: number }[] = [];
  for (let index = 0; index < SQUARES.length; index += 1) {
    const sq = SQUARES[index];
    const own = state.ownership[index];
    if (!sq || !own || own.ownerId !== player.id || sq.price == null) continue;
    lots.push({ index, proceeds: saleProceeds(index, own.mortgaged, own.houses) });
  }
  if (!lots.length) return null;
  const enough = lots.filter((lot) => lot.proceeds >= shortfall).sort((a, b) => a.proceeds - b.proceeds || a.index - b.index);
  if (enough.length) return enough[0]!.index;
  lots.sort((a, b) => b.proceeds - a.proceeds || a.index - b.index);
  return lots[0]!.index;
}

function liquidate(state: RoomState, player: Player, index: number, ctx: Ctx): string | null {
  if (state.phase !== 'await_debt' || !state.debt) return '现在不用卖地还债';
  if (!Number.isInteger(index) || index < 0 || index >= SQUARES.length) return '这块地不能卖给银行';
  const sq = SQUARES[index];
  const own = state.ownership[index];
  if (!sq || !own || own.ownerId !== player.id || sq.price == null) return '这块地不能卖给银行';
  const mortgaged = own.mortgaged;
  const houseCount = sq.type === 'property' ? own.houses : 0;
  const proceeds = saleProceeds(index, mortgaged, houseCount);
  own.ownerId = null;
  own.houses = 0;
  own.mortgaged = false;
  player.cash += proceeds;
  const note = mortgaged ? '（已扣除未还抵押款）' : '';
  const houses = houseCount > 0 ? `，连 ${houseCount} 栋房按八折算` : '，按八折算';
  pushLog(state, `${player.nickname} 把「${sq.name}」卖给银行，到手 ${money(proceeds)}${note}${houses}`);
  if (!state.debt) return null;
  if (player.cash >= state.debt.amount) {
    maybeSettle(state, player, ctx);
    return null;
  }
  if (pickLiquidation(state, player) == null) forceBankrupt(state, player);
  return null;
}

function forceBankrupt(state: RoomState, player: Player): void {
  const debt = state.debt;
  state.debt = null;
  if (!debt) return;
  const creditors = [...new Set(debt.splits.map((s) => s.to).filter((to) => to !== 'bank' && to !== 'pot'))];
  if (creditors.length === 1) bankruptTo(state, player, creditors[0]!);
  else if (creditors.length > 1) bankruptTo(state, player, mainCreditor(debt.splits));
  else bankruptTo(state, player, 'bank');
}

function countOwned(state: RoomState, ownerId: string, type: Square['type']): number {
  let n = 0;
  SQUARES.forEach((sq, index) => {
    if (sq.type === type && state.ownership[index]?.ownerId === ownerId) n += 1;
  });
  return n;
}

function alive(state: RoomState): Player[] {
  return state.players.filter((p) => !p.bankrupt);
}

function playerById(state: RoomState, id: string | null): Player | null {
  if (!id) return null;
  return state.players.find((p) => p.id === id) ?? null;
}

function squareAt(index: number): Square {
  const sq = SQUARES[index];
  if (!sq) throw new Error(`格子不存在: ${index}`);
  return sq;
}

function blankOwnership(): Ownership[] {
  return SQUARES.map(() => ({ ownerId: null, houses: 0, mortgaged: false }));
}

function releaseToBank(state: RoomState, ownerId: string): void {
  for (const own of state.ownership) {
    if (own.ownerId !== ownerId) continue;
    own.ownerId = null;
    own.houses = 0;
    own.mortgaged = false;
  }
}

function mainCreditor(splits: { to: string; amount: number }[]): string {
  const totals = new Map<string, number>();
  for (const part of splits) {
    if (part.to === 'bank' || part.to === 'pot') continue;
    totals.set(part.to, (totals.get(part.to) ?? 0) + part.amount);
  }
  let best = 'bank';
  let max = -1;
  for (const [id, amount] of totals) {
    if (amount > max) {
      best = id;
      max = amount;
    }
  }
  return best;
}

/** 未抵押、有主人的地，按现在的房屋或铁路条数算出过路费。主人是否在停走不影响这个数。 */
export function jailBail(state: RoomState): JailQuote {
  let bestRent = 0;
  let bestIndex: number | null = null;
  for (let index = 0; index < SQUARES.length; index += 1) {
    const rent = nominalRent(state, index);
    if (rent > bestRent) {
      bestRent = rent;
      bestIndex = index;
    }
  }
  const scaled = Math.ceil(bestRent * 1.5);
  const amount = Math.max(50, scaled);
  const name = bestIndex == null ? null : (SQUARES[bestIndex]?.name ?? null);
  let detail: string;
  if (bestRent <= 0 || !name) detail = '场上还没有能收租的地产，按下限 ¥50';
  else if (scaled < 50) detail = `「${name}」过路费 ${money(bestRent)} × 1.5 = ${money(scaled)}，低于下限，按 ¥50`;
  else detail = `「${name}」当前过路费 ${money(bestRent)} × 1.5`;
  return { amount, square: bestIndex, name, rent: bestRent, floored: amount > scaled || bestRent <= 0, detail };
}

function nominalRent(state: RoomState, index: number): number {
  const own = state.ownership[index];
  const sq = SQUARES[index];
  if (!own || !sq || !own.ownerId || own.mortgaged) return 0;
  const owner = playerById(state, own.ownerId);
  if (!owner || owner.bankrupt) return 0;
  if (sq.type === 'property' && isPropertyRent(sq.rent)) return propertyRent(sq.rent, own.houses);
  if (sq.type === 'railroad' && isRailRent(sq.rent)) {
    const n = Math.min(4, countOwned(state, owner.id, 'railroad'));
    const table = [0, sq.rent.owned1, sq.rent.owned2, sq.rent.owned3, sq.rent.owned4];
    return table[n] ?? 0;
  }
  return 0;
}

function propertyRent(rent: PropertyRent, houses: number): number {
  const table = [rent.base, rent.oneHouse, rent.twoHouses, rent.threeHouses, rent.fourHouses];
  return table[Math.max(0, Math.min(4, houses))] ?? rent.fourHouses;
}

function validDie(face: number): boolean {
  return Number.isInteger(face) && face >= 1 && face <= 6;
}

function pushLog(state: RoomState, text: string, kind: LogKind = 'info'): void {
  state.logSeq += 1;
  state.log.push({ n: state.logSeq, text, ts: Date.now(), kind });
  if (state.log.length > 80) state.log.splice(0, state.log.length - 80);
}

function toPublicSquare(state: RoomState, sq: Square, index: number): PublicSquare {
  const own = state.ownership[index] ?? { ownerId: null, houses: 0, mortgaged: false };
  return {
    index,
    name: sq.name,
    short: sq.short,
    type: sq.type,
    color: sq.color ?? null,
    colorGroup: sq.colorGroup ?? null,
    groupName: sq.groupName ?? null,
    price: sq.price ?? null,
    houseCost: sq.houseCost ?? null,
    mortgage: sq.mortgage ?? null,
    unmortgageCost: sq.unmortgageCost ?? null,
    ownerId: own.ownerId,
    houses: own.houses,
    mortgaged: own.mortgaged,
    hint: hintFor(state, sq),
    rentTable: rentTable(sq),
    bankSale: sq.price != null && own.ownerId ? saleProceeds(index, own.mortgaged, own.houses) : null,
    auctionStart: sq.price != null && own.ownerId ? auctionStartPrice(index, own.houses) : null,
  };
}

function rentTable(sq: Square): number[] | null {
  if (sq.type === 'property' && isPropertyRent(sq.rent)) {
    const rent = sq.rent;
    return [rent.base, rent.oneHouse, rent.twoHouses, rent.threeHouses, rent.fourHouses];
  }
  if (sq.type === 'railroad' && isRailRent(sq.rent)) {
    const rent = sq.rent;
    return [rent.owned1, rent.owned2, rent.owned3, rent.owned4];
  }
  return null;
}

function hintFor(_state: RoomState, sq: Square): string {
  if (sq.type === 'property' && isPropertyRent(sq.rent) && sq.price != null) {
    const rent = sq.rent;
    return `售价 ${money(sq.price)} · 空地租金 ${money(rent.base)} · 一至四栋 ${money(rent.oneHouse)}/${money(rent.twoHouses)}/${money(rent.threeHouses)}/${money(rent.fourHouses)} · 每栋 ${money(sq.houseCost ?? 0)}`;
  }
  if (sq.type === 'railroad' && isRailRent(sq.rent) && sq.price != null) {
    const rent = sq.rent;
    return `铁路 · 售价 ${money(sq.price)} · 拥有 1/2/3/4 条时租金 ${money(rent.owned1)}/${money(rent.owned2)}/${money(rent.owned3)}/${money(rent.owned4)}`;
  }
  if (sq.type === 'jail') return '停在这里马上选择：交保释金，下一回合照常走；或者跳过下一回合。停走期间别人停在你的地上不用交租。';
  if (sq.type === 'exchange') return '按当前现金抽行情：1/4 涨停 +10%，1/8 疯牛 +20%，3/8 跌停 -10%，1/4 熊市 -20%。亏的钱进银行。';
  return sq.description ?? sq.name;
}

function isPropertyRent(rent: Square['rent']): rent is PropertyRent {
  return Boolean(rent && 'base' in rent);
}

function isRailRent(rent: Square['rent']): rent is RailRent {
  return Boolean(rent && 'owned1' in rent);
}
