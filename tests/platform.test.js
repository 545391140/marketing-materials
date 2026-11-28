import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import worker from "../dist/server/index.js";
import adminWorker from "../dist/admin/index.js";
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
  let doc = w.document;
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
  let root = doc.querySelector("#app").__vue__;
  assert(root);
  await root.profile("editor");
  await wait(80);
  assert.equal(doc.querySelector(".studio"),null);
  assert.equal((await (await h.get("/api/portal/state")).json()).admin,null);
  const adminEnv={PORTAL_ORIGIN:"https://local.test",LOCAL_API:{fetch:r=>worker.fetch(r,h.env)}};
  const adminGet=path=>adminWorker.fetch(new Request("https://admin.test"+path,{headers:{cookie:[...h.jar].map(([k,v])=>k+"="+v).join("; ")}}),adminEnv);
  const entry=await adminGet("/");
  assert.equal(entry.status,200);
  const internal=new JSDOM(await entry.text(),{url:"https://admin.test",runScripts:"outside-only",virtualConsole:vc});
  internal.window.fetch=w.fetch;
  internal.window.eval(await (await adminGet("/admin.js")).text());
  dom.window.close();
  await wait(50);
  doc=internal.window.document;
  root=doc.querySelector("#app").__vue__;
  assert(doc.querySelector(".studio"));
  doc.querySelector(".studio-main .sec-head .btn").click();
  await wait(20);
  assert(doc.querySelector(".upload"));
  const batchScope = doc.querySelector(".upload-scope");
  assert(batchScope);
  const inherit = batchScope.querySelector("input[type=checkbox]");
  inherit.click();
  await wait(5);
  assert.equal(batchScope.querySelectorAll(".rule-editor").length,2);
  inherit.click();
  await wait(5);
  assert.equal(batchScope.querySelectorAll(".rule-editor").length,0);
  const permissions = doc.querySelector(".audience-panel");
  assert(permissions && permissions.open);
  const country = permissions.querySelector(".scope-picker");
  country.open = true;
  await wait(15);
  const th = [...country.querySelectorAll("label")].find((el) => el.textContent.includes("泰国"));
  assert(th);
  th.querySelector("input").click();
  await wait(5);
  assert.equal(country.querySelector("summary").textContent.trim(),"泰国");
  const add = [...permissions.querySelectorAll("button")].find((b) => b.textContent.includes("添加授权组"));
  add.click();
  await wait(5);
  assert.equal(permissions.querySelectorAll("fieldset").length,3);
  const studio = doc.querySelector(".studio").__vue__;
  const base = studio.a.published.find((m) => m.id === "retail");
  studio.edit(base);
  const audience = [{role:"伙伴",bg:"EBG",region:"东南亚",country:["TH"],channel:["经销"]}];
  studio.form.defaultView = audience;
  studio.form.defaultDownload = [];
  studio.setInherit(studio.form.files[0], true);
  await studio.save(true);
  await root.profile("reviewer");
  await wait(40);
  const reviewStudio = doc.querySelector(".studio").__vue__;
  const draft = reviewStudio.a.drafts.find((d) => d.mid === base.id);
  assert(draft);
  reviewStudio.inspect(draft);
  await wait(5);
  const scopeText = doc.querySelector(".review-scope").textContent;
  assert.match(scopeText,/新增授权组.*国家 泰国 · 伙伴类型 经销商/);
  assert.match(scopeText,/移除授权组.*国家 全部/);
  assert.deepEqual(errs, []);
  internal.window.close();
});

test("Chinese PDF, Office, image and text originals generate controlled previews", async () => {
  const { zipSync, strToU8 } = await import("fflate");
  const { encode: png } = await import("fast-png");
  const { default: jpeg } = await import("jpeg-js");
  const pdfs = JSON.parse(
    await fs.readFile(
      new URL("../server/sample-pdf.json", import.meta.url),
      "utf8",
    ),
  );
  const rgba = {
    data: Uint8Array.from([255, 128, 0, 255]),
    width: 1,
    height: 1,
  };
  const inputs = [
    ["PDF.pdf", Buffer.from(pdfs["campus-main"], "base64"), "智慧园区"],
    [
      "提纲.docx",
      zipSync({
        "word/document.xml": strToU8(
          "<w:p><w:r><w:t>拜访提纲</w:t></w:r></w:p>",
        ),
      }),
      "拜访提纲",
    ],
    [
      "演示.pptx",
      zipSync({
        "ppt/slides/slide1.xml": strToU8(
          "<a:p><a:r><a:t>客户演示</a:t></a:r></a:p>",
        ),
      }),
      "客户演示",
    ],
    ["说明.txt", Buffer.from("首访提纲"), "首访提纲"],
    ["图片.png", png({ ...rgba, channels: 4 }), "image/png"],
    ["封面.jpg", jpeg.encode(rgba, 90).data, "image/jpeg"],
  ];
  const h = harness();
  await h.data();
  await h.user("editor");
  const files = [];
  for (const [name, bytes] of inputs) {
    const fd = new FormData();
    fd.append("file", new Blob([bytes]), name);
    const r = await h.get("/api/upload", fd);
    const v = await r.json();
    assert.equal(r.status, 200, JSON.stringify(v));
    files.push({ ...v, inherit: true, usage: "可发客户" });
  }
  const rules = [{ role: "全部", bg: "EBG", region: "全部", channel: "全部" }];
  await h.act({
    op: "save",
    title: "附件验证",
    type: "客户案例",
    cat: "园区网络",
    summary: "预览",
    defaultView: rules,
    defaultDownload: [],
    files,
    submit: true,
  });
  const m = (await h.data()).admin.drafts[0];
  for (const [i, f] of files.entries()) {
    const r = await h.get("/api/file?draft=1&m=" + m.id + "&f=" + f.id);
    assert.equal(r.status, 200);
    if (i >= 4) {
      assert.equal(r.headers.get("content-type"), inputs[i][2]);
      assert((await r.arrayBuffer()).byteLength > 0);
    } else assert((await r.json()).text.includes(inputs[i][2]), f.name);
  }
});

