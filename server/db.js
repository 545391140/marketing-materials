import { seed, profiles } from "./seed.js";
import { need, uid } from "./access.js";
export async function readState(env, ns) {
  const o = await env.BUCKET.get("state/" + ns);
  return o
    ? { s: JSON.parse(await o.text()), tag: o.etag }
    : { s: seed(), tag: null };
}
export async function update(env, ns, op) {
  for (let i = 0; i < 5; i++) {
    const { s, tag } = await readState(env, ns);
    const result = await op(s);
    const obj = await env.BUCKET.put("state/" + ns, JSON.stringify(s), {
      onlyIf: tag ? { etagMatches: tag } : { etagDoesNotMatch: "*" },
    });
    if (obj) return result;
  }
  need(false, 409, "数据已更新，请重试");
}
export const cookie = (req, key) =>
  (
    (req.headers.get("cookie") || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(key + "=")) || ""
  ).slice(key.length + 1);
export function safeProfile(u) {
  need(
    u &&
      validId(u.id) &&
      ["partner", "sales", "editor", "reviewer"].includes(u.role) &&
      Array.isArray(u.grants) &&
      u.active !== false,
    401,
    "账号不可用，请从所属工作台重新登录"
  );
  return {
    id: u.id,
    name: u.name || u.id,
    role: u.role,
    grants: u.grants
      .filter((g) => g && g.active !== false && typeof g.bg === "string")
      .map((g) => ({
        ...g,
        country:
          typeof g.country === "string"
            ? g.country.trim().toUpperCase()
            : undefined,
      })),
    audienceCatalog: u.audienceCatalog,
    org: u.org || "",
    en: u.en || u.name,
  };
}
export async function identity(req, env) {
  if (env.OA_SESSION_URL) return enterpriseIdentity(req, env);
  if (env.PC_SESSION_URL) {
    const u = safeProfile(await session(req, env, "PC"));
    return { u, ns: "portal", demo: false };
  }
  need(env.DEMO_MODE === "true", 503, "尚未配置门户身份服务");
  const select = cookie(req, "material_profile");
  const u = Object.hasOwn(profiles, select)
    ? profiles[select]
    : profiles.partner;
  if (env.LOCAL_RUNTIME && env.LOCAL_WORKSPACE)
    return {
      u,
      ns: env.LOCAL_WORKSPACE,
      demo: true,
      workspaceMode: "local-shared",
    };
  let ns = cookie(req, "material_space");
  let fresh = !/^[a-f0-9-]{36}$/.test(ns);
  if (fresh) ns = env.SHARED_DEMO_SPACE || uid();
  return {
    u,
    ns,
    demo: true,
    fresh,
    workspaceMode: env.LOCAL_RUNTIME
      ? "local-isolated"
      : ns === env.SHARED_DEMO_SPACE
      ? "hosted-shared"
      : "isolated",
  };
}
export async function recipient(ctx, env, id) {
  if (ctx.demo) return Object.hasOwn(profiles, id) ? profiles[id] : null;
  if (ctx.u.id === id) return ctx.u;
  if (env.OA_SESSION_URL) return enterpriseRecipient(env, id);
  if (!env.PC_DIRECTORY_URL || !env.PC_SERVICE_TOKEN) return null;
  const url = new URL(env.PC_DIRECTORY_URL);
  url.searchParams.set("id", id);
  const r = await fetch(url, {
    headers: { Authorization: "Bearer " + env.PC_SERVICE_TOKEN },
  });
  if (!r.ok) return null;
  const obj = await r.json();
  return obj.active !== false && obj.id === id ? safeProfile(obj) : null;
}

