import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { localWorkspace } from "./local-workspace.mjs";
import worker from "../dist/server/index.js";
import adminWorker from "../dist/admin/index.js";
mkdirSync(".runtime", { recursive: true });
const db = new DatabaseSync(".runtime/local.sqlite");
db.exec(
  "CREATE TABLE IF NOT EXISTS objects (key TEXT PRIMARY KEY, tag TEXT, data BLOB)"
);
const demo =
  !process.env.PC_SESSION_URL && (process.env.DEMO_MODE ?? "true") === "true";
const sharedWorkspace = demo ? localWorkspace(db, process.argv.slice(2)) : "";
if (sharedWorkspace === null) {
  db.close();
  process.exit(0);
}
if (sharedWorkspace)
  console.log("本机共享试用空间：各浏览器共用演示身份、审核队列和资料库。");
const bucket = {
  async get(k) {
    const r = db.prepare("SELECT * FROM objects WHERE key=?").get(k);
    return r
      ? {
          etag: r.tag,
          body: r.data,
          text: async () => Buffer.from(r.data).toString(),
        }
      : null;
  },
  async put(k, v, opt) {
    const tag = randomUUID(),
      b = typeof v === "string" ? Buffer.from(v) : v;
    const p = opt?.onlyIf;
    let info;
    if (p?.etagMatches)
      info = db
        .prepare("UPDATE objects SET tag=?,data=? WHERE key=? AND tag=?")
        .run(tag, b, k, p.etagMatches);
    else if (p)
      info = db
        .prepare("INSERT OR IGNORE INTO objects VALUES(?,?,?)")
        .run(k, tag, b);
    else
      info = db
        .prepare("INSERT OR REPLACE INTO objects VALUES(?,?,?)")
        .run(k, tag, b);
    return info.changes ? { etag: tag } : null;
  },
};
const param = (k) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const port = Number(param("--port") || process.env.PORT || 3000);
const adminPort = Number(
  param("--admin-port") || process.env.ADMIN_PORT || port + 1
);
if (adminPort === port) throw Error("资料中心与管理端必须使用不同端口");
const host = param("--host") || process.env.HOST || "127.0.0.1";
const portalOrigin = process.env.PORTAL_ORIGIN || "http://localhost:" + port;
const adminOrigin = process.env.ADMIN_ORIGIN || "http://localhost:" + adminPort;
const environment = {
  ...process.env,
  BUCKET: bucket,
  LOCAL_RUNTIME: true,
  LOCAL_WORKSPACE: sharedWorkspace,
  DEMO_MODE: process.env.DEMO_MODE ?? "true",
  PORTAL_ORIGIN: portalOrigin,
  ADMIN_ORIGIN: adminOrigin,
};
function serve(handler, listenPort, env) {
  return http
    .createServer(async (req, res) => {
      try {
        const parts = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 8450000) {
            res.writeHead(413).end();
            return;
          }
          parts.push(chunk);
        }
        const r = new Request(
          "http://" + (req.headers.host || "localhost") + req.url,
          {
            method: req.method,
            headers: req.headers,
            ...(parts.length ? { body: Buffer.concat(parts) } : {}),
          }
        );
        const out = await handler.fetch(r, env);
        const h = Object.fromEntries(out.headers);
        if (out.headers.getSetCookie().length)
          h["set-cookie"] = out.headers.getSetCookie();
        res.writeHead(out.status, h);
        res.end(Buffer.from(await out.arrayBuffer()));
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    })
    .listen(listenPort, host);
}
serve(worker, port, environment);
serve(adminWorker, adminPort, {
  ...environment,
  LOCAL_API: { fetch: (r) => worker.fetch(r, environment) },
});
console.log("营销资料中心：" + portalOrigin + "  资料管理端：" + adminOrigin);