test("update remains private until independent review; deadline and click-through stay current", async () => {
  const h = harness();
  const initial = await h.data();
  const base = initial.materials.find((m) => m.id === "retail");
  await h.act({ op: "fav", id: base.id });
  await h.act({ op: "list", id: base.id });
  const due = new Date(Date.now() + 8 * 86400000).toISOString().slice(0, 10);
  const expires = new Date(Date.now() + 3 * 86400000)
    .toISOString()
    .slice(0, 10);
  await h.act({ op: "checklist", deadline: due, notes: "检查资料有效期" });
  await h.user("reviewer");
  await h.act({
    op: "library",
    kind: "type",
    name: "经营指南",
    fields: ["适用主体"],
  });
  await h.user("editor");
  const source = (await h.data()).admin.published.find((m) => m.id === base.id);
  await h.act({
    ...source,
    id: "",
    mid: source.id,
    op: "save",
    type: "经营指南",
    fields: { 适用主体: "试点伙伴" },
    title: "门店拜访新版",
    expires,
    submit: true,
  });
  const draft = (await h.data()).admin.drafts[0];
  await h.user("partner");
  assert.equal(
    (await h.data()).materials.find((m) => m.id === base.id).title,
    base.title,
  );
  await h.user("reviewer");
  await h.act({ op: "review", id: draft.id, approve: true });
  await h.user("partner");
  const d = await h.data(),
    latest = d.materials.find((m) => m.id === base.id);
  assert.equal(latest.version, 2);
  assert.equal(latest.fields["适用主体"], "试点伙伴");
  assert(latest.expires < d.prefs.deadline);
  const inbox = await (await h.get("/api/inbox")).json();
  assert(inbox.notices.some((n) => n.msg.includes("即将到期")));
  await h.act({ op: "read" });
  assert((await h.data()).notices.every((n) => n.read));
});

test("scene kits go through independent review and hide inaccessible references", async () => {
  const h = harness();
  await h.data();
  await h.user("editor");
  await h.act({
    op: "savePack",
    title: "试点拜访包",
    intro: "适合首次见面",
    steps: ["先确认客户场景"],
    refs: ["internal", "campus"],
    img: "hero",
  });
  const pending = (await h.data()).admin.packDrafts[0];
  await h.act({ op: "packReview", id: pending.id, approve: true }, 403);
  await h.user("reviewer");
  await h.act({ op: "packReview", id: pending.id, approve: true });
  await h.user("partner");
  assert.deepEqual(
    (await h.data()).packs.find((k) => k.title === "试点拜访包").refs,
    ["campus"],
  );
});

test("portal message adapter retries failures with one stable delivery key", async () => {
  const { sendPortalNotifications } = await import(
    "../server/portal-notifications.js"
  );
  const env = {
    ...backend(),
    PC_SESSION_URL: "https://example.invalid/session",
    PC_MESSAGE_URL: "https://example.invalid/messages",
    PC_SERVICE_TOKEN: "test-only",
  };
  await env.BUCKET.put(
    "state/portal",
    JSON.stringify({
      notices: [
        { to: "test", key: "delivery-1", msg: "资料已发布", rid: "RQ-1" },
      ],
    }),
  );
  const attempts = [];
  const send = async (url, opts) => {
    attempts.push(opts.headers["idempotency-key"]);
    return new Response(null, { status: attempts.length === 1 ? 503 : 204 });
  };
  for (const t of [1000, 2000, 32000, 64000])
    await sendPortalNotifications(env, send, t);
  assert.deepEqual(attempts, ["delivery-1", "delivery-1"]);
  const state = JSON.parse(await (await env.BUCKET.get("state/portal")).text());
  assert.equal(state.notices[0].portalSent, true);
});

test("content feedback routes to its owner; withdrawing referenced evidence removes dependent downloads and cards", async () => {
  const h = harness();
  await h.data();
  await h.act({
    op: "request",
    title: "资料纠错",
    purpose: "需要核实适用型号",
    subjectId: "campus",
  });
  await h.user("editor");
  const before = (await h.data()).admin;
  const issue = before.queue[0];
  assert.equal(issue.category, "资料纠错");
  assert.equal(
    issue.owner,
    before.published.find((x) => x.id === "campus").owner,
  );
  const source = before.published.find((x) => x.id === "retail");
  await h.act({
    ...source,
    id: "",
    mid: source.id,
    op: "save",
    proofId: "campus",
    submit: true,
  });
  await h.user("reviewer");
  const draft = (await h.data()).admin.drafts[0];
  await h.act({ op: "review", id: draft.id, approve: true });
  await h.user("partner");
  assert((await h.data()).materials.some((x) => x.id === "retail"));
  await h.user("editor");
  await h.act({ op: "withdraw", id: "campus", comment: "证据需重新核实" });
  assert.equal(
    (await h.data()).admin.published.find((x) => x.id === "retail")
      .proofNeedsReview,
    true,
  );
  await h.user("partner");
  assert(!(await h.data()).materials.some((x) => x.id === "retail"));
  assert.equal(
    (await h.get("/api/file?m=retail&f=retail-main&mode=download")).status,
    404,
  );
});

test("production portal contract: active grants and scan decisions govern identity and uploads", async (t) => {
  const { profiles } = await import("../server/seed.js");
  let current = profiles.editor,
    clean = false;
  const fetchStub = t.mock.method(globalThis, "fetch", async (url, opts) => {
    if (String(url) === "https://test.invalid/session") {
      assert.equal(opts.headers.Authorization, "Bearer test-session");
      return Response.json({ ...current, active: current.active !== false });
    }
    if (String(url) === "https://test.invalid/scan")
      return Response.json({ clean });
    throw Error("Unexpected outbound call");
  });
  const h = harness({
    ...backend(),
    DEMO_MODE: "false",
    PC_SESSION_URL: "https://test.invalid/session",
    SCAN_URL: "https://test.invalid/scan",
  });
  h.jar.set("pc_session", "test-session");
  assert.equal((await h.data()).demo, false);
  assert.equal((await h.get("/api/profile", { id: "reviewer" })).status, 403);
  const fd = new FormData();
  fd.append("file", new Blob(["测试资料"]), "验证.txt");
  assert.equal((await h.get("/api/upload", fd)).status, 422);
  clean = true;
  assert.equal((await h.get("/api/upload", fd)).status, 200);
  current = { ...profiles.editor, active: false };
  assert.equal((await h.get("/api/state")).status, 401);
  fetchStub.mock.restore();
});

