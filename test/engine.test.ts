import { describe, expect, test } from 'vitest';
import { SQUARES } from '../src/game/content';
import {
  apply,
  autoStep,
  computeRent,
  createRoomState,
  jailBail,
  makePlayer,
  makeRng,
  marketDelta,
  marketQuote,
  pickLiquidation,
  startGame,
  updateRules,
} from '../src/game/engine';
import type { GameAction, Player, PropertyRent, RailRent, RoomState } from '../src/game/types';

const COLORS = ['#e24b4b', '#3b6cff', '#2f9e6b', '#e6b325'];

function boot(names = ['甲', '乙'], rules?: Partial<RoomState['rules']>) {
  const state = createRoomState('AB234', '');
  if (rules) Object.assign(state.rules, rules);
  const players = names.map((nickname, i) => {
    const player = makePlayer(`p${i}`, nickname, `tok${i}`, COLORS[i] ?? '#333', 'pebble', i === 0);
    state.players.push(player);
    return player;
  });
  const started = startGame(state, players[0]!.id, makeRng());
  if (started) throw new Error(started);
  return { state, A: players[0]!, B: players[1]!, players };
}

function setTurn(state: RoomState, player: Player) {
  state.status = 'playing';
  state.currentPlayerId = player.id;
  state.phase = 'await_roll';
  state.rollAgain = false;
  state.debt = null;
  state.pendingBuy = null;
  state.trade = null;
  state.auction = null;
  state.landedOn = null;
  state.bail = null;
  player.inJail = false;
  player.bankrupt = false;
}

function give(state: RoomState, player: Player, indices: number[]) {
  for (const index of indices) state.ownership[index] = { ownerId: player.id, houses: 0, mortgaged: false };
}

function act(state: RoomState, id: string, action: GameAction, dice?: number[], units?: number[]) {
  return apply(state, id, action, makeRng({ dice, units }));
}

function rentOf(index: number): PropertyRent {
  const rent = SQUARES[index]?.rent;
  if (!rent || !('base' in rent)) throw new Error(`第 ${index} 格不是可建地产`);
  return rent;
}

