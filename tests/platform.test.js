import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import worker from "../dist/server/index.js";
import { allowed } from "../server/access.js";
import { JSDOM, VirtualConsole } from "jsdom";
function backend() {
  const objects = new Map();
  return {
    BUCKET: {
      async get(k) {
        const o = objects.get(k);
        return o
          ? {
              etag: o.tag,
              body: o.bytes,
              text: async () => Buffer.from(o.bytes).toString(),
            }
          : null;
      },
      async put(k, v, opt) {
        const o = objects.get(k),
          p = opt?.onlyIf;
        if (
          (p?.etagMatches && o?.tag !== p.etagMatches) ||
          (p?.etagDoesNotMatch === "*" && o)
        )
          return null;
        const val = {
          tag: crypto.randomUUID(),
          bytes: typeof v === "string" ? Buffer.from(v) : v,
        };
        objects.set(k, val);
        return { etag: val.tag };
      },
    },
    DEMO_MODE: "true",
  };
}
function harness(env = backend()) {
  const jar = new Map();
  const get = async (path, body, extra = {}) => {
    const headers = {
      cookie: [...jar].map(([k, v]) => k + "=" + v).join("; "),
      "x-material-client": "hub",
      ...extra,
    };
    if (body && !(body instanceof FormData))
      headers["content-type"] = "application/json";
    const req = new Request(new URL(path, "https://local.test"), {
      headers,
      method: body ? "POST" : "GET",
      body: body
        ? body instanceof FormData
          ? body
          : JSON.stringify(body)
        : undefined,
    });
    const r = await worker.fetch(req, env);
    for (const v of r.headers.getSetCookie()) {
      const pair = v.split(";")[0].split("=");
      jar.set(pair[0], pair[1]);
    }
    return r;
  };
  const data = async () => {
    const r = await get("/api/state");
    assert.equal(r.status, 200);
    return r.json();
  };
  const act = async (a, expect = 200) => {
    const r = await get("/api/actions", a);
    assert.equal(r.status, expect, await r.text());
  };
  const user = async (id) =>
    assert.equal((await get("/api/profile", { id })).status, 200);
  return { get, data, act, user, env, jar };
}
test("signed-in partner search, indirect visibility, preview-only and isolation", async () => {
  const h = harness();
  const d = await h.data();
  assert.equal(d.admin, null);
  assert(!d.materials.some((m) => m.id === "internal"));
  assert.equal(d.materials.find((m) => m.id === "campus").files.length, 1);
  assert.equal(
    (await h.get("/api/file?m=campus&f=campus-internal")).status,
    404,
  );
  assert.equal(
    (await h.get("/api/file?m=compare&f=compare-main&mode=download")).status,
    403,
  );
  assert.equal((await h.get("/api/file?m=compare&f=compare-main")).status, 200);
  await h.act({ op: "library", kind: "category", name: "x" }, 403);
  await h.act({ op: "request", title: "测试需求", purpose: "首访" });
  assert.equal((await harness(h.env).data()).requests.length, 0);
  assert.equal(
    allowed(
      {
        role: "partner",
        grants: [
          { bg: "A", region: "北", channel: "总代" },
          { bg: "B", region: "南", channel: "经销" },
        ],
      },
      [{ role: "伙伴", bg: "B", region: "北", channel: "全部" }],
    ),
    false,
  );
});
test("request, upload, independent review, deduplicated delivery, withdrawal and revocation", async () => {
  const h = harness();
  await h.data();
  await h.act({
    op: "request",
    title: "连锁客户案例",
    purpose: "客户首访",
    external: true,
  });
  const rq = (await h.data()).requests[0];
  await h.user("editor");
  await h.act({ op: "claim", id: rq.id });
  const form = new FormData();
  form.append(
    "file",
    new Blob(["连锁门店案例\n访谈提纲与对客资料。"]),
    "门店案例.txt",
  );
  const uploaded = await h.get("/api/upload", form);
  assert.equal(uploaded.status, 200);
  const f = await uploaded.json();
  const rules = [{ role: "全部", bg: "EBG", channel: "全部", region: "全部" }];
  const draft = {
    op: "save",
    title: "门店新资料",
    summary: "用于首次拜访",
    type: "客户案例",
    cat: "园区网络",
    defaultView: rules,
    defaultDownload: rules,
    files: [{ id: f.id, inherit: true, usage: "可发客户" }],
    req: rq.id,
    deliveryFiles: [f.id],
    submit: true,
  };
  await h.act(draft);
  const m = (await h.data()).admin.drafts[0];
  await h.act({ op: "review", id: m.id, approve: true }, 403);
  await h.user("partner");
  assert.equal((await h.data()).notices.length, 0);
  await h.user("reviewer");
  await h.act({ op: "review", id: m.id, approve: true });
  await h.act({ op: "review", id: m.id, approve: true }, 403);
  await h.user("partner");
  const d = await h.data();
  assert.equal(d.requests[0].status, "已交付");
  assert.equal(d.notices.length, 1);
  const mat = d.materials.find((x) => x.title === "门店新资料");
  const url = "/api/file?m=" + mat.id + "&f=" + f.id;
  assert.match(await (await h.get(url + "&mode=download")).text(), /首|连锁/);
  await h.act({ op: "fav", id: mat.id });
  await h.user("editor");
  await h.act({ op: "withdraw", id: mat.id, comment: "撤回" });
  await h.user("partner");
  assert.equal((await h.get(url)).status, 404);
  const after = await h.data();
  assert(!after.prefs.fav.includes(mat.id));
  assert.equal(after.requests[0].material, null);
});
test("partner needing a customer version cannot be sent an internal or view-only item", async () => {
  const h = harness();
  await h.data();
  await h.act({
    op: "request",
    title: "外发材料",
    purpose: "投标",
    external: true,
  });
  const id = (await h.data()).requests[0].id;
  await h.user("editor");
  await h.act(
    { op: "deliver", id, mid: "compare", files: ["compare-main"] },
    409,
  );
  await h.act({ op: "ask", id, comment: "需要什么格式？" });
  await h.user("partner");
  await h.act({ op: "reply", id, comment: "PDF" });
  await h.user("editor");
  await h.act({ op: "deliver", id, mid: "campus", files: ["campus-main"] });
  await h.user("partner");
  const d = await h.data();
  assert.equal(d.requests[0].material, "campus");
  assert.equal(d.notices.filter((n) => n.msg.includes("已发布")).length, 1);
});
test("demo switch closed if configured with real portal and absent session", async () => {
  const h = harness({
    ...backend(),
    PC_SESSION_URL: "https://example.invalid/check",
  });
  assert.equal((await h.get("/api/state")).status, 401);
  assert.equal((await h.get("/api/profile", { id: "reviewer" })).status, 401);
});
test("released interface mounts and navigates the library, attachments, request form and editor", async () => {
  const h = harness();
  const html = await (await h.get("/")).text();
  const script = await (await h.get("/app.js")).text();
  const errs = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errs.push(e.message));
  const dom = new JSDOM(html, {
    url: "https://local.test",
    runScripts: "outside-only",
    virtualConsole: vc,
  });
  const w = dom.window;
  w.scrollTo = () => {};
  w.fetch = async (p, o = {}) =>
    h.get(p, o.body ? JSON.parse(o.body) : undefined);
  w.eval(script);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(40);
  const doc = w.document;
  assert.match(doc.body.innerText || doc.body.textContent, /伙伴资料中心/);
  assert(doc.querySelector(".hero"));
  doc.querySelector(".card-name").click();
  await wait(10);
  assert(doc.querySelector(".attachment"));
  doc.querySelector(".xbtn").click();
  doc.querySelector(".request-banner button").click();
  await wait(10);
  assert(
    doc.querySelector(".dialog form") || doc.querySelector(".dialog .form"),
  );
  const root = doc.querySelector("#app").__vue__;
  assert(root);
  await root.profile("editor");
  await wait(80);
  assert(doc.querySelector(".studio"));
  doc.querySelector(".studio-main .sec-head .btn").click();
  await wait(20);
  assert(doc.querySelector(".upload"));
  assert.deepEqual(errs, []);
  dom.window.close();
});