test("country and partner-type groups enforce revisions, attachment limits and live portal contracts", async (t) => {
  const { profiles } = await import("../server/seed.js");
  const audienceCatalog = {
    countries: [{value:"TH",label:"泰国"},{value:"VN",label:"越南"}],
    partnerTypes: [{value:"reseller",label:"经销商"},{value:"si",label:"系统集成商"}],
  };
  let current = { ...profiles.editor, audienceCatalog };
  t.mock.method(globalThis, "fetch", async (url) => Response.json(String(url).includes("/directory") ? profiles.reviewer : current));
  const h = harness({ ...backend(), PC_SESSION_URL:"https://pc.invalid/session",PC_DIRECTORY_URL:"https://pc.invalid/directory",PC_SERVICE_TOKEN:"test" });
  h.jar.set("pc_session", "test");
  current={...profiles.reviewer,audienceCatalog}; await h.data();
  current={...profiles.editor,audienceCatalog};
  const state = await h.data();
  assert.deepEqual(state.admin.audienceCatalog, audienceCatalog);
  const mat = state.admin.published.find((m) => m.id === "retail");
  const rule = (country,channel) => ({role:"伙伴",bg:"EBG",region:"东南亚",country,channel});
  const th = rule(["TH"],["reseller"]), vn = rule(["VN"],["si"]);
  const draft = {...mat, op:"save", id:"", mid:mat.id, defaultView:[th,vn], defaultDownload:[vn],
    files:mat.files.map((f) => ({...f, inherit:true})), submit:true};
  const preview = "/api/file?m=retail&f=retail-main";
  const download = preview + "&mode=download";
  await h.act({...draft, defaultDownload:[rule(["TH","VN"],["si"])]},400);
  await h.act({...draft, defaultView:[rule(["ZZ"],"全部")], defaultDownload:[]},400);
  await h.act({...draft, defaultView:[rule(["TH"],["invented"])], defaultDownload:[]},400);
  await h.act({...draft, files:[{...draft.files[0],inherit:false,view:[th],download:[th]}]},400);
  await h.act(draft);
  const pending = (await h.data()).admin.drafts[0];
  const grant = (country,channel,active = true) => ({bg:"EBG",region:"东南亚",country,channel,active});
  const asPartner = (...grants) => { current = { ...profiles.partner, grants }; };
  asPartner(grant("TH","si"),grant("VN","reseller"));
  assert.equal((await h.get(download)).status,200, "old published rules are still effective");
  current = {...profiles.reviewer,audienceCatalog};
  await h.act({op:"review",id:pending.id,approve:true});
  asPartner(grant("th","reseller"));
  assert.equal((await h.get(preview)).status,200);
  assert.equal((await h.get(download)).status,403);
  await h.act({op:"fav",id:"retail"});
  asPartner(grant("VN","si"));
  assert.equal((await h.get(download)).status,200);
  asPartner(grant("TH","si"),grant("VN","reseller"),grant("VN","si",false));
  const hidden = await h.data();
  assert(!hidden.materials.some((m)=>m.id==="retail"));
  assert(!hidden.packs.some((k)=>k.refs.includes("retail")));
  assert(!hidden.prefs.fav.includes("retail"));
  assert.equal((await h.get(preview)).status,404);
  assert.equal((await h.get(download)).status,404);
  asPartner(grant(undefined,"si"));
  assert.equal((await h.get(preview)).status,404);
});

test("multi-select download coverage preserves country/type pairs across the union", async () => {
  const { subset } = await import("../shared/audience.js");
  const r = (country, channel) => ({role:"伙伴",bg:"EBG",region:"全部",country,channel});
  const selection = [r(["TH","VN"],["A","B"])];
  const view = [r(["TH"],["A","B"]),r(["VN"],["A"]),r(["VN"],["B"])];
  assert(subset(selection,view));
  assert(!subset(selection,view.slice(0,2)));
  assert(!subset([r("全部",["A"])],view));
  assert(subset(selection,[r(undefined,"全部")]));
});

test("upload saves each batch's permission rules and applies them after approval", async () => {
  const h = harness();
  await h.data(); await h.user("editor");
  const th = { role:"伙伴", bg:"EBG", region:"东南亚", country:["TH"], channel:["经销"] };
  const vn = { ...th, country:["VN"], channel:["集成"] };
  const defaults = { defaultView:[th,vn], defaultDownload:[vn] };
  async function upload(name, options, expected=200) {
    const body = new FormData();
    body.append("file",new Blob([name]),name+".txt");
    body.append("permissions", JSON.stringify({...defaults,...options}));
    const r = await h.get("/api/upload",body);
    assert.equal(r.status,expected);
    return r.json();
  }
  await upload("越权", {inherit:false,view:[th],download:[vn]},400);
  await upload("扩大范围", {inherit:false,view:[{...th,region:"全部"}],download:[]},400);
  const v = await upload("越南专享",{inherit:false,view:[vn],download:[vn]});
  assert.deepEqual(v.view,[vn]); assert.deepEqual(v.download,[vn]);
  const all = await upload("继承权限",{inherit:true});
  assert.deepEqual(all.view,[th,vn]); assert.deepEqual(all.download,[vn]);
  await h.act({op:"save",title:"分批授权",summary:"上传权限验证",type:"客户案例",cat:"园区网络",
    ...defaults,files:[v,all].map((f)=>({...f,usage:"伙伴学习"})),submit:true});
  const m=(await h.data()).admin.drafts[0];
  const file=(f,download=false)=>"/api/file?m="+m.mid+"&f="+f.id+(download?"&mode=download":"");
  await h.user("partnerVn");
  assert.equal((await h.get(file(v))).status,404);
  await h.user("reviewer"); await h.act({op:"review",id:m.id,approve:true});
  await h.user("partner");
  assert.equal((await h.get(file(v))).status,404);
  assert.equal((await h.get(file(all))).status,200);
  assert.equal((await h.get(file(all,true))).status,403);
  await h.user("partnerVn");
  assert.equal(await (await h.get(file(v,true))).text(),"越南专享");
});

