import type { Env } from './env';

export { Room } from './room';

const ROOM_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, game: '大富翁' });
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
