import assets from "./built-admin.json";
import { serveAsset, escapeHtml } from "./ui-assets.js";

const noStore = {
  "cache-control": "private,no-store",
  "referrer-policy": "no-referrer",
};
// Forward application credentials only. Sites login cookies belong to this origin.
async function upstream(req, env, path) {
  const origin = new URL(req.url).origin,
    base = new URL(env.PORTAL_ORIGIN);
  const write = req.method !== "GET" && req.method !== "HEAD";
  if (
    write &&
    req.headers.has("origin") &&
    req.headers.get("origin") !== origin
  )
    return new Response("Forbidden", { status: 403 });
  const h = new Headers();
  for (const key of ["content-type", "x-material-client", "accept"])
    if (req.headers.has(key)) h.set(key, req.headers.get(key));
  const names = [
    env.PC_COOKIE_NAME || "pc_session",
    env.OA_COOKIE_NAME || "oa_session",
    "material_profile",
    "material_space",
  ];
  h.set(
    "cookie",
    (req.headers.get("cookie") || "")
      .split(";")
      .map((x) => x.trim())
      .filter((v) => names.includes(v.split("=")[0]))
      .join("; ")
  );
  h.set("x-material-entry", "oa");
  if (write) h.set("origin", base.origin);
  if (env.PORTAL_SERVICE_TOKEN)
    h.set("OAI-Sites-Authorization", "Bearer " + env.PORTAL_SERVICE_TOKEN);
  const url = new URL(base.origin);
  url.pathname = path;
  if (path === new URL(req.url).pathname) url.search = new URL(req.url).search;
  const options = {
    method: req.method,
    headers: h,
    body: write ? req.body : null,
    redirect: "manual",
    ...(write ? { duplex: "half" } : {}),
  };
  const request = new Request(url, options);
  const result = env.LOCAL_API
    ? await env.LOCAL_API.fetch(request)
    : await fetch(request);
  if (result.status >= 300 && result.status < 400)
    return new Response("资料服务身份配置不可用", {
      status: 502,
      headers: noStore,
    });
  const headers = new Headers(noStore);
  for (const k of [
    "content-type",
    "content-disposition",
    "content-security-policy",
    "x-content-type-options",
  ])
    if (result.headers.has(k)) headers.set(k, result.headers.get(k));
  for (const cookie of result.headers.getSetCookie())
    if (["material_space", "material_profile"].includes(cookie.split("=")[0]))
      headers.append("set-cookie", cookie);
  return new Response(result.body, { headers, status: result.status });
}

function denied(access, data) {
  const choices = data.demo
    ? (data.choices || []).filter(
        (p) => !["partner", "partnerVn", "sales", "presales", "aftersales"].includes(p.id)
      )
    : [];
  const options = choices
    .map(
      (p) =>
        '<option value="' +
        escapeHtml(p.id) +
        '">' +
        escapeHtml(p.name + " · " + p.org) +
        "</option>"
    )
    .join("");
  const headers = new Headers(access.headers);
  headers.set("content-type", "text/html;charset=utf-8");
  return new Response(
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>资料管理端 · 访问验证</title><link rel="stylesheet" href="/style.css"><main class="entry-card"><strong>Ruijie · 资料管理端</strong><h1>需要内部管理权限</h1><p>' +
      escapeHtml(data.error || "当前账号无法进入资料管理端。") +
      "</p>" +
      (options
        ? '<form id="entry"><label>选择试用员工身份<select id="identity">' +
          options +
          '</select></label><button class="btn red">以试用身份进入</button><p id="message" role="status"></p></form><script defer src="/entry.js"></script>'
        : "") +
      '<a href="/portal">返回营销资料中心</a></main></html>',
    { status: access.status, headers }
  );
}
export default {
  async fetch(req, env) {
    const url = new URL(req.url),
      path = url.pathname;
    if (!env.PORTAL_ORIGIN)
      return new Response("资料服务尚未配置", { status: 503 });
    if (path === "/portal")
      return Response.redirect(new URL("/", env.PORTAL_ORIGIN).href, 302);
    if (path === "/connect" && req.method === "POST") {
      if (
        env.DEMO_PAIRING !== "true" ||
        req.headers.get("origin") !== new URL(env.PORTAL_ORIGIN).origin
      )
        return new Response("Forbidden", { status: 403 });
      const form = await req.formData(),
        space = String(form.get("space")),
        profile = String(form.get("profile"));
      if (
        !/^[a-f0-9-]{36}$/.test(space) ||
        !/^[A-Za-z0-9_-]{1,60}$/.test(profile)
      )
        return new Response("Invalid workspace", { status: 400 });
      const headers = new Headers({ ...noStore, location: "/" });
      for (const [name, val] of [
        ["material_space", space],
        ["material_profile", profile],
      ])
        headers.append(
          "set-cookie",
          name +
            "=" +
            val +
            "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000"
        );
      return new Response(null, { status: 303, headers });
    }
    if (path.startsWith("/api/")) return upstream(req, env, path);
    if (req.method !== "GET")
      return new Response("Method not allowed", { status: 405 });
    if (path === "/" || path === "/index.html") {
      const access = await upstream(req, env, "/api/admin/access");
      if (!access.ok) {
        let data = { error: "身份服务暂不可用，请重新登录或稍后重试。" };
        try {
          data = await access.json();
        } catch {}
        return denied(access, data);
      }
      const page = serveAsset(assets, "/");
      for (const cookie of access.headers.getSetCookie())
        page.headers.append("set-cookie", cookie);
      return page;
    }
    return serveAsset(assets, path);
  },
};