test("local shared deployment exposes submitted drafts across sessions and approved files only to allowed partners", async () => {
  const env = { ...backend(), LOCAL_RUNTIME: true, LOCAL_WORKSPACE: "local" };
  const editor = harness(env), reviewer = harness(env), partner = harness(env);
  await editor.user("editor");
  await reviewer.user("reviewer");
  partner.jar.set("material_space", "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa");
  const before = await partner.data();
  const input = new FormData();
  input.append("file", new Blob(["release note"]), "release.txt");
  const file = await (await editor.get("/api/upload", input)).json();
  assert.equal((await reviewer.data()).admin.drafts.length, 0);
  const rule = [{ role:"伙伴", bg:"EBG", region:"东南亚", country:["VN"], channel:["集成"] }];
  const save = {op:"save", title:"共享资料", summary:"现场验收", type:"客户案例",cat:"园区网络",
    defaultView:rule, defaultDownload:rule,files:[{id:file.id, inherit:true,usage:"可发客户"}]};
  await editor.act({...save, submit:true});
  const draft = (await reviewer.data()).admin.drafts.find((m) => m.title === save.title);
  assert.equal(draft.state, "待审核");
  await partner.user("partnerVn");
  assert(!(await partner.data()).materials.some((m) => m.id === draft.mid));
  await reviewer.act({op:"review",id:draft.id,approve:true});
  const inbox = await (await partner.get("/api/inbox")).json();
  assert.notEqual(inbox.revision,before.revision);
  const url = "/api/file?m="+draft.mid+"&f="+file.id+"&mode=download";
  assert.equal(await (await partner.get(url)).text(),"release note");
  await partner.user("partner");
  assert.equal((await partner.get(url)).status,404);
});

test("staff recover their own staged upload and trace it through return, publication, revision and withdrawal", async () => {
  const h = harness();
  await h.data();
  await h.user("editor");
  const rules = [{ role: "伙伴", bg: "EBG", region: "东南亚", country: ["VN"], channel: ["集成"] }];
  const form = new FormData();
  form.append("file", new Blob(["渠道资料验收"]), "渠道资料.txt");
  form.append("permissions", JSON.stringify({
    inherit: false, defaultView: rules, defaultDownload: [], view: rules, download: [],
  }));
  const upload = await h.get("/api/upload", form);
  assert.equal(upload.status, 200);
  const file = await upload.json();
  const staged = (await h.data()).admin.pendingUploads;
  assert.equal(staged.length, 1);
  assert.deepEqual(staged[0].view, rules);
  assert.deepEqual(staged[0].download, []);
  assert(!("original" in staged[0]));
  await h.user("reviewer");
  assert.deepEqual((await h.data()).admin.pendingUploads, []);
  await h.user("editor");
  const save = {
    op: "save", title: "集成商手册", summary: "验收", type: "客户案例", cat: "园区网络",
    defaultView: rules, defaultDownload: [], files: [{ ...file, usage: "伙伴学习" }],
  };
  await h.act(save);
  let admin = (await h.data()).admin;
  assert.deepEqual(admin.pendingUploads, []);
  const draft = admin.drafts[0];
  await h.act({ ...save, id: draft.id, submit: true });
  await h.user("reviewer");
  await h.act({ op: "review", id: draft.id, approve: false, comment: "请校对" });
  await h.user("editor");
  await h.act({ ...save, id: draft.id, submit: true });
  await h.user("reviewer");
  await h.act({ op: "review", id: draft.id, approve: true });
  await h.user("editor");
  await h.act({ ...save, mid: draft.mid, revisionNote: "增加目录", submit: true });
  await h.user("reviewer");
  admin = (await h.data()).admin;
  await h.act({ op: "review", id: admin.drafts[0].id, approve: true });
  await h.act({ op: "withdraw", id: draft.mid, comment: "结束使用" });
  const url = "/api/admin/history?id=" + draft.mid;
  const history = await (await h.get(url)).json();
  assert.deepEqual(history.map((e) => e.action), [
    "下架：结束使用", "审核发布 v2", "待审核", "审核发布 v1", "待审核", "退回草稿", "待审核", "草稿",
  ]);
  assert.equal(history[1].note, "增加目录");
  assert.deepEqual(history[1].filenames, ["渠道资料.txt"]);
  assert.equal(history[5].note, "请校对");
  await h.user("partnerVn");
  assert.equal((await h.get(url)).status, 404);
  assert.equal((await h.data()).admin, null);
});

