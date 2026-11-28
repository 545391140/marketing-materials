import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const grant = (bg, country = "TH") => ({
  bg,
  country,
  region: "东南亚",
  channel: "经销",
});
const employee = (id, role, bg = "EBG") => ({
  id,
  name: id,
  role,
  job: "售前",
  grants: [grant(bg)],
  active: true,
});
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}
test("PC and OA gateways share employee work, isolate delegation, route approvals and persist an authorized download", async (t) => {
  const staff = [
    employee("writer", "editor"),
    employee("approver", "reviewer"),
    employee("other", "reviewer", "SBG"),
    employee("admin", "sales"),
    employee("tech", "sales"),
    employee("service", "sales"),
  ];
  staff[3].grants.push(grant("SBG"));
  const tech = staff[4];
  tech.pcAccountId = "pc-tech";
  tech.delegations = [
    { companyId: "acme", name: "Acme", grants: [grant("EBG")] },
  ];
  staff[5].job = "售后";
  const partners = ["partner", "foreign"].map((id, i) => ({
    id,
    name: id,
    role: "partner",
    grants: [{ ...grant("EBG", i ? "VN" : "TH"), companyId: "acme" }],
  }));
  const pc = [
    ...partners,
    { id: "pc-tech", role: "sales" },
    { id: "pc-service", role: "sales" },
    { id: "pc-writer", employeeId: "writer", role: "editor" },
  ];
  const adapter = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost"),
      key = req.headers.authorization?.slice(7);
    let result;
    if (url.pathname === "/scan") result = { clean: true };
    if (url.pathname === "/oa/session")
      result = staff.find((p) => p.id === key);
    if (url.pathname === "/pc/session") result = pc.find((p) => p.id === key);
    if (url.pathname.endsWith("/directory") && key === "service-token") {
      const [field, value] = [...url.searchParams][0];
      result = (url.pathname.startsWith("/oa") ? staff : pc).find(
        (p) => p[field] === value
      );
    }
    if (url.pathname === "/oa/users" && key === "service-token")
      result = { users: staff };
    res
      .writeHead(result ? 200 : 404, { "content-type": "application/json" })
      .end(JSON.stringify(result || {}));
  });
  const authority = "http://127.0.0.1:" + (await listen(adapter));
  t.after(() => new Promise((resolve) => adapter.close(resolve)));
  const ports = await Promise.all([freePort(), freePort(), freePort()]);
  const [portal, admin] = ports.map((p) => "http://127.0.0.1:" + p);
  const dir = await mkdtemp(path.join(tmpdir(), "materials-enterprise-"));
  const script = fileURLToPath(
    new URL("../scripts/local.mjs", import.meta.url)
  );
  let app;
  async function stop() {
    if (app && app.exitCode === null && app.signalCode === null) {
      const done = once(app, "exit");
      app.kill();
      await done;
    }
  }
  t.after(async () => {
    await stop();
    await rm(dir, { recursive: true, force: true });
  });
  async function start() {
    app = spawn(process.execPath, [script], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: ports[0],
        ADMIN_PORT: ports[1],
        CUSTOMER_PORT: ports[2],
        PORTAL_ORIGIN: portal,
        ADMIN_ORIGIN: admin,
        DEMO_MODE: "false",
        PC_SESSION_URL: authority + "/pc/session",
        OA_SESSION_URL: authority + "/oa/session",
        PC_DIRECTORY_URL: authority + "/pc/directory",
        OA_DIRECTORY_URL: authority + "/oa/directory",
        OA_USERS_URL: authority + "/oa/users",
        PC_SERVICE_TOKEN: "service-token",
        OA_SERVICE_TOKEN: "service-token",
        OA_ADMIN_IDS: "admin",
        SCAN_URL: authority + "/scan",
      },
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(portal)).ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw Error("Local application did not start");
  }
  await start();
  function client(base, cookie) {
    return async (endpoint, payload, expected = 200) => {
      const form = payload instanceof FormData;
      const r = await fetch(base + "/api/" + endpoint, {
        method: payload ? "POST" : "GET",
        headers: {
          cookie,
          "x-material-client": "hub",
          ...(payload && !form ? { "content-type": "application/json" } : {}),
        },
        body: payload ? (form ? payload : JSON.stringify(payload)) : undefined,
      });
      const result = await r.text();
      assert.equal(r.status, expected, endpoint + " " + result.slice(0, 200));
      return r.headers.get("content-type")?.includes("application/json")
        ? JSON.parse(result)
        : result;
    };
  }
  const oa = (id) => client(admin, "oa_session=" + id);
  const byPartner = (id) => client(portal + "/pc", "pc_session=" + id);
  const cookies = "oa_session=tech; pc_session=pc-tech";
  const pcTech = client(portal + "/pc", cookies),
    oaTech = client(portal + "/oa", cookies);
  const root = oa("admin"),
    writer = oa("writer"),
    reviewer = oa("approver"),
    other = oa("other"),
    partner = byPartner("partner");
  await root("actions", { op: "syncDirectory", source: "OA" });
  await pcTech("actions", { op: "fav", id: "campus" });
  assert.deepEqual((await oaTech("portal/state")).prefs.fav, ["campus"]);
  assert.equal(
    (await oaTech("portal/state")).user.id,
    (await pcTech("portal/state")).user.id
  );
  await client(admin, "pc_session=pc-writer")("admin/state", null, 401);
  await byPartner("pc-writer")("actions", { op: "save" }, 403);
  await byPartner("pc-service")("state", null, 403);
  await client(portal + "/oa", "oa_session=service; pc_session=pc-service")(
    "identity/bind",
    {}
  );
  assert.equal(
    (await byPartner("pc-service")("portal/state")).user.job,
    "售后"
  );
  await partner("actions", {
    op: "request",
    title: "渠道拜访资料",
    purpose: "客户拜访",
    needDownload: true,
  });
  const request = (await partner("portal/state")).requests[0];
  const fd = new FormData(),
    contents = "渠道客户拜访说明\n第二页附件原文";
  fd.append("file", new Blob([contents]), "外发说明.txt");
  const external = await writer("upload", fd);
  const internalForm = new FormData();
  internalForm.append("file", new Blob(["售前技术文档"]), "内部说明.txt");
  const internal = await writer("upload", internalForm);
  const scope = { bg: "EBG", region: "全部", channel: "全部", country: "全部" };
  const jobs = { ...scope, role: "员工", job: "售前" };
  const contracted = {
    ...scope,
    role: "伙伴",
    companyId: "acme",
    country: ["TH"],
  };
  const save = {
    op: "save",
    title: "双入口验收资料",
    summary: "拜访使用",
    bg: "EBG",
    type: "客户案例",
    cat: "园区网络",
    submit: true,
    req: request.id,
    deliveryFiles: [external.id],
    defaultView: [jobs, contracted],
    defaultDownload: [jobs, contracted],
    files: [
      { id: external.id, inherit: true, usage: "可发客户" },
      {
        id: internal.id,
        inherit: false,
        view: [jobs],
        download: [jobs],
        usage: "仅内部",
      },
    ],
  };
  const blocked = await writer("actions", save);
  assert.match(blocked.blocked, /未命中/);
  assert.equal(
    (await writer("admin/state")).admin.drafts.find(
      (d) => d.id === blocked.draftId
    ).state,
    "草稿"
  );
  assert((await root("admin/state")).notices.some((n) => n.flowBg === "EBG"));
  await root("actions", {
    op: "saveFlow",
    bg: "EBG",
    priority: 1,
    type: "客户案例",
    active: true,
    name: "业务审核",
    steps: [
      { name: "EBG 技术审核", roleId: "reviewer" },
      { name: "SBG 联合审核", bg: "SBG", roleId: "reviewer" },
    ],
  });
  await writer("actions", { ...save, id: blocked.draftId });
  let pending = (await reviewer("admin/state")).admin.drafts.find(
    (d) => d.id === blocked.draftId
  );
  assert.equal(pending.state, "待审核");
  assert(
    (await reviewer("admin/state")).notices.some(
      (n) => n.draftId === pending.id
    )
  );
  assert(
    !(await other("admin/state")).notices.some((n) => n.draftId === pending.id)
  );
  const review = {
    op: "review",
    id: pending.id,
    approve: true,
    stepToken: pending.approval.token,
  };
  await other("actions", review, 403);
  await writer("actions", review, 403);
  await reviewer("actions", review);
  pending = (await other("admin/state")).admin.drafts.find(
    (d) => d.id === blocked.draftId
  );
  assert.equal(pending.approval.index, 1);
  assert(
    (await other("admin/state")).notices.some((n) => n.draftId === pending.id)
  );
  assert.equal(
    (await other("file?draft=1&m=" + pending.id + "&f=" + external.id)).text,
    contents
  );
  await reviewer(
    "actions",
    { ...review, stepToken: pending.approval.token },
    403
  );
  await other("actions", { ...review, stepToken: pending.approval.token });
  const state = await partner("portal/state"),
    m = state.materials.find((x) => x.title === save.title);
  assert.equal(
    state.requests.find((r) => r.id === request.id).status,
    "已交付"
  );
  assert(state.notices.some((n) => n.rid === request.id));
  assert.deepEqual(
    m.files.map((f) => f.id),
    [external.id]
  );
  const download = "file?m=" + m.id + "&mode=download&f=";
  assert.equal(await partner(download + external.id), contents);
  await byPartner("foreign")(download + external.id, null, 404);
  assert.equal(
    (await pcTech("portal/state")).materials.find((x) => x.id === m.id).files
      .length,
    2
  );
  assert.equal(
    (await byPartner("pc-service")("portal/state")).materials.some(
      (x) => x.id === m.id
    ),
    false
  );
  const { path: companyPath } = await pcTech("identity/context", {
    companyId: "acme",
  });
  const delegated = client(portal + companyPath.slice(0, -1), cookies);
  assert.equal((await delegated("portal/state")).user.org, "Acme");
  assert.deepEqual((await delegated("portal/state")).prefs.fav, []);
  await delegated(download + internal.id, null, 404);
  assert.equal(await delegated(download + external.id), contents);
  const audit = (await root("admin/state")).admin.audit;
  assert(
    audit.some(
      (e) =>
        e.actorId === "oa:tech" &&
        e.companyId === "acme" &&
        e.action === "下载附件"
    )
  );
  tech.delegations = [];
  await delegated("portal/state", null, 403);
  await stop();
  await start();
  assert.equal(await partner(download + external.id), contents);
  tech.active = false;
  await pcTech("portal/state", null, 403);
  await oaTech("portal/state", null, 401);
});
