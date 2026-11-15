export type SquareType = 'go' | 'property' | 'railroad' | 'jail' | 'exchange';

export interface PropertyRent {
  base: number;
  monopoly: number;
  oneHouse: number;
  twoHouses: number;
  threeHouses: number;
  fourHouses: number;
  hotel: number;
}

export interface RailRent {
  owned1: number;
  owned2: number;
  owned3: number;
  owned4: number;
}

export interface Square {
  position: number;
  type: SquareType;
  name: string;
  short: string;
  colorGroup?: string;
  groupName?: string;
  color?: string;
  price?: number;
  houseCost?: number;
  mortgage?: number;
  unmortgageCost?: number;
  rent?: PropertyRent | RailRent;
  description?: string;
}

export interface Settings {
  startingMoney: number;
  goSalary: number;
  maxPlayers: number;
  minPlayers: number;
  disconnectGraceMs: number;
  hostGraceMs: number;
  auctionSeconds: number;
  auctionExtendSeconds: number;
  auctionMaxSeconds: number;
  /** 房间多少小时没人动就自动删除。 */
  idleCleanupHours: number;
  currency: string;
  playerColors: { id: string; hex: string; label: string }[];
  avatars: { id: string; label: string }[];
}

/** 房主在开局前可以改的规则。保释金按停进监狱时的地产现算，不在这里设。 */
export interface RoomRules {
  startingMoney: number;
  goSalary: number;
  maxPlayers: number;
  auction: boolean;
}

export type Phase = 'lobby' | 'await_roll' | 'await_buy' | 'await_auction' | 'await_jail' | 'await_debt' | 'await_manage' | 'finished';
export type RoomStatus = 'lobby' | 'playing' | 'finished';
export type LogKind = 'info' | 'buy' | 'rent' | 'build' | 'jail' | 'auction' | 'market';
export type MarketCode = 'limit_up' | 'bull' | 'limit_down' | 'bear';

export interface MarketEvent {
  n: number;
  playerId: string;
  square: number;
  code: MarketCode;
  title: string;
  delta: number;
}

export interface Player {
  id: string;
  nickname: string;
  token: string;
  color: string;
  avatar: string;
  cash: number;
  position: number;
  inJail: boolean;
  jailTurns: number;
  bankrupt: boolean;
  connected: boolean;
  isHost: boolean;
}

export interface Spectator {
  id: string;
  nickname: string;
  token: string;
  connected: boolean;
}

export interface Ownership {
  ownerId: string | null;
  /** 0–4 栋。四栋是最高，没有旅馆。 */
  houses: number;
  mortgaged: boolean;
}

export type Resume = { kind: 'finish' } | { kind: 'exitJailMove'; dice: number };

export interface Debt {
  amount: number;
  reason: string;
  splits: { to: string; amount: number }[];
  resume: Resume;
}

/** 停进监狱时锁定的保释金。 */
export interface JailQuote {
  amount: number;
  square: number | null;
  name: string | null;
  rent: number;
  /** 1.5 倍不足 50，或场上没有能收租的地。 */
  floored: boolean;
  detail: string;
}

export interface Auction {
  square: number;
  /** null 是银行拍卖（有人不买）；否则是这位玩家在掷骰前拍卖自己的地。 */
  sellerId: string | null;
  /** 第一口出价的下限。银行拍卖是 1，玩家拍卖是地价加房屋造价的一半。 */
  minBid: number;
  highBid: number;
  highBidderId: string | null;
  startedAt: number;
  endsAt: number;
  passed: string[];
}

export interface LogItem {
  n: number;
  text: string;
  ts: number;
  kind: LogKind;
}

export interface ChatItem {
  n: number;
  from: string;
  text: string;
  ts: number;
}