test("configured product, solution and type routes are scoped, frozen per submission and enforce each reviewer", async () => {
  const h = harness();
  await h.data();
  const rule = { op: "saveFlow", name: "产品技术与运营", bg: "EBG", priority: 10, active: true,
    product: "交换机", solution: "分支互联", type: "客户案例", steps: [
      { name: "技术审查", reviewerId: "productReviewer" },
      { name: "运营发布", reviewerId: "reviewer" },
    ] };
  await h.user("editor");
  await h.act(rule, 403);
  await h.user("reviewer");
  await h.act({ op: "library", kind: "product", name: rule.product });
  await h.act({ op: "library", kind: "solution", name: rule.solution });
  await h.act({ ...rule, bg: "other" }, 403);
  await h.act({ ...rule, steps: [{ name: "产品", reviewerId: "editor" }] }, 400);
  await h.act(rule);
  await h.act({ ...rule, name: "重复优先级" }, 409);
  await h.act({ ...rule, name: "案例复核", priority: 20, product: "", solution: "",
    steps: [{ name: "案例核对", reviewerId: "reviewer" }] });
  const config = (await h.data()).admin.approvalRules[0];
  await h.user("editor");
  const fd = new FormData();
  fd.append("file", new Blob(["测试产品资料"]), "产品资料.txt");
  const file = await (await h.get("/api/upload", fd)).json();
  const save = { op: "save", product: rule.product, solution: rule.solution, type: rule.type, cat: "园区网络",
    summary: "测试", title: "技术案例", defaultView: [], defaultDownload: [],
    files: [{ id: file.id, inherit: true, usage: "伙伴学习" }], submit: true };
  const submit = async (patch) => {
    await h.act({ ...save, ...patch });
    return (await h.data()).admin.drafts.find((d) => d.title === (patch.title || save.title));
  };
  assert.equal((await submit({ product: "", title: "其他产品" })).approval.name, "案例复核");
  assert.equal((await submit({ solution: "", title: "其他方案" })).approval.name, "案例复核");
  assert.equal((await submit({ type: "产品资料", title: "其他类型" })).approval.name, "标准发布审核");
  let draft = await submit({});
  assert.equal(draft.approval.name, rule.name);
  const decide = (token, approve = true, status = 200) => h.act({ op: "review", id: draft.id,
    approve, stepToken: token, comment: "已核对" }, status);
  const first = draft.approval.token;
  await h.user("reviewer");
  await decide(first, true, 403);
  await h.act({ ...rule, ...config, active: false });
  await h.act({ ...rule, ...config }, 409);
  await h.user("productReviewer");
  await decide(undefined, true, 409);
  await decide(first);
  let admin = (await h.data()).admin;
  assert(!admin.published.some((m) => m.id === draft.mid));
  draft = admin.drafts.find((d) => d.id === draft.id);
  assert.equal(draft.approval.index, 1);
  await h.user("reviewer");
  await decide(first, true, 409);
  await decide(draft.approval.token, false);
  await h.user("editor");
  draft = await submit({ id: draft.id });
  assert.equal(draft.approval.name, "案例复核");
  assert.equal(draft.approval.index, 0);
  await h.user("reviewer");
  await decide(draft.approval.token);
  admin = (await h.data()).admin;
  assert(!admin.drafts.some((d) => d.id === draft.id));
  const published = admin.published.find((m) => m.id === draft.mid);
  assert.equal(published.product, rule.product);
  assert.equal(published.approval, undefined);
});

test("role grants govern menus, role approval, revocation, diagnostic, transfer and direct download", async()=>{
  const h=harness();
  await h.data();
  await h.user("admin");
  await h.act({op:"saveRole",name:"方案专家",caps:["browse","read","review"]});
  const role=(await h.data()).admin.system.roles.find(r=>r.name==="方案专家");
  const grant=(id,ids,version=0)=>h.act({op:"assignRoles",userId:id,bg:"EBG",ids,version});
  await grant("sales",[role.id]);
  await h.user("sales");
  const flow={op:"saveFlow",name:"专家复核",bg:"EBG",priority:1,active:true,steps:[{name:"方案核对",roleId:role.id}]};
  await h.act(flow,403);
  await h.act({op:"assignRoles",userId:"editor",bg:"EBG",ids:["flow"],version:0},403);
  await h.user("admin");await h.act(flow);
  await h.user("editor");
  const mat=(await h.data()).admin.published.find(m=>m.id==="retail");
  const save={...mat,id:"",mid:mat.id,op:"save",submit:true,title:"方案新版本"};
  await h.act(save);
  const d=(await h.data()).admin.drafts[0];
  await h.user("reviewer");
  const approve={op:"review",id:d.id,stepToken:d.approval.token,approve:true};
  await h.act(approve,403);
  await h.user("admin");await grant("sales",["viewer"],1);
  assert((await h.data()).admin.stalled.includes(d.id));
  await h.user("sales");await h.act(approve,403);
  await h.user("editor");await h.act({...save,title:"无法送审"},409);
  await h.user("admin");
  await h.act({op:"reassignStep",id:d.id,token:d.approval.token,to:"productReviewer",comment:"专家已调岗"});
  await h.user("productReviewer");
  await h.act(approve,409);
  const next=(await h.data()).admin.drafts.find(x=>x.id===d.id);
  await h.act({...approve,stepToken:next.approval.token});
  await h.user("admin");
  await h.act({op:"saveRole",name:"只读伙伴",caps:["browse"]});
  const limited=(await h.data()).admin.system.roles.find(r=>r.name==="只读伙伴");
  await grant("partner",[limited.id]);
  const diag=await (await h.get("/api/diagnose",{userId:"partner",id:mat.id})).json();
  assert(diag.files.some(f=>f.reason.includes("角色未授权下载")));
  await h.user("partner");
  assert.deepEqual((await h.data()).user.scopes[0].caps,["browse"]);
  await h.act({op:"request",title:"test",purpose:"test"},403);
  assert.equal((await h.get("/api/file?m=retail&f=retail-main&mode=download")).status,403);
});

test("portal BG assignments do not combine one role's scope with another role's operations", async(t)=>{
  const {profiles}=await import("../server/seed.js");
  const user={...profiles.sales,grants:[...profiles.sales.grants,{bg:"SMB",region:"华东",channel:"员工"}]};
  let current=profiles.admin;
  t.mock.method(globalThis,"fetch",async url=>Response.json(String(url).includes("directory")?user:current));
  const h=harness({...backend(),PC_SESSION_URL:"https://pc.invalid/session",PC_DIRECTORY_URL:"https://pc.invalid/directory",
    PC_ADMIN_IDS:"admin",PC_SERVICE_TOKEN:"test"});
  h.jar.set("pc_session","test");
  await h.data();
  await h.act({op:"assignRoles",userId:"sales",bg:"EBG",ids:["reviewer"],version:0});
  await h.act({op:"assignRoles",userId:"sales",bg:"SMB",ids:["editor"],version:1});
  current=user;
  const d=await h.data();
  const m=d.admin.published.find(m=>m.id==="retail");
  await h.act({...m,id:"",mid:m.id,op:"save",bg:"SMB"},403);
  await h.act({op:"withdraw",id:m.id,comment:"错误范围"},403);
  assert(!d.user.scopes.find(g=>g.bg==="EBG").caps.includes("edit"));
  assert(!d.user.scopes.find(g=>g.bg==="SMB").caps.includes("review"));
});

