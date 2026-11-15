import { DurableObject } from 'cloudflare:workers';
import { SETTINGS } from './game/content';
import { adminEndGame, apply, autoStep, autoplayDue, createRoomState, idleCleanupAt, kickPlayer, makePlayer, makeRng, maybeTransferHost, nextWakeAt, project, resolveAuction, setAppearance, startGame, touchHost, updateRules } from './game/engine';
import type { Env } from './env';
import { deleteRoom, summarize, upsertRoom } from './registry';
import type { GameAction, RoomRules, RoomState } from './game/types';

interface Att {
  joined: boolean;
  roomCode: string;
  actorId?: string;
  role?: 'player' | 'spectator';
}

const NICK_RE = /^[\u4e00-\u9fa5A-Za-z0-9_\u00B7]{1,8}$/;
/** 管理员删除房间、请人离开时，给客户端的关闭码。客户端看到这两个码就回首页，不再自动重连。 */
const CLOSE_DELETED = 4001;
const CLOSE_KICKED = 4003;

export class Room extends DurableObject<Env> {
  /** 上一次写进登记表的摘要和时间，用来少写几次。 */
  private registered = '';
  private registeredAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/admin/')) return this.handleAdmin(request, path.slice('/admin/'.length));
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('需要 WebSocket', { status: 426 });
    }
    const roomCode = new URL(request.url).searchParams.get('room')?.toUpperCase() ?? '';
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ joined: false, roomCode } satisfies Att);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') return;
    if (raw.length > 8000) {
      this.fail(ws, '消息太长');
      return;
    }
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object') throw new Error('not object');
      msg = parsed as Record<string, unknown>;
    } catch {
      this.fail(ws, '消息无法解析');
      return;
    }
    try {
      const att = (ws.deserializeAttachment() as Att | null) ?? { joined: false, roomCode: '' };
      let state = this.load();
      if (state) this.presence(state);
      if (state && msg.type !== 'sync') state.lastActiveAt = Date.now();

      if (msg.type === 'join') {
        this.handleJoin(ws, att, state, msg);
        return;
      }
      if (!state || !att.joined || !att.actorId) {
        this.fail(ws, '请先加入房间');
        return;
      }
      if (msg.type === 'sync') {
        this.send(ws, { type: 'state', state: project(state, att.actorId) });
        return;
      }
      if (msg.type === 'chat') {
        this.handleChat(state, att, msg);
        return;
      }
      if (msg.type === 'settings') {
        this.handleSettings(ws, state, att, msg);
        return;
      }
      if (msg.type === 'appearance') {
        this.handleAppearance(ws, state, att, msg);
        return;
      }
      if (msg.type === 'start') {
        if (att.role !== 'player') {
          this.fail(ws, '观战者不能开始游戏');
          return;
        }
        const draft = structuredClone(state);
        const err = startGame(draft, att.actorId, makeRng());
        if (err) {
          this.fail(ws, err);
          return;
        }
        this.presence(draft);
        this.persist(draft);
        return;
      }
      const action = parseAction(msg);
      if (!action) {
        this.fail(ws, '无法识别这个操作');
        return;
      }
      if (att.role !== 'player') {
        this.fail(ws, '观战者不能操作棋子');
        return;
      }
      const draft = structuredClone(state);
      let result: { ok: boolean; error?: string };
      try {
        result = apply(draft, att.actorId, action, makeRng());
      } catch (err) {
        console.error(err);
        this.fail(ws, '这步没能完成');
        return;
      }
      if (!result.ok) {
        this.fail(ws, result.error || '现在不能这么做');
        return;
      }
      this.presence(draft);
      this.persist(draft);
    } catch (err) {
      console.error(err);
      this.fail(ws, '房间暂时出了问题');
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const state = this.load();
    if (!state) return;
    this.presence(state, ws);
    this.persist(state);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'error');
    } catch {
      /* already closing */
    }
  }

  override async alarm(): Promise<void> {
    const state = this.load();
    if (!state) return;
    const now = Date.now();
    if (now >= idleCleanupAt(state)) {
      console.log(`room ${state.roomCode} idle, removing`);
      await this.wipe(state.roomCode, CLOSE_DELETED, '房间太久没人动，已经自动删除');
      return;
    }
    this.presence(state);
    let changed = resolveAuction(state, now);
    if (maybeTransferHost(state, now)) changed = true;
    const current = state.players.find((p) => p.id === state.currentPlayerId);
    if (current && autoplayDue(state, now)) {
      const target = current.id;
      const rng = makeRng();
      try {
        for (let step = 0; step < 80; step += 1) {
          if (!stillPlaying(state) || state.currentPlayerId !== target) break;
          if (!autoStep(state, rng)) break;
        }
      } catch (err) {
        console.error('autoplay failed', err);
      }
      this.presence(state);
      changed = true;
    }
    if (changed) {
      this.save(state);
      this.broadcast(state);
    } else {
      this.register(state);
    }
    await this.arm(state);
  }

  /** 管理接口，只有 Worker 校验过密钥后才会转到这里。 */
  private async handleAdmin(request: Request, action: string): Promise<Response> {
    const state = this.load();
    const code = new URL(request.url).searchParams.get('room')?.toUpperCase() ?? '';
    if (action === 'delete') {
      await this.wipe(state?.roomCode || code, CLOSE_DELETED, '房间已被管理员删除');
      return Response.json({ ok: true });
    }
    if (!state) {
      if (code) this.ctx.waitUntil(deleteRoom(this.env.DB, code).catch((err) => console.error('registry delete failed', err)));
      return Response.json({ ok: false, error: '这个房间没有存档' }, { status: 404 });
    }
    if (action === 'state') {
      this.presence(state);
      return Response.json({ ok: true, room: adminView(state) });
    }
    if (request.method !== 'POST') return Response.json({ ok: false, error: '请用 POST' }, { status: 405 });
    if (action === 'end') {
      this.presence(state);
      const err = adminEndGame(state);
      if (err) return Response.json({ ok: false, error: err }, { status: 409 });
      this.persist(state);
      return Response.json({ ok: true, room: adminView(state) });
    }
    if (action === 'kick') {
      const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
      const id = typeof body?.id === 'string' ? body.id : '';
      this.presence(state);
      const err = kickPlayer(state, id);
      if (err) return Response.json({ ok: false, error: err }, { status: 409 });
      for (const sock of this.ctx.getWebSockets()) {
        const att = sock.deserializeAttachment() as Att | null;
        if (att?.actorId !== id) continue;
        this.send(sock, { type: 'kicked', message: '你被管理员移出了房间' });
        try {
          sock.close(CLOSE_KICKED, 'kicked');
        } catch {
          /* already gone */
        }
      }
      this.presence(state);
      this.persist(state);
      return Response.json({ ok: true, room: adminView(state) });
    }
    return Response.json({ ok: false, error: '不认识这个操作' }, { status: 404 });
  }

  /** 断开所有人、清空存档和闹钟，再从登记表里去掉。 */
  private async wipe(code: string, closeCode: number, message: string): Promise<void> {
    for (const sock of this.ctx.getWebSockets()) {
      this.send(sock, { type: 'kicked', message });
      try {
        sock.close(closeCode, 'removed');
      } catch {
        /* already gone */
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.ensureSchema();
    this.registered = '';
    if (code) {
      try {
        await deleteRoom(this.env.DB, code);
      } catch (err) {
        console.error('registry delete failed', err);
      }
    }
  }

  /** 把房间摘要写进登记表。摘要没变时十分钟最多写一次。 */
  private register(state: RoomState): void {
    if (!this.env.DB) return;
    const now = Date.now();
    const sig = JSON.stringify(summarize(state));
    if (sig === this.registered && now - this.registeredAt < 10 * 60_000) return;
    this.registered = sig;
    this.registeredAt = now;
    this.ctx.waitUntil(
      upsertRoom(this.env.DB, this.ctx.id.toString(), state, now).catch((err) => {
        this.registered = '';
        console.error('registry write failed', err);
      }),
    );
  }

  private handleJoin(ws: WebSocket, att: Att, state: RoomState | null, msg: Record<string, unknown>): void {
    if (att.joined && att.actorId && state) {
      this.send(ws, { type: 'state', state: project(state, att.actorId) });
      return;
    }
    const token = typeof msg.token === 'string' ? msg.token.slice(0, 80) : '';
    const nickname = cleanName(msg.nickname);
    const password = cleanPassword(msg.password);
    const roomCode = att.roomCode;
    if (!roomCode) {
      this.fail(ws, '房间号无效');
      return;
    }

    if (state && token) {
      const player = state.players.find((p) => p.token === token);
      if (player) {
        const back = !player.connected;
        this.commit(ws, state, player.id, 'player', player.token, player.nickname, back ? `${player.nickname} 回到了座位` : null);
        return;
      }
      const spectator = state.spectators.find((s) => s.token === token);
      if (spectator) {
        const back = !spectator.connected;
        this.commit(ws, state, spectator.id, 'spectator', spectator.token, spectator.nickname, back ? `${spectator.nickname} 回到了观战` : null);
        return;
      }
    }

    if (!nickname) {
      this.fail(ws, '昵称请用 1 到 8 位中文、字母或数字');
      return;
    }

    if (!state) {
      if (!password) {
        this.fail(ws, '创建房间要设一个密码');
        return;
      }
      const created = createRoomState(roomCode, password);
      const player = makePlayer(newId('p'), nickname, newId(''), SETTINGS.playerColors[0]?.hex ?? '#e24b4b', SETTINGS.avatars[0]?.id ?? 'pebble', true);
      created.players.push(player);
      this.commit(ws, created, player.id, 'player', player.token, player.nickname, `${nickname} 创建了房间`);
      return;
    }

    if (state.password !== password) {
      this.fail(ws, '房间密码不正确');
      return;
    }
    if (state.players.some((p) => p.nickname === nickname) || state.spectators.some((s) => s.nickname === nickname)) {
      this.fail(ws, '该昵称已在房间里。掉线的话，请用原来的浏览器重新进入');
      return;
    }

    const seatOpen = state.status === 'lobby' && state.players.length < state.rules.maxPlayers;
    if (!seatOpen) {
      if (state.status === 'lobby') {
        this.fail(ws, `房间已满（最多 ${state.rules.maxPlayers} 人）`);
        return;
      }
      if (state.spectators.length >= 12) {
        this.fail(ws, '观战人数已满');
        return;
      }
      const spectator = { id: newId('s'), nickname, token: newId(''), connected: false };
      state.spectators.push(spectator);
      this.commit(ws, state, spectator.id, 'spectator', spectator.token, nickname, `${nickname} 开始观战`);
      return;
    }

    const player = makePlayer(newId('p'), nickname, newId(''), nextColor(state), nextAvatar(state), false);
    state.players.push(player);
    this.commit(ws, state, player.id, 'player', player.token, nickname, `${nickname} 加入了房间`);
  }

  private handleChat(state: RoomState, att: Att, msg: Record<string, unknown>): void {
    const text = typeof msg.text === 'string' ? msg.text.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    if (!text || !att.actorId) return;
    const from =
      state.players.find((p) => p.id === att.actorId)?.nickname ??
      state.spectators.find((s) => s.id === att.actorId)?.nickname;
    if (!from) return;
    state.chatSeq += 1;
    state.chat.push({ n: state.chatSeq, from, text, ts: Date.now() });
    if (state.chat.length > 60) state.chat.splice(0, state.chat.length - 60);
    state.seq += 1;
    this.persist(state);
  }

  private commit(
    ws: WebSocket,
    state: RoomState,
    actorId: string,
    role: 'player' | 'spectator',
    token: string,
    nickname: string,
    announce: string | null,
  ): void {
    const previous = this.ctx.getWebSockets().filter((sock) => {
      if (sock === ws) return false;
      const att = sock.deserializeAttachment() as Att | null;
      return att?.actorId === actorId;
    });
    ws.serializeAttachment({ joined: true, roomCode: state.roomCode, actorId, role } satisfies Att);
    state.lastActiveAt = Date.now();
    this.presence(state);
    touchHost(state, Date.now());
    if (announce) this.note(state, announce);
    else state.seq += 1;
    this.save(state);
    this.send(ws, { type: 'welcome', playerId: actorId, token, role, nickname, roomCode: state.roomCode });
    this.broadcast(state);
    for (const prev of previous) {
      try {
        prev.close(4000, 'replaced');
      } catch {
        /* already gone */
      }
    }
    void this.arm(state);
  }

  private persist(state: RoomState): void {
    this.save(state);
    this.broadcast(state);
    void this.arm(state);
  }

  private async arm(state: RoomState): Promise<void> {
    const at = nextWakeAt(state, Date.now());
    if (at != null) await this.ctx.storage.setAlarm(at);
    else await this.ctx.storage.deleteAlarm();
  }

  private handleSettings(ws: WebSocket, state: RoomState, att: Att, msg: Record<string, unknown>): void {
    if (att.role !== 'player' || !att.actorId) {
      this.fail(ws, '观战者不能改规则');
      return;
    }
    const rules = readRules(msg.rules);
    if (!rules) {
      this.fail(ws, '规则格式不对');
      return;
    }
    const password = typeof msg.password === 'string' ? msg.password : null;
    const draft = structuredClone(state);
    const err = updateRules(draft, att.actorId, rules, password);
    if (err) {
      this.fail(ws, err);
      return;
    }
    this.presence(draft);
    touchHost(draft, Date.now());
    this.persist(draft);
  }

  private handleAppearance(ws: WebSocket, state: RoomState, att: Att, msg: Record<string, unknown>): void {
    if (att.role !== 'player' || !att.actorId) {
      this.fail(ws, '观战者没有棋子');
      return;
    }
    if (typeof msg.color !== 'string' || typeof msg.avatar !== 'string') {
      this.fail(ws, '棋子格式不对');
      return;
    }
    const draft = structuredClone(state);
    const err = setAppearance(draft, att.actorId, msg.color, msg.avatar);
    if (err) {
      this.fail(ws, err);
      return;
    }
    this.presence(draft);
    touchHost(draft, Date.now());
    this.persist(draft);
  }

  private presence(state: RoomState, except?: WebSocket): void {
    const live = new Set<string>();
    for (const sock of this.ctx.getWebSockets()) {
      if (except && sock === except) continue;
      const att = sock.deserializeAttachment() as Att | null;
      if (att?.joined && att.actorId) live.add(att.actorId);
    }
    for (const player of state.players) player.connected = live.has(player.id);
    for (const spectator of state.spectators) spectator.connected = live.has(spectator.id);
    touchHost(state, Date.now());
  }

  private broadcast(state: RoomState): void {
    for (const sock of this.ctx.getWebSockets()) {
      const att = sock.deserializeAttachment() as Att | null;
      if (!att?.joined || !att.actorId) continue;
      this.send(sock, { type: 'state', state: project(state, att.actorId) });
    }
  }

  private note(state: RoomState, text: string): void {
    state.logSeq += 1;
    state.log.push({ n: state.logSeq, text, ts: Date.now(), kind: 'info' });
    if (state.log.length > 80) state.log.splice(0, state.log.length - 80);
    state.seq += 1;
  }

  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS room_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL
    )`);
  }

  private load(): RoomState | null {
    const rows = this.ctx.storage.sql.exec<{ json: string }>('SELECT json FROM room_state WHERE id = 1').toArray();
    const json = rows[0]?.json;
    if (!json) return null;
    try {
      const parsed = JSON.parse(json) as RoomState & { trade?: unknown };
      if (parsed.v !== 5) return null;
      // 旧版本留下的交易字段：交易已经取消，读进来时丢掉。
      delete parsed.trade;
      if (parsed.auction) {
        parsed.auction.sellerId = parsed.auction.sellerId ?? null;
        parsed.auction.minBid = parsed.auction.minBid ?? 1;
      }
      return parsed;
    } catch (err) {
      console.error('bad room json', err);
      return null;
    }
  }

  private save(state: RoomState): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO room_state (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
      JSON.stringify(state),
    );
    this.register(state);
  }

  private fail(ws: WebSocket, message: string): void {
    this.send(ws, { type: 'error', message });
  }

  private send(ws: WebSocket, payload: unknown): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* socket already closed */
    }
  }
}

/** 管理页看到的房间详情。去掉令牌，其余照实给。 */
function adminView(state: RoomState) {
  return {
    roomCode: state.roomCode,
    password: state.password,
    status: state.status,
    phase: state.phase,
    rules: state.rules,
    createdAt: state.createdAt,
    lastActiveAt: state.lastActiveAt ?? state.createdAt,
    turnIndex: state.turnIndex,
    currentPlayerId: state.currentPlayerId,
    winnerId: state.winnerId,
    players: state.players.map((p) => ({
      id: p.id,
      nickname: p.nickname,
      color: p.color,
      cash: p.cash,
      position: p.position,
      bankrupt: p.bankrupt,
      inJail: p.inJail,
      connected: p.connected,
      isHost: p.isHost,
      lots: state.ownership.flatMap((own, index) =>
        own.ownerId === p.id ? [{ index, houses: own.houses, mortgaged: own.mortgaged }] : [],
      ),
    })),
    spectators: state.spectators.map((s) => ({ id: s.id, nickname: s.nickname, connected: s.connected })),
    log: state.log.slice(-30),
  };
}

function stillPlaying(state: RoomState): boolean {
  return state.status === 'playing' && state.phase !== 'finished';
}

function parseAction(msg: Record<string, unknown>): GameAction | null {
  switch (msg.type) {
    case 'roll':
    case 'buy':
    case 'decline':
    case 'end':
    case 'payJail':
    case 'skipJail':
    case 'bankrupt':
    case 'pass':
      return { type: msg.type };
    case 'bid':
      if (typeof msg.amount !== 'number' || !Number.isInteger(msg.amount)) return null;
      return { type: 'bid', amount: msg.amount };
    case 'build':
    case 'sell':
    case 'liquidate':
    case 'mortgage':
    case 'unmortgage':
    case 'auctionOwn':
      if (typeof msg.square !== 'number' || !Number.isInteger(msg.square)) return null;
      return { type: msg.type, square: msg.square };
    default:
      return null;
  }
}

function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF\s]+/g, '').slice(0, 8);
  return NICK_RE.test(text) ? text : '';
}

function cleanPassword(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.slice(0, 16);
}

function nextColor(state: RoomState): string {
  const used = new Set(state.players.map((p) => p.color));
  const found = SETTINGS.playerColors.find((color) => !used.has(color.hex));
  return (found ?? SETTINGS.playerColors[state.players.length % SETTINGS.playerColors.length] ?? { hex: '#e24b4b' }).hex;
}

function nextAvatar(state: RoomState): string {
  const used = new Set(state.players.map((p) => p.avatar));
  const found = SETTINGS.avatars.find((avatar) => !used.has(avatar.id));
  return (found ?? SETTINGS.avatars[state.players.length % SETTINGS.avatars.length] ?? { id: 'pebble' }).id;
}

function readRules(raw: unknown): RoomRules | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const nums = ['startingMoney', 'goSalary', 'maxPlayers'] as const;
  const flags = ['auction'] as const;
  const rules = {} as RoomRules;
  for (const key of nums) {
    if (typeof row[key] !== 'number') return null;
    rules[key] = row[key];
  }
  for (const key of flags) {
    if (typeof row[key] !== 'boolean') return null;
    rules[key] = row[key];
  }
  return rules;
}

function newId(prefix: string): string {
  const buf = new Uint8Array(prefix ? 8 : 18);
  crypto.getRandomValues(buf);
  const hex = [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
  return prefix ? `${prefix}${hex}` : hex;
}
