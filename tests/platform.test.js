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
  dom.window.close();
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
  t.mock.method(globalThis, "fetch", async () => Response.json(current));
  const h = harness({ ...backend(), PC_SESSION_URL:"https://pc.invalid/session" });
  h.jar.set("pc_session", "test");
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