test("platform administrator synchronizes portal directory pages and retains inactive account status",async(t)=>{
  const {profiles}=await import("../server/seed.js");
  let current=profiles.admin;
  t.mock.method(globalThis,"fetch",async (url,options)=>{
    if(String(url).includes("/session")) return Response.json(current);
    assert.equal(options.headers.authorization,"Bearer service");
    const next=new URL(url).searchParams.has("cursor");
    return Response.json({users:[next?{...profiles.editor,active:false}:profiles.sales],next_cursor:next?null:"next"});
  });
  const h=harness({...backend(),PC_SESSION_URL:"https://pc.invalid/session",PC_USERS_URL:"https://pc.invalid/users",
    PC_SERVICE_TOKEN:"service",PC_ADMIN_IDS:"admin"});
  h.jar.set("pc_session","test");
  await h.act({op:"syncDirectory"});
  assert.equal((await h.data()).admin.system.cursor,"next");
  await h.act({op:"syncDirectory"});
  const system=(await h.data()).admin.system;
  assert.equal(system.cursor,"");
  assert(system.accounts.some(p=>p.id==="sales"));
  assert(system.accounts.some(p=>p.id==="editor" && !p.active));
  current=profiles.reviewer;
  await h.act({op:"syncDirectory"},403);
  await h.act({op:"saveFlow",bg:"EBG"},403);
});

test("separate origins share the library and protect the management entry",async()=>{
  const env={...backend(),LOCAL_RUNTIME:true,LOCAL_WORKSPACE:"local",ADMIN_ORIGIN:"https://admin.test"};
  const adminEnv={PORTAL_ORIGIN:"https://portal.test",LOCAL_API:{fetch:r=>worker.fetch(r,env)}};
  const get=(path,id)=>adminWorker.fetch(new Request("https://admin.test"+path,{headers:{cookie:"material_profile="+id}}),adminEnv);
  for(const role of ["partner","partnerVn","sales"]){
    assert.equal((await get("/",role)).status,403);
    assert.equal((await get("/api/admin/state",role)).status,403);
  }
  assert.equal((await get("/","editor")).status,200);
  assert.equal((await get("/app.js","editor")).status,404);
  assert.equal((await worker.fetch(new Request("https://portal.test/admin.js"),env)).status,404);
  assert.equal((await worker.fetch(new Request("https://portal.test/manage"),env)).headers.get("location"),"https://admin.test/");
  const foreign=new Request("https://admin.test/api/profile",{method:"POST",headers:{origin:"https://other.test","x-material-client":"hub"}});
  assert.equal((await adminWorker.fetch(foreign,adminEnv)).status,403);
});

test("scheduled releases wait for final approval and the deadline, then recall only actual version downloaders", async t => {
  const start = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const env = { ...backend(), LOCAL_RUNTIME: true, LOCAL_WORKSPACE: "schedule-test" };
  const h = harness(env);
  await h.user("editor");
  const data = new FormData();
  data.append("file", new Blob(["投标附件内容"]), "投标附件.txt");
  const upload = await (await h.get("/api/upload", data)).json();
  const rules = [{ role: "伙伴", bg: "EBG", region: "东南亚", country: ["VN"], channel: ["集成"] }];
  const save = { op: "save", title: "排期资料", summary: "越南投标材料", type: "客户案例",
    cat: "园区网络", bg: "EBG", defaultView: rules, defaultDownload: rules,
    files: [{ id: upload.id, inherit: true, usage: "可发客户" }], submit: true };
  const publishAt = new Date(start + 60000).toISOString();
  await h.act({ ...save, publishAt: "2026-12-03T10:00" }, 400);
  await h.act({ ...save, publishAt, expires: "2020-01-01" }, 400);
  await h.act({ ...save, publishAt });
  const draft = (await h.data()).admin.drafts[0];
  const url = "/api/file?mode=download&m=" + draft.mid + "&f=" + upload.id;
  await h.user("reviewer");
  await h.act({ op: "review", approve: true, id: draft.id });
  assert.equal((await h.data()).admin.drafts[0].state, "待定时发布");
  await h.user("editor");
  await h.act({ ...save, id: draft.id }, 409);
  await h.user("partnerVn");
  await h.act({ op: "cancelSchedule", id: draft.id, publishAt }, 403);
  t.mock.timers.setTime(start + 59999);
  assert(!(await h.data()).materials.some(m => m.id === draft.mid));
  assert.equal((await h.get(url)).status, 404);
  t.mock.timers.setTime(start + 60000);
  // Exercise the unattended handler before any visitor reads the library.
  let job;
  worker.scheduled({}, env, { waitUntil: work => { job = work; } });
  await job;
  const persisted = JSON.parse(await (await env.BUCKET.get("state/schedule-test")).text());
  assert.equal(persisted.materials.find(m => m.id === draft.mid).version, 1);
  assert.equal(await (await h.get(url)).text(), "投标附件内容");
  assert.equal(await (await h.get(url)).text(), "投标附件内容");
  await h.user("partner");
  assert.equal((await h.get(url)).status, 404);
  await h.user("editor");
  const later = new Date(start + 120000).toISOString();
  const revise = { ...save, mid: draft.mid, title: "第二版", publishAt: later };
  await h.act(revise);
  const second = (await h.data()).admin.drafts[0];
  await h.user("reviewer");
  await h.act({ op: "review", approve: true, id: second.id });
  await h.user("partnerVn");
  assert.equal((await h.data()).materials.find(m => m.id === draft.mid).title, save.title);
  await h.user("editor");
  await h.act({ op: "cancelSchedule", id: second.id, publishAt: later });
  assert.equal((await h.data()).admin.drafts[0].state, "已退回");
  // Schedule it again, then withdraw the live version before the next release.
  await h.act({ ...revise, id: second.id });
  await h.user("reviewer");
  await h.act({ op: "review", approve: true, id: second.id });
  await h.act({ op: "withdraw", id: draft.mid, version: 2, comment: "校对" }, 409);
  await h.act({ op: "withdraw", id: draft.mid, version: 1, comment: "报价需校对", replacementId: "internal" });
  t.mock.timers.setTime(start + 120000);
  await h.user("partnerVn");
  assert.equal((await h.get(url)).status, 404);
  const notices = (await h.data()).notices.filter(n => n.msg.includes("停止使用"));
  assert.equal(notices.length, 1);
  assert.match(notices[0].msg, /v1.*报价需校对/);
  assert(!notices[0].mid && !notices[0].replacementId);
  await h.user("partner");
  assert(!(await h.data()).notices.some(n => n.msg.includes("停止使用")));
});

