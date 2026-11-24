import { identity, readState, update } from "./db.js";
import { uid, need, visible, manages, allowed, active } from "./access.js";
import { snapshot, change } from "./service.js";
import { profiles } from "./seed.js";
import { inspect, mimes } from "./files.js";
import pdfs from "./sample-pdf.json";
const json = (v, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json;charset=utf-8" },
  });
function fileResp(body, mime, filename, download = false) {
  return new Response(body, {
    headers: {
      "content-type": mime,
      "content-disposition":
        (download ? "attachment" : "inline") +
        "; filename*=UTF-8''" +
        encodeURIComponent(filename),
      "content-security-policy": "sandbox; default-src 'none'",
    },
  });
}
export async function api(req, env) {
  let ctx;
  try {
    const url = new URL(req.url),
      path = url.pathname;
    if (req.method !== "GET") {
      need(req.method === "POST", 405, "请求方式无效");
      const origin = req.headers.get("origin");
      need(!origin || origin === url.origin, 403, "请求来源无效");
      need(req.headers.get("x-material-client") === "hub", 403, "无效请求");
    }
    ctx = await identity(req, env);
    const { u, ns } = ctx;
    let response;
    if (req.method === "GET" && path === "/api/state") {
      const { s } = await readState(env, ns);
      response = json(snapshot(s, ctx));
    } else if (req.method === "POST" && path === "/api/profile") {
      need(ctx.demo, 403, "当前使用门户账号");
      const { id } = await req.json();
      need(Object.hasOwn(profiles, id), 400, "身份无效");
      response = json({ ok: true });
      setCookie(response, "material_profile", id, url);
    } else if (req.method === "POST" && path === "/api/actions") {
      const a = await req.json();
      await update(env, ns, (s) => change(s, ctx, env, a));
      response = json({ ok: true });
    } else if (req.method === "POST" && path === "/api/upload") {
      need(["editor", "reviewer"].includes(u.role), 403, "无上传权限");
      need(
        +(req.headers.get("content-length") || 0) <= 8450000,
        413,
        "附件须小于 8 MB",
      );
      const file = (await req.formData()).get("file");
      need(
        file && typeof file.name === "string" && file.size <= 8388608,
        400,
        "请选择 8 MB 以内的文件",
      );
      const name = file.name.replace(/[\r\n\/\\]/g, "_").slice(0, 180),
        ext = name.split(".").pop().toLowerCase(),
        bytes = new Uint8Array(await file.arrayBuffer());
      if (!ctx.demo || env.SCAN_URL) {
        need(env.SCAN_URL, 503, "请配置文件扫描服务");
        const scan = await fetch(env.SCAN_URL, {
          method: "POST",
          headers: {
            authorization: "Bearer " + (env.SCAN_TOKEN || ""),
            "content-type": "application/octet-stream",
          },
          body: bytes,
        });
        need(
          scan.ok && (await scan.json()).clean === true,
          422,
          "附件未通过扫描",
        );
      }
      let preview;
      try {
        preview = await inspect(bytes, ext);
      } catch (e) {
        need(
          false,
          e.status || 422,
          e.status ? e.message : "附件内容无法预览，请检查文件格式",
        );
      }
      const id = uid(),
        original = ns + "/files/" + id,
        previewKey = preview.image ? original + "-preview" : "";
      await env.BUCKET.put(original, bytes);
      if (previewKey) await env.BUCKET.put(previewKey, preview.image);
      const f = {
        id,
        name,
        ext,
        size: bytes.length,
        original,
        previewKey,
        preview: preview.text || "",
        mime: preview.mime,
        uploader: u.id,
      };
      await update(env, ns, (s) => {
        (s.uploads || (s.uploads = {}))[id] = f;
      });
      response = json({ id, name, ext, size: f.size });
    } else if (req.method === "GET" && path === "/api/cover") {
      const { s } = await readState(env, ns);
      const m = s.materials.find((x) => x.id === url.searchParams.get("m"));
      need(m && visible(m, u) && m.coverId, 404, "封面不可用");
      const file = s.uploads?.[m.coverId];
      need(file?.previewKey, 404, "封面不可用");
      const o = await env.BUCKET.get(file.previewKey);
      need(o, 404, "封面不可用");
      response = fileResp(o.body, file.mime, "cover");
    } else if (req.method === "GET" && path === "/api/file") {
      const { s } = await readState(env, ns),
        mid = url.searchParams.get("m"),
        id = url.searchParams.get("f"),
        mode = url.searchParams.get("mode");
      const draft = url.searchParams.get("draft") === "1";
      const m = (draft ? s.drafts : s.materials).find((x) => x.id === mid);
      need(m && (draft ? manages(u, m) : active(m)), 404, "资料不可用");
      const f = m.files.find((x) => x.id === id);
      need(f && (draft || allowed(u, f.view)), 404, "资料不可用");
      if (mode === "download") {
        need(!draft && allowed(u, f.download), 403, "没有下载权限");
        let body;
        if (f.seed) {
          body =
            f.ext === "pdf"
              ? Uint8Array.from(atob(pdfs[f.id]), (c) => c.charCodeAt(0))
              : f.preview;
        } else {
          const o = await env.BUCKET.get(f.original);
          need(o, 404, "附件不可用");
          body = o.body;
        }
        await update(env, ns, (state) => {
          state.audit.unshift({
            name: u.name,
            action: "下载附件",
            id: f.id,
            date: new Date().toISOString(),
          });
        });
        response = fileResp(body, mimes[f.ext], f.name, true);
      } else if (f.previewKey) {
        const o = await env.BUCKET.get(f.previewKey);
        need(o, 404, "预览不可用");
        response = fileResp(o.body, f.mime, f.id + "-preview");
      } else response = json({ text: f.preview, title: f.name });
    } else need(false, 404, "未找到");
    if (ctx.fresh) setCookie(response, "material_space", ns, url);
    response.headers.set("cache-control", "private,no-store");
    response.headers.set("x-content-type-options", "nosniff");
    return response;
  } catch (e) {
    const out = json(
      { error: e.status ? e.message : "服务暂时无法完成此次操作" },
      e.status || 500,
    );
    out.headers.set("cache-control", "no-store");
    if (!e.status) console.error(e.name, e.message?.slice(0, 150));
    return out;
  }
}
function setCookie(r, k, v, url) {
  r.headers.append(
    "set-cookie",
    k +
      "=" +
      v +
      "; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000" +
      (url.protocol === "https:" ? "; Secure" : ""),
  );
}