describe('监狱', () => {
  test('停在监狱后马上选择，交保释则下一回合照常且继续收租', () => {
    const { state, A, B } = boot();
    give(state, A, [1]);
    setTurn(state, A);
    A.position = 18;
    const cash = A.cash;
    expect(act(state, A.id, { type: 'roll' }, [2])).toEqual({ ok: true });
    expect(A.position).toBe(20);
    expect(SQUARES[20]?.name).toBe('监狱');
    expect(state.phase).toBe('await_jail');
    expect(A.inJail).toBe(false);
    expect(state.rollAgain).toBe(false);
    expect(state.bail?.amount).toBe(50);
    expect(state.bail?.name).toBe('老城南巷');
    expect(state.bail?.floored).toBe(true);
    expect(state.bail?.detail).toMatch(/下限/);
    expect(act(state, A.id, { type: 'payJail' })).toEqual({ ok: true });
    expect(A.cash).toBe(cash - 50);
    expect(state.pot).toBe(0);
    expect(A.inJail).toBe(false);
    expect(state.currentPlayerId).toBe(B.id);
    expect(state.phase).toBe('await_roll');

    B.position = 38;
    const beforeA = A.cash;
    expect(act(state, B.id, { type: 'roll' }, [3])).toEqual({ ok: true });
    expect(B.position).toBe(1);
    expect(A.cash).toBe(beforeA + rentOf(1).base);
  });

  test('选择跳过下一回合时，停走期间不收租，跳过之后恢复', () => {
    const { state, A, B } = boot();
    give(state, A, [1]);
    setTurn(state, A);
    A.position = 18;
    expect(act(state, A.id, { type: 'roll' }, [2])).toEqual({ ok: true });
    expect(act(state, A.id, { type: 'skipJail' })).toEqual({ ok: true });
    expect(A.inJail).toBe(true);
    expect(state.currentPlayerId).toBe(B.id);

    const beforeA = A.cash;
    B.position = 38;
    expect(act(state, B.id, { type: 'roll' }, [3])).toEqual({ ok: true });
    expect(B.position).toBe(1);
    expect(A.cash).toBe(beforeA);
    expect(computeRent(state, 1)).toBe(0);

    expect(act(state, B.id, { type: 'end' })).toEqual({ ok: true });
    expect(A.inJail).toBe(false);
    expect(state.currentPlayerId).toBe(B.id);
    expect(state.log.some((item) => item.text.includes('跳过这一回合'))).toBe(true);

    B.position = 38;
    expect(act(state, B.id, { type: 'roll' }, [3])).toEqual({ ok: true });
    expect(A.cash).toBe(beforeA + rentOf(1).base);
  });

  test('没有地产时保释金是 50，最高过路费按 1.5 倍向上取整', () => {
    const { state, A } = boot();
    setTurn(state, A);
    A.position = 18;
    expect(jailBail(state).amount).toBe(50);
    expect(act(state, A.id, { type: 'roll' }, [2])).toEqual({ ok: true });
    expect(state.bail?.detail).toMatch(/没有能收租/);
    expect(act(state, A.id, { type: 'skipJail' })).toEqual({ ok: true });

    give(state, A, [39]);
    state.ownership[39]!.houses = 4;
    const quote = jailBail(state);
    expect(SQUARES[39]?.name).toBe('北京天安门');
    expect(quote.rent).toBe(rentOf(39).fourHouses);
    expect(quote.amount).toBe(Math.ceil(rentOf(39).fourHouses * 1.5));
    expect(quote.floored).toBe(false);
    expect(quote.detail).toMatch(/天安门/);
  });

  test('现金不够就不能交保释', () => {
    const state = createRoomState('AB234', '');
    const host = makePlayer('a', '甲', 'ta', COLORS[0]!, 'pebble', true);
    const guest = makePlayer('b', '乙', 'tb', COLORS[1]!, 'tile', false);
    state.players.push(host, guest);
    expect(updateRules(state, host.id, { startingMoney: 2000 }, null)).toBeNull();
    expect(startGame(state, host.id, makeRng())).toBeNull();
    setTurn(state, host);
    host.position = 18;
    host.cash = 10;
    expect(act(state, host.id, { type: 'roll' }, [2])).toEqual({ ok: true });
    expect(act(state, host.id, { type: 'payJail' }).error).toMatch(/现金不足/);
    expect(host.inJail).toBe(false);
    expect(act(state, host.id, { type: 'skipJail' })).toEqual({ ok: true });
    expect(host.inJail).toBe(true);
    expect(host.cash).toBe(10);
  });

  test('掷出 6 必须再掷，连续三次也不会进监狱', () => {
    const { state, A } = boot(undefined, { auction: false });
    setTurn(state, A);
    A.position = 0;
    expect(act(state, A.id, { type: 'roll' }, [6])).toEqual({ ok: true });
    expect(A.position).toBe(6);
    expect(state.phase).toBe('await_buy');
    expect(act(state, A.id, { type: 'decline' })).toEqual({ ok: true });
    expect(state.rollAgain).toBe(true);
    expect(act(state, A.id, { type: 'end' }).error).toMatch(/再掷/);
    expect(act(state, A.id, { type: 'roll' }, [6])).toEqual({ ok: true });
    expect(A.position).toBe(12);
    expect(act(state, A.id, { type: 'decline' })).toEqual({ ok: true });
    expect(act(state, A.id, { type: 'roll' }, [6])).toEqual({ ok: true });
    expect(A.position).toBe(18);
    expect(A.inJail).toBe(false);
    expect(act(state, A.id, { type: 'decline' })).toEqual({ ok: true });
    expect(act(state, A.id, { type: 'roll' }, [1])).toEqual({ ok: true });
    expect(A.position).toBe(19);
    expect(state.rollAgain).toBe(false);
  });

  test('掷出 6 停在监狱就不再连掷', () => {
    const { state, A } = boot();
    setTurn(state, A);
    A.position = 14;
    expect(act(state, A.id, { type: 'roll' }, [6])).toEqual({ ok: true });
    expect(A.position).toBe(20);
    expect(state.phase).toBe('await_jail');
    expect(state.rollAgain).toBe(false);
  });

  test('路过别人的地产不交租，只有停下才交', () => {
    const { state, A, B } = boot();
    give(state, A, [1]);
    setTurn(state, B);
    B.position = 0;
    const beforeA = A.cash;
    expect(act(state, B.id, { type: 'roll' }, [4])).toEqual({ ok: true });
    expect(B.position).toBe(4);
    expect(A.cash).toBe(beforeA);
    expect(state.phase).toBe('await_buy');
    expect(state.pendingBuy).toBe(4);
  });
});