test("late final approval releases immediately and scheduled demand delivery waits for publication", async t => {
  const start = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const h = harness();
  await h.data();
  await h.act({ op: "request", title: "投标案例", purpose: "客户投标", external: true });
  const req = (await h.data()).requests[0].id;
  await h.user("editor");
  const base = (await h.data()).admin.published.find(m => m.id === "retail");
  const fileId = base.files[0].id;
  const save = { ...base, op: "save", id: "", mid: base.id, submit: true, req,
    deliveryFiles: [fileId], publishAt: new Date(start + 60000).toISOString() };
  await h.act(save);
  const draft = (await h.data()).admin.drafts[0];
  await h.user("reviewer");
  await h.act({ op: "review", approve: true, id: draft.id });
  await h.user("partner");
  assert.equal((await h.data()).requests[0].status, "待定时发布");
  assert.equal((await h.data()).materials.find(m => m.id === base.id).version, base.version);
  t.mock.timers.setTime(start + 60000);
  const [a,b] = await Promise.all([h.data(), h.data()]);
  for (const state of [a,b]) {
    assert.equal(state.requests[0].status, "已交付");
    assert.equal(state.requests[0].version, base.version + 1);
    assert.equal(state.notices.filter(n => n.rid === req).length, 1);
  }
  await h.user("editor");
  await h.act({ ...save, req: "", title: "尚未终审", publishAt: new Date(start + 120000).toISOString() });
  const next = (await h.data()).admin.drafts[0];
  t.mock.timers.setTime(start + 180000);
  await h.user("partner");
  assert(!(await h.data()).materials.some(m => m.title === "尚未终审"));
  await h.user("reviewer");
  await h.act({ op: "review", approve: true, id: next.id });
  assert.equal((await h.data()).admin.published.find(m => m.id === base.id).version, base.version + 2);
});

test("target account preview, search context, merged delivery, opportunity versions and dated reviews", async () => {
  const {matchesMaterial}=await import("../shared/discovery.js");
  const h=harness();
  await h.data();
  const filters={query:"UniWiFi",language:"Tiếng Việt",market:"VN"};
  await h.act({op:"searchMiss",filters});
  await h.act({op:"request",title:"当地投标资料",purpose:"下周投标",searchContext:filters,affiliation:1});
  const th=(await h.data()).requests[0];
  assert.equal(th.country,"TH");assert.equal(th.searchContext.query,"UniWiFi");
  await h.user("partnerVn");
  await h.act({op:"request",title:"当地投标资料",purpose:"系统集成",external:true});
  const vn=(await h.data()).requests[0];
  await h.user("editor");
  await h.act({op:"mergeDemand",id:th.id,childId:vn.id});
  await h.act({op:"planDemand",id:th.id,promised:"2033-09-01"});
  await h.act({op:"claim",id:th.id});
  const form=new FormData();
  form.append("file",new Blob(["partner tender guide"]),"guide.txt");
  const file=await (await h.get("/api/upload",form)).json();
  const rules=[{role:"伙伴",bg:"EBG",region:"东南亚",country:["TH"],channel:"全部"}];
  const save={op:"save",bg:"EBG",title:"手册",type:"客户案例",cat:"园区网络",summary:"产品资料",
    language:"Tiếng Việt",markets:["VN"],models:["RG-X100"],aliases:["UniWiFi"],reviewOn:"2031-06-02",
    defaultView:rules,defaultDownload:rules,req:th.id,deliveryFiles:[file.id],submit:true,
    files:[{id:file.id,inherit:true,usage:"可发客户"}]};
  await h.act(save);
  const draft=(await h.data()).admin.drafts[0];
  const target=async (id,userId)=>(await h.get("/api/admin/audience-preview",{id,userId})).json();
  const est=await target(draft.id,"partner");
  assert.equal(est.card.title,"手册");assert.equal(est.card.files[0].canDownload,true);
  const denied=await target(draft.id,"partnerVn");
  assert.equal(denied.card,null);assert.match(denied.files[0].reason,/国家/);
  await h.user("reviewer");await h.act({op:"review",id:draft.id,approve:true});
  await h.user("partner");
  const d=await h.data(),m=d.materials.find(m=>m.id===draft.mid);
  assert.deepEqual(est.card.files,m.files);
  assert(matchesMaterial(m,filters));assert(matchesMaterial(m,{query:"rgx100"}));
  assert(!matchesMaterial(m,{query:"rgx100",language:"ไทย"}));
  assert.equal(d.requests[0].status,"已交付");
  assert.equal((await h.get("/api/admin/audience-preview",{id:m.id,userId:"partnerVn"})).status,403);
  await h.act({op:"createOpportunity",name:"学校"});
  await h.act({op:"createOpportunity",name:"门店"});
  const list=(await h.data()).opportunities[0];
  await h.act({op:"saveOpportunityItem",listId:list.id,mid:m.id});
  assert.equal((await h.data()).opportunities[0].items[0].status,"可用");
  await h.user("partnerVn");
  const pending=(await h.data()).requests[0];
  assert.equal(pending.status,"处理中"); assert.equal(pending.promised,"2033-09-01");
  assert(!pending.material);assert(!(await h.data()).opportunities.length);
  await h.user("editor");
  const report=await (await h.get("/api/admin/gaps")).json();
  assert.equal(report.terms[0].count,1);assert(report.demand.some(x=>x.label.includes("TH · 经销")));
  await h.act({op:"contentReview",id:m.id,version:m.version,ownerId:"reviewer",reviewOn:"2033-10-01",confirm:true});
  await h.act({op:"contentReview",id:m.id,version:m.version,ownerId:"editor",reviewOn:"2033-10-05"},409);
  await h.act({...save,req:"",mid:m.id});
  const next=(await h.data()).admin.drafts[0];
  await h.user("reviewer");await h.act({op:"review",id:next.id,approve:true});
  await h.user("partner");
  assert.equal((await h.data()).opportunities[0].items[0].status,"已换版");
  await h.act({op:"saveOpportunityItem",listId:list.id,mid:m.id});
  await h.user("editor");await h.act({op:"withdraw",id:m.id,version:2,comment:"更新规格"});
  await h.user("partner");
  const old=(await h.data()).opportunities[0].items[0];
  assert.equal(old.status,"已下架");assert.equal(old.mid,null);
  await h.act({op:"removeOpportunityItem",listId:list.id,key:old.key});
  assert.equal((await h.data()).opportunities[0].items.length,0);
});