export interface RoomState {
  v: 5;
  roomCode: string;
  password: string;
  rules: RoomRules;
  status: RoomStatus;
  players: Player[];
  spectators: Spectator[];
  ownership: Ownership[];
  currentPlayerId: string | null;
  phase: Phase;
  rollAgain: boolean;
  /** 最近一次掷出的点数，1 到 6。 */
  lastDice: number | null;
  pendingBuy: number | null;
  debt: Debt | null;
  auction: Auction | null;
  /** 最近一次交易所行情，给所有人弹窗。 */
  market: MarketEvent | null;
  /** 当前这一次进监狱锁定的保释金。 */
  bail: JailQuote | null;
  /** 这一步刚停下的自己的地，只能在这里升一级。 */
  landedOn: number | null;
  /** 保留字段。奖池已取消，钱进银行，数值保持 0。 */
  pot: number;
  /** 房主断开的时间。重新连接后清空。 */
  hostLeftAt: number | null;
  /** 当前行动玩家断开的时间。用来等满托管宽限，避免拍卖闹钟提前托管。 */
  turnAwayId: string | null;
  turnAwayAt: number | null;
  log: LogItem[];
  chat: ChatItem[];
  seq: number;
  winnerId: string | null;
  turnIndex: number;
  createdAt: number;
  /** 最近一次有人进房或操作的时间。旧存档没有这个字段，按 createdAt 算。 */
  lastActiveAt?: number;
  logSeq: number;
  chatSeq: number;
}

export type GameAction =
  | { type: 'roll' }
  | { type: 'buy' }
  | { type: 'decline' }
  | { type: 'bid'; amount: number }
  | { type: 'pass' }
  | { type: 'build'; square: number }
  | { type: 'sell'; square: number }
  | { type: 'liquidate'; square: number }
  | { type: 'mortgage'; square: number }
  | { type: 'unmortgage'; square: number }
  | { type: 'end' }
  | { type: 'payJail' }
  | { type: 'skipJail' }
  | { type: 'bankrupt' }
  | { type: 'auctionOwn'; square: number };

export interface PublicSquare {
  index: number;
  name: string;
  short: string;
  type: SquareType;
  color: string | null;
  colorGroup: string | null;
  groupName: string | null;
  price: number | null;
  houseCost: number | null;
  mortgage: number | null;
  unmortgageCost: number | null;
  ownerId: string | null;
  houses: number;
  mortgaged: boolean;
  hint: string;
  rentTable: number[] | null;
  /** 现在卖给银行能拿到多少：(地价 + 房屋造价) × 0.8，抵押中再扣抵押款。 */
  bankSale: number | null;
  /** 现在拍卖这块地的起拍价：(地价 + 房屋造价) × 0.5。 */
  auctionStart: number | null;
}

export interface PublicPlayer {
  id: string;
  nickname: string;
  color: string;
  avatar: string;
  cash: number;
  position: number;
  inJail: boolean;
  jailTurns: number;
  bankrupt: boolean;
  connected: boolean;
  isHost: boolean;
}

export interface PublicState {
  seq: number;
  roomCode: string;
  hasPassword: boolean;
  status: RoomStatus;
  phase: Phase;
  currentPlayerId: string | null;
  rollAgain: boolean;
  lastDice: number | null;
  pendingBuy: number | null;
  debt: { amount: number; reason: string } | null;
  auction: Auction | null;
  market: MarketEvent | null;
  bail: JailQuote | null;
  landedOn: number | null;
  pot: number;
  winnerId: string | null;
  turnIndex: number;
  you: string | null;
  youRole: 'player' | 'spectator' | null;
  yourTurn: boolean;
  rules: RoomRules;
  meta: {
    currency: string;
    minPlayers: number;
    hostGraceMs: number;
    disconnectGraceMs: number;
    colors: Settings['playerColors'];
    avatars: Settings['avatars'];
  };
  players: PublicPlayer[];
  spectators: { id: string; nickname: string; connected: boolean }[];
  squares: PublicSquare[];
  log: LogItem[];
  chat: ChatItem[];
}