describe('租金与购买', () => {
  test('经过起点先领薪水，再按基础租金支付', () => {
    const { state, A, B } = boot();
    give(state, A, [1]);
    setTurn(state, B);
    B.position = 39;
    const beforeA = A.cash;
    const beforeB = B.cash;
    expect(act(state, B.id, { type: 'roll' }, [2])).toEqual({ ok: true });
    expect(B.position).toBe(1);
    expect(B.cash).toBe(beforeB + state.rules.goSalary - rentOf(1).base);
    expect(A.cash).toBe(beforeA + rentOf(1).base);
  });

  test('租金只看这块地的房屋，凑齐同色也不翻倍', () => {
    const { state, A, B } = boot();
    give(state, A, [1, 2, 3, 4]);
    expect(computeRent(state, 2)).toBe(rentOf(2).base);
    state.ownership[2]!.houses = 1;
    expect(computeRent(state, 2)).toBe(rentOf(2).oneHouse);
    setTurn(state, B);
    B.position = 0;
    expect(act(state, B.id, { type: 'roll' }, [2])).toEqual({ ok: true });
    expect(B.position).toBe(2);
    expect(B.cash).toBe(1500 - rentOf(2).oneHouse);
  });

  test('铁路租金随条数增加，抵押的那条不收租', () => {
    const { state, A } = boot();
    give(state, A, [5, 15, 25, 35]);
    const rent = SQUARES[5]?.rent as RailRent;
    expect(computeRent(state, 5)).toBe(rent.owned4);
    state.ownership[5]!.mortgaged = true;
    expect(computeRent(state, 5)).toBe(0);
  });

  test('不拍卖时放弃购买，地产留给银行', () => {
    const { state, A } = boot(undefined, { auction: false });
    setTurn(state, A);
    A.position = 0;
    expect(act(state, A.id, { type: 'roll' }, [4])).toEqual({ ok: true });
    expect(state.pendingBuy).toBe(4);
    expect(act(state, A.id, { type: 'decline' })).toEqual({ ok: true });
    expect(state.ownership[4]?.ownerId).toBeNull();
    expect(state.phase).toBe('await_manage');
  });
});

describe('交易所', () => {
  test('种子随机数的涨跌分布接近 1/4、1/8、3/8、1/4', () => {
    const rng = makeRng({ seed: 20261115 });
    const counts = { limit_up: 0, bull: 0, limit_down: 0, bear: 0 };
    const total = 8000;
    for (let i = 0; i < total; i += 1) counts[marketQuote(rng.unit()).code] += 1;
    expect(counts.limit_up / total).toBeCloseTo(0.25, 1);
    expect(counts.bull / total).toBeCloseTo(0.125, 1);
    expect(counts.limit_down / total).toBeCloseTo(0.375, 1);
    expect(counts.bear / total).toBeCloseTo(0.25, 1);
  });

  test('亏损进银行，不进奖池', () => {
    expect(marketDelta(1000, marketQuote(0))).toBe(100);
    expect(marketDelta(1000, marketQuote(0.3))).toBe(200);
    expect(marketDelta(1000, marketQuote(0.5))).toBe(-100);
    expect(marketDelta(15, marketQuote(0))).toBe(2);
    expect(marketDelta(0, marketQuote(0))).toBe(0);

    const { state, A } = boot();
    setTurn(state, A);
    A.position = 8;
    A.cash = 1000;
    expect(act(state, A.id, { type: 'roll' }, [2], [0.9])).toEqual({ ok: true });
    expect(A.position).toBe(10);
    expect(SQUARES[10]?.name).toBe('上交所');
    expect(SQUARES[20]?.name).toBe('监狱');
    expect(state.market?.title).toBe('熊市');
    expect(state.market?.delta).toBe(-200);
    expect(A.cash).toBe(800);
    expect(state.pot).toBe(0);
  });

  test('现金不大于 0 时行情没有变化', () => {
    const { state, A } = boot();
    setTurn(state, A);
    A.position = 28;
    A.cash = 0;
    expect(act(state, A.id, { type: 'roll' }, [2], [0])).toEqual({ ok: true });
    expect(A.position).toBe(30);
    expect(SQUARES[30]?.name).toBe('深交所');
    expect(A.cash).toBe(0);
    expect(state.market).toBeNull();
  });
});