function validId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    value.trim() === value &&
    !Object.hasOwn(Object.prototype, value)
  );
}
function providerId(id) {
  need(
    validId(id) && id.length <= 200 && !/^(oa:|as:)/.test(id),
    401,
    "外部账号标识无效"
  );
  return id;
}
async function session(req, env, source) {
  const endpoint = env[source + "_SESSION_URL"];
  const token = cookie(
    req,
    env[source + "_COOKIE_NAME"] || source.toLowerCase() + "_session"
  );
  need(
    endpoint && token,
    401,
    "请先登录 " + (source === "PC" ? "Partner Center" : "OA 工作台")
  );
  const r = await fetch(endpoint, {
    headers: { Authorization: "Bearer " + token },
    redirect: "error",
  });
  need(r.ok, 401, "登录已失效");
  const person = await r.json();
  need(person.active !== false, 401, "账号已停用");
  providerId(person.id);
  return person;
}
async function directory(env, source, key, id) {
  const endpoint = env[source + "_DIRECTORY_URL"],
    token = env[source + "_SERVICE_TOKEN"];
  need(endpoint && token, 503, source + " 目录未配置");
  const url = new URL(endpoint);
  url.searchParams.set(key, id);
  const response = await fetch(url, {
    headers: { Authorization: "Bearer " + token },
    redirect: "error",
  });
  if (response.status === 404) return null;
  need(response.ok, 503, source + " 目录暂不可用");
  const p = await response.json();
  return p && p.active !== false && p[key] === id ? p : null;
}
// The authoritative OA directory identifies employees by immutable employee ID.
// A verified historical PC ID preserves references in the existing workspace.
export function employeeProfile(row, businessId) {
  providerId(row.id);
  need(row.role !== "partner", 403, "需要在职员工身份");
  const id =
    businessId ||
    (row.legacyPcId ? providerId(row.legacyPcId) : "oa:" + row.id);
  const p = safeProfile({ ...row, id });
  return {
    ...p,
    employeeId: row.id,
    job: row.job || "",
    delegations: (row.delegations || []).filter(
      (d) =>
        d &&
        validId(d.companyId) &&
        d.active !== false &&
        Array.isArray(d.grants)
    ),
  };
}
function delegate(p, companyId) {
  const d = p.delegations?.find((v) => v.companyId === companyId);
  need(d, 403, "当前员工没有该企业的代办授权");
  const id =
    "as:" + encodeURIComponent(p.id) + "/" + encodeURIComponent(companyId);
  return {
    ...p,
    id,
    actorId: p.id,
    role: "partner",
    org: d.name || companyId,
    companyId,
    job: "",
    grants: d.grants
      .filter((g) => g?.active !== false && g?.bg)
      .map((g) => ({ ...g, country: g.country?.toUpperCase(), companyId })),
  };
}
export function directoryEmployee(row, state, verifiedPcId) {
  const previous = state.directory?.find((x) => x.employeeId === row.id);
  const pcId = row.legacyPcId || row.pcAccountId || verifiedPcId;
  const legacy = pcId && state.directory?.find((x) => x.id === pcId);
  need(
    !legacy ||
      (legacy.role !== "partner" &&
        (!legacy.employeeId || legacy.employeeId === row.id) &&
        (!previous || previous.id === legacy.id)),
    409,
    "历史账号归属需核对，请检查员工目录的 legacyPcId"
  );
  return employeeProfile(row, previous?.id || legacy?.id);
}
async function resolveEmployee(env, pc, oa, state) {
  const link = pc && state.identityLinks?.find((x) => x.pcId === pc.id);
  let row;
  if (oa || pc.employeeId || link) {
    row = await directory(
      env,
      "OA",
      "id",
      oa?.id || pc.employeeId || link.employeeId
    );
  } else {
    row = await directory(env, "OA", "pcAccountId", pc.id);
  }
  need(
    row &&
      (!pc ||
        row.pcAccountId === pc.id ||
        pc.employeeId === row.id ||
        link?.employeeId === row.id),
    403,
    "员工账号尚未核实，请从 OA 核对并关联 PC 账号"
  );
  need(
    !pc || !row.pcAccountId || row.pcAccountId === pc.id,
    403,
    "PC 与员工目录绑定不一致"
  );
  need(!pc?.employeeId || pc.employeeId === row.id, 403, "员工标识不一致");
  const person = directoryEmployee(row, state, pc?.id);
  const previous = state.directory?.find((x) => x.id === person.id);
  need(
    !previous ||
      (previous.role !== "partner" &&
        (!previous.employeeId || previous.employeeId === row.id)),
    409,
    "业务账号已有不同归属，请核对历史账号"
  );
  return person;
}
async function enterpriseIdentity(req, env) {
  const entry = req.headers.get("x-material-entry");
  const source =
    entry === "oa" ||
    (!entry && !cookie(req, env.PC_COOKIE_NAME || "pc_session"))
      ? "OA"
      : "PC";
  const auth = await session(req, env, source);
  const { s } = await readState(env, "portal");
  let actor;
  if (source === "PC" && auth.role === "partner") {
    need(
      !s.directory?.some((p) => p.id === auth.id && p.role !== "partner"),
      403,
      "账号归属发生变化，请核对"
    );
    actor = safeProfile(auth);
  } else
    actor = await resolveEmployee(
      env,
      source === "PC" ? auth : null,
      source === "OA" ? auth : null,
      s
    );
  let company = req.headers.get("x-material-company") || "";
  try {
    company = decodeURIComponent(company);
  } catch {
    need(false, 400, "企业标识无效");
  }
  const u = company ? delegate(actor, company) : actor;
  return { u, actor, source, ns: "portal", demo: false };
}
export async function bindPc(req, env, ctx) {
  need(
    ctx.source === "OA" && ctx.u.employeeId && !ctx.u.actorId,
    403,
    "请从 OA 以本人身份关联"
  );
  const pc = await session(req, env, "PC");
  need(
    ["sales", "editor", "reviewer"].includes(pc.role) &&
      (!pc.employeeId || pc.employeeId === ctx.u.employeeId),
    403,
    "仅可关联本人的员工 PC 账号"
  );
  const owner = await directory(env, "OA", "pcAccountId", pc.id);
  const self = await directory(env, "OA", "id", ctx.u.employeeId);
  need(
    self &&
      (!self.pcAccountId || self.pcAccountId === pc.id) &&
      (!owner || owner.id === self.id),
    409,
    "目录已有其他绑定"
  );
  await update(env, "portal", (s) => {
    const links = (s.identityLinks ||= []);
    const old = links.find((x) => x.pcId === pc.id || x.employeeId === self.id);
    need(
      !old || (old.employeeId === self.id && old.pcId === pc.id),
      409,
      "账号已有其他绑定"
    );
    need(
      !s.directory?.some((p) => p.id === pc.id && p.id !== ctx.u.id),
      409,
      "此 PC 账号已有业务记录，请先核对历史归属"
    );
    if (!old) links.push({ pcId: pc.id, employeeId: self.id });
  });
}
async function enterpriseRecipient(env, id) {
  if (id.startsWith("as:")) {
    const parts = id.slice(3).split("/");
    if (parts.length !== 2) return null;
    const actor = await enterpriseRecipient(env, decodeURIComponent(parts[0]));
    const companyId = decodeURIComponent(parts[1]);
    return actor?.delegations?.some((d) => d.companyId === companyId)
      ? delegate(actor, companyId)
      : null;
  }
  const { s } = await readState(env, "portal");
  const known = s.directory?.find((p) => p.id === id);
  if (known?.employeeId || id.startsWith("oa:")) {
    const row = await directory(
      env,
      "OA",
      "id",
      known?.employeeId || id.slice(3)
    );
    return row && employeeProfile(row, id);
  }
  const pc = await directory(env, "PC", "id", id);
  if (!pc) return null;
  providerId(pc.id);
  if (pc.role === "partner")
    return known && known.role !== "partner" ? null : safeProfile(pc);
  try {
    const p = await resolveEmployee(env, pc, null, s);
    return p.id === id ? p : null;
  } catch (e) {
    if (e.status === 403 || e.status === 409) return null;
    throw e;
  }
}
