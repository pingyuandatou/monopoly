export interface Env {
  ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  /** 房间登记表，给管理页用。 */
  DB: D1Database;
  /** 管理页的密钥，用 `wrangler secret put ADMIN_KEY` 设置。没设置时管理接口一律拒绝。 */
  ADMIN_KEY?: string;
}