describe('建房、抵押和交易', () => {
  test('只有刚停在自己地上才能升一级', () => {
    const { state, A } = boot();
    give(state, A, [1, 2]);
    setTurn(state, A);
    expect(act(state, A.id, { type: 'build', square: 1 }).error).toMatch(/停下之后/);
    A.position = 39;
    expect(act(state, A.id, { type: 'roll' }, [2])).toEqual({ ok: true });
    expect(A.position).toBe(1);
    expect(state.landedOn).toBe(1);
    const cost = SQUARES[1]?.houseCost ?? 0;
    const cash = A.cash;
    expect(act(state, A.id, { type: 'build', square: 1 })).toEqual({ ok: true });
    expect(state.ownership[1]?.houses).toBe(1);
    expect(A.cash).toBe(cash - cost);
    expect(act(state, A.id, { type: 'build', square: 1 }).error).toMatch(/刚停下/);
    expect(act(state, A.id, { type: 'build', square: 2 }).error).toMatch(/刚停下/);
  });

  test('有房子的地可以抵押，房子留下，抵押期间不收租', () => {
    const { state, A, B } = boot();
    give(state, A, [1]);
    state.ownership[1]!.houses = 2;
    setTurn(state, A);
    const mortgage = SQUARES[1]?.mortgage ?? 0;
    const cash = A.cash;
    expect(act(state, A.id, { type: 'mortgage', square: 1 })).toEqual({ ok: true });
    expect(state.ownership[1]?.houses).toBe(2);
    expect(state.ownership[1]?.mortgaged).toBe(true);
    expect(A.cash).toBe(cash + mortgage);
    expect(computeRent(state, 1)).toBe(0);
    expect(act(state, A.id, { type: 'build', square: 1 }).error).toBeTruthy();
    const redeem = SQUARES[1]?.unmortgageCost ?? 0;
    expect(act(state, A.id, { type: 'unmortgage', square: 1 })).toEqual({ ok: true });
    expect(A.cash).toBe(cash + mortgage - redeem);
    expect(state.pot).toBe(0);
    setTurn(state, B);
    B.position = 39;
    const beforeA = A.cash;
    expect(act(state, B.id, { type: 'roll' }, [2])).toEqual({ ok: true });
    expect(A.cash).toBe(beforeA + rentOf(1).twoHouses);
  });

  test('对方只能改现金，发起方不能再还价', () => {
    const { state, A, B } = boot();
    give(state, A, [1]);
    give(state, B, [2]);
    state.ownership[1]!.houses = 2;
    setTurn(state, A);
    expect(act(state, A.id, { type: 'trade', toId: B.id, offerCash: 0, offerSquares: [1], requestSquares: [2] })).toEqual({ ok: true });
    expect(act(state, B.id, { type: 'tradeCounter', cash: 40 })).toEqual({ ok: true });
    expect(state.trade?.stage).toBe('counter');
    expect(state.trade?.offerSquares).toEqual([1]);
    expect(state.trade?.requestSquares).toEqual([2]);
    expect(act(state, A.id, { type: 'tradeCounter', cash: 10 }).error).toMatch(/不能改价/);
    const cashA = A.cash;
    const cashB = B.cash;
    expect(act(state, A.id, { type: 'tradeAnswer', accept: true })).toEqual({ ok: true });
    expect(state.ownership[1]?.ownerId).toBe(B.id);
    expect(state.ownership[1]?.houses).toBe(2);
    expect(state.ownership[2]?.ownerId).toBe(A.id);
    expect(A.cash).toBe(cashA - 40);
    expect(B.cash).toBe(cashB + 40);
  });

  test('四栋是最高，租金用四栋那一档', () => {
    const { state, A } = boot();
    give(state, A, [1]);
    state.ownership[1]!.houses = 4;
    setTurn(state, A);
    A.position = 39;
    expect(act(state, A.id, { type: 'roll' }, [2])).toEqual({ ok: true });
    expect(act(state, A.id, { type: 'build', square: 1 }).error).toMatch(/四栋/);
    expect(state.ownership[1]?.houses).toBe(4);
    expect(computeRent(state, 1)).toBe(rentOf(1).fourHouses);
  });
});

