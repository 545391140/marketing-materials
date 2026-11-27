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
      typeof u.id === "string" &&
      ["partner", "sales", "editor", "reviewer"].includes(u.role) &&
      Array.isArray(u.grants) &&
      u.active !== false,
    401,
    "请从 Partner Center 重新登录",
  );
  return {
    id: u.id,
    name: u.name || u.id,
    role: u.role,
    grants: u.grants.filter((g) => g && g.active !== false && typeof g.bg === "string")
      .map((g) => ({ ...g, country: typeof g.country === "string" ? g.country.trim().toUpperCase() : undefined })),
    audienceCatalog: u.audienceCatalog,
    org: u.org || "",
    en: u.en || u.name,
  };
}
export async function identity(req, env) {
  if (env.PC_SESSION_URL) {
    const token = cookie(req, env.PC_COOKIE_NAME || "pc_session");
    need(token, 401, "请先登录 Partner Center");
    const r = await fetch(env.PC_SESSION_URL, {
      headers: { Authorization: "Bearer " + token },
    });
    need(r.ok, 401, "登录已失效");
    return { u: safeProfile(await r.json()), ns: "portal", demo: false };
  }
  need(env.DEMO_MODE === "true", 503, "尚未配置门户身份服务");
  const select = cookie(req, "material_profile");
  const u = Object.hasOwn(profiles, select) ? profiles[select] : profiles.partner;
  if (env.LOCAL_RUNTIME && env.LOCAL_WORKSPACE)
    return { u, ns: env.LOCAL_WORKSPACE, demo: true, workspaceMode: "local-shared" };
  let ns = cookie(req, "material_space");
  let fresh = !/^[a-f0-9-]{36}$/.test(ns);
  if (fresh) ns = uid();
  return { u, ns, demo: true, fresh, workspaceMode: env.LOCAL_RUNTIME ? "local-isolated" : "isolated" };
}
export async function recipient(ctx, env, id) {
  if (ctx.demo) return Object.hasOwn(profiles,id) ? profiles[id] : null;
  if (ctx.u.id === id) return ctx.u;
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
