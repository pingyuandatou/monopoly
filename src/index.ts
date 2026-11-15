import type { Env } from './env';
import { listRooms } from './registry';

export { Room } from './room';

const ROOM_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, game: '大富翁' });
    }
    if (url.pathname.startsWith('/api/admin/')) {
      return admin(request, env, url);
    }
    if (url.pathname === '/api/ws') {
      const room = (url.searchParams.get('room') || '').toUpperCase();
      if (!ROOM_CODE.test(room)) {
        return new Response('房间号需要 5 位，请避开容易看混的 0、O、1、I、L', { status: 400 });
      }
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('请使用 WebSocket 连接', { status: 426 });
      }
      const stub = env.ROOM.get(env.ROOM.idFromName(room));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

/**
 * 管理接口。请求头带 `Authorization: Bearer <ADMIN_KEY>`。
 *   GET  /api/admin/rooms               所有登记过的房间
 *   GET  /api/admin/rooms/:code         房间详情
 *   POST /api/admin/rooms/:code/end     结束对局
 *   POST /api/admin/rooms/:code/kick    请一个人离开，body: { id }
 *   POST /api/admin/rooms/:code/delete  删除房间
 */
async function admin(request: Request, env: Env, url: URL): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' };
  if (!env.ADMIN_KEY) return Response.json({ ok: false, error: '还没有设置管理密钥' }, { status: 503, headers });
  const given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!(await sameSecret(given, env.ADMIN_KEY))) {
    return Response.json({ ok: false, error: '管理密钥不对' }, { status: 401, headers });
  }
  const parts = url.pathname.split('/').filter(Boolean).slice(2);
  if (parts[0] !== 'rooms') return Response.json({ ok: false, error: '没有这个接口' }, { status: 404, headers });
  try {
    if (parts.length === 1 && request.method === 'GET') {
      const rooms = await listRooms(env.DB);
      return Response.json({ ok: true, rooms, now: Date.now() }, { headers });
    }
    const code = (parts[1] || '').toUpperCase();
    if (!ROOM_CODE.test(code)) return Response.json({ ok: false, error: '房间号不对' }, { status: 400, headers });
    const action = parts.length === 2 ? 'state' : parts[2];
    if (!action || !['state', 'end', 'kick', 'delete'].includes(action)) {
      return Response.json({ ok: false, error: '没有这个操作' }, { status: 404, headers });
    }
    if (action !== 'state' && request.method !== 'POST') {
      return Response.json({ ok: false, error: '请用 POST' }, { status: 405, headers });
    }
    const stub = env.ROOM.get(env.ROOM.idFromName(code));
    const inner = new Request(`https://room.internal/admin/${action}?room=${code}`, {
      method: action === 'state' ? 'GET' : 'POST',
      body: action === 'kick' ? await request.text() : undefined,
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await stub.fetch(inner);
    return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json', ...headers } });
  } catch (err) {
    console.error('admin failed', err);
    return Response.json({ ok: false, error: '操作没能完成' }, { status: 500, headers });
  }
}

/** 先各自做 SHA-256 再比较，长度相同，比较时间也不随内容变化。 */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}