test("unattended writer publishes once and queues notices before any visitor reads",async t=>{
  const start=Date.now();
  t.mock.timers.enable({apis:["Date"],now:start});
  const env={...backend(),SHARED_DEMO_SPACE:"deedeedd-beef-4000-8000-000000000000",PRIVATE_SITE_MAINTENANCE:"enabled"};
  const h=harness(env);
  await h.data();await h.user("editor");
  const base=(await h.data()).admin.published.find(m=>m.id==="retail");
  await h.act({...base,id:"",mid:base.id,op:"save",submit:true,publishAt:new Date(start+30000).toISOString()});
  const draft=(await h.data()).admin.drafts[0];
  await h.user("reviewer");await h.act({op:"review",id:draft.id,approve:true});
  const tick=()=>worker.fetch(new Request("https://local.test/internal/maintenance",{method:"POST",headers:{"x-material-task":"release-due"}}),env);
  assert.equal((await worker.fetch(new Request("https://local.test/internal/maintenance"),env)).status,403);
  t.mock.timers.setTime(start+30001);
  const first=await (await tick()).json();
  assert.equal(first.released,1);assert(first.notified>0);
  const receipt=JSON.parse(await (await env.BUCKET.get("maintenance/"+env.SHARED_DEMO_SPACE)).text());
  assert.deepEqual(receipt,first);
  const repeat=await (await tick()).json();
  assert.equal(repeat.released,0);assert.equal(repeat.notified,0);
  await h.user("partner");assert((await h.data()).notices.some(n=>n.mid===base.id));
});

test("paged PDF preview isolates the selected visual page and rechecks attachment access", async () => {
  const { PDFDocument, PDFName, PDFString } = await import("pdf-lib");
  const source = await PDFDocument.create();
  source.setTitle("Unpublished source metadata");
  source.addPage().drawText("First page");
  const second = source.addPage();
  second.drawText("Second page");
  const privateNote = source.context.obj({ Type: "Annot", Subtype: "Text", Contents: PDFString.of("Private review note") });
  second.node.set(PDFName.of("Annots"), source.context.obj([source.context.register(privateNote)]));
  await source.attach(new TextEncoder().encode("Source-only attachment"), "private.txt");
  const original = await source.save();
  const h = harness();
  await h.user("editor");
  const form = new FormData();
  form.append("file", new Blob([original]), "two-pages.pdf");
  const file = await (await h.get("/api/upload", form)).json();
  const rules = [{ role: "伙伴", bg: "EBG", region: "东南亚", country: ["VN"], channel: ["集成"] }];
  await h.act({ op: "save", title: "图文预览", summary: "两页", submit: true, bg: "EBG",
    cat: "园区网络", type: "客户案例", defaultView: rules, defaultDownload: [],
    files: [{ id: file.id, inherit: true, usage: "伙伴学习" }] });
  await h.user("reviewer");
  const draft = (await h.data()).admin.drafts[0];
  const draftPreview = "/api/file?draft=1&m=" + draft.id + "&f=" + file.id + "&mode=layout";
  assert.deepEqual(await (await h.get(draftPreview)).json(), { count: 2, type: "pdf" });
  await h.act({ op: "review", approve: true, id: draft.id });
  await h.user("partnerVn");
  const base = "/api/file?m=" + draft.mid + "&f=" + file.id;
  assert.equal((await h.get(base + "&mode=download")).status, 403);
  const layout = base + "&mode=layout";
  assert.equal((await h.get(layout + "&page=3")).status, 404);
  const page = await h.get(layout + "&page=2");
  assert.equal(page.headers.get("content-type"), "application/pdf");
  const derived = await PDFDocument.load(await page.arrayBuffer(), { updateMetadata: false });
  assert.equal(derived.getPageCount(), 1);
  assert.equal(derived.getTitle(), undefined);
  assert(!derived.catalog.toString().includes("Names"));
  assert(!derived.context.enumerateIndirectObjects().some(([,object]) => object.toString().includes("Private review note")));
  await h.user("partner");
  assert.equal((await h.get(layout + "&page=2")).status, 404);
  await h.user("editor");
  await h.act({ op: "withdraw", id: draft.mid, comment: "验收结束" });
  await h.user("partnerVn");
  assert.equal((await h.get(layout + "&page=2")).status, 404);
});

test("a merged request is delivered separately to every eligible submitter", async()=>{
  const h=harness();
  await h.data();
  const users=["partner","partnerVn","sales"];
  const requests=[];
  for(const id of users){
    await h.user(id);
    await h.act({op:"request",title:"门店统一制作",purpose:"内部研究"});
    requests.push((await h.data()).requests[0].id);
  }
  await h.user("editor");
  for(const id of requests.slice(1)) await h.act({op:"mergeDemand",id:requests[0],childId:id});
  await h.act({op:"mergeDemand",id:requests[1],childId:requests[0]},409);
  const f=new FormData();f.append("file",new Blob(["统一介绍"]),"统一.txt");
  const original=await (await h.get("/api/upload",f)).json();
  const rules=[{role:"全部",bg:"EBG",country:"全部",region:"全部",channel:"全部"}];
  await h.act({op:"save",summary:"门店案例",title:"门店方案",type:"客户案例",cat:"园区网络",bg:"EBG",files:[{id:original.id,inherit:true,usage:"可发客户"}],
    defaultView:rules,defaultDownload:rules,submit:true,req:requests[0],deliveryFiles:[original.id]});
  const draft=(await h.data()).admin.drafts[0];
  await h.user("reviewer");await h.act({op:"review",id:draft.id,approve:true});
  for (const [i,id] of users.entries()){
    await h.user(id);
    const s=await h.data();
    assert(s.requests.some(r=>r.id===requests[i] && r.material===draft.mid && r.status==="已交付"));
    assert.equal(s.notices.filter(n=>n.rid===requests[i]).length,1);
    assert(!s.notices.some(n=>n.rid && n.rid!==requests[i]));
  }
});