describe('还债卖地', () => {
  test('现金不够付租时整块卖给银行，房子不另算钱', () => {
    const { state, A, B } = boot();
    give(state, A, [2]);
    give(state, B, [4]);
    state.ownership[4]!.houses = 2;
    setTurn(state, B);
    B.position = 0;
    B.cash = 1;
    expect(act(state, B.id, { type: 'roll' }, [2])).toEqual({ ok: true });
    expect(B.position).toBe(2);
    expect(state.phase).toBe('await_debt');
    expect(act(state, B.id, { type: 'sell', square: 4 }).error).toMatch(/卖给银行/);
    expect(act(state, B.id, { type: 'mortgage', square: 4 }).error).toMatch(/卖给银行/);
    expect(act(state, B.id, { type: 'bankrupt' }).error).toMatch(/还有地/);
    expect(act(state, B.id, { type: 'liquidate', square: 4 })).toEqual({ ok: true });
    expect(state.ownership[4]?.ownerId).toBeNull();
    expect(state.ownership[4]?.houses).toBe(0);
    expect(B.cash).toBe(77);
    expect(A.cash).toBe(1504);
    expect(state.phase).not.toBe('await_debt');
  });

  test('卖一块仍不够就继续选，没地了才破产', () => {
    const { state, A, B } = boot();
    give(state, A, [39]);
    state.ownership[39]!.houses = 4;
    give(state, B, [1, 4]);
    setTurn(state, B);
    B.position = 37;
    B.cash = 0;
    expect(act(state, B.id, { type: 'roll' }, [2])).toEqual({ ok: true });
    expect(state.debt?.amount).toBe(rentOf(39).fourHouses);
    expect(act(state, B.id, { type: 'liquidate', square: 1 })).toEqual({ ok: true });
    expect(B.cash).toBe(60);
    expect(B.bankrupt).toBe(false);
    expect(state.phase).toBe('await_debt');
    expect(state.ownership[4]?.ownerId).toBe(B.id);
    expect(act(state, B.id, { type: 'liquidate', square: 4 })).toEqual({ ok: true });
    expect(B.bankrupt).toBe(true);
    expect(state.ownership[1]?.ownerId).toBeNull();
    expect(state.ownership[4]?.ownerId).toBeNull();
    expect(A.cash).toBe(1500 + 140);
  });

  test('抵押的地到手是地价减去未还抵押款', () => {
    const { state, A, B } = boot();
    give(state, A, [2]);
    give(state, B, [1]);
    state.ownership[1]!.mortgaged = true;
    state.ownership[1]!.houses = 3;
    setTurn(state, B);
    B.position = 0;
    B.cash = 0;
    expect(act(state, B.id, { type: 'roll' }, [2])).toEqual({ ok: true });
    expect(act(state, B.id, { type: 'liquidate', square: 1 })).toEqual({ ok: true });
    expect(state.ownership[1]?.ownerId).toBeNull();
    expect(state.ownership[1]?.houses).toBe(0);
    expect(state.ownership[1]?.mortgaged).toBe(false);
    expect(B.cash).toBe(26);
    expect(A.cash).toBe(1504);
  });

  test('没有地可卖时直接破产', () => {
    const { state, A, B } = boot();
    give(state, A, [2]);
    setTurn(state, B);
    B.position = 0;
    B.cash = 0;
    expect(act(state, B.id, { type: 'roll' }, [2])).toEqual({ ok: true });
    expect(B.bankrupt).toBe(true);
    expect(state.status).toBe('finished');
  });

  test('托管卖到手最少且够用的地，没有就卖到手最多的', () => {
    const { state, A, B } = boot();
    give(state, A, [2]);
    give(state, B, [1, 4, 6]);
    setTurn(state, B);
    B.position = 0;
    B.cash = 0;
    expect(act(state, B.id, { type: 'roll' }, [2])).toEqual({ ok: true });
    expect(pickLiquidation(state, B)).toBe(1);
    state.debt!.amount = 90;
    expect(pickLiquidation(state, B)).toBe(6);
    state.debt!.amount = 500;
    expect(pickLiquidation(state, B)).toBe(6);
    state.ownership[6]!.mortgaged = true;
    expect(pickLiquidation(state, B)).toBe(4);
    state.debt!.amount = 4;
    state.ownership[6]!.mortgaged = false;
    expect(autoStep(state, makeRng())).toBe(true);
    expect(state.ownership[1]?.ownerId).toBeNull();
    expect(state.ownership[4]?.ownerId).toBe(B.id);
    expect(state.phase).not.toBe('await_debt');
  });
});
