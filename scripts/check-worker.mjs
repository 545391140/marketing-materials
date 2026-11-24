import { Miniflare } from "miniflare";
import { strict as a } from "node:assert";
import { fileURLToPath } from "node:url";
const entry = fileURLToPath(
  new URL("../dist/server/index.js", import.meta.url),
);
const folder = fileURLToPath(new URL("../dist/server/", import.meta.url));
const mf = new Miniflare({
  modulesRoot: folder,
  modules: true,
  scriptPath: entry,
  compatibilityDate: "2025-12-01",
  compatibilityFlags: ["nodejs_compat"],
  r2Buckets: ["BUCKET"],
  bindings: { DEMO_MODE: "true" },
});
try {
  const url = "http://hub.test";
  const jar = {};
  async function req(path, method = "GET", value) {
    const r = await mf.dispatchFetch(url + path, {
      method,
      headers: {
        "x-material-client": "hub",
        cookie: Object.entries(jar)
          .map((x) => x.join("="))
          .join("; "),
        "content-type": "application/json",
      },
      body: value ? JSON.stringify(value) : undefined,
    });
    for (const c of r.headers.getSetCookie()) {
      const [k, v] = c.split(";")[0].split("=");
      jar[k] = v;
    }
    return r;
  }
  a.equal((await req("/")).status, 200);
  let r = await req("/api/state");
  const initial = await r.json();
  a.equal(initial.user.role, "partner");
  a(initial.materials.length > 0);
  async function action(payload) {
    const r = await req("/api/actions", "POST", payload);
    a.equal(r.status, 200, await r.text());
  }
  await action({
    op: "request",
    title: "集成验证",
    purpose: "需要可留给客户的 PDF",
    format: "PDF",
    external: true,
  });
  let d = await (await req("/api/state")).json();
  const id = d.requests[0].id;
  await req("/api/profile", "POST", { id: "editor" });
  await action({ op: "claim", id });
  await action({ op: "deliver", id, mid: "campus", files: ["campus-main"] });
  await req("/api/profile", "POST", { id: "partner" });
  d = await (await req("/api/state")).json();
  a.equal(d.requests[0].status, "已交付");
  a.equal(d.notices.length, 1);
  a.equal(
    (await req("/api/file?m=campus&f=campus-main&mode=download")).status,
    200,
  );
  console.log(
    "PASS actual workerd and emulated R2: portal, cookies, persisted writes, requirement delivery, notification, PDF download.",
  );
} finally {
  await mf.dispose();
}
