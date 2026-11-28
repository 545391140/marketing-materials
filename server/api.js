import {createLink,customerFiles,shareRoute} from "./shares.js";
import { sessionUser, remember, knownProfile } from "./roles.js";
import { canReview } from "../shared/approval.js";
import { has, any, materialCaps } from "../shared/permissions.js";
import { gapReport } from "./operations.js";
import { diagnose, audiencePreview } from "./system.js";
import { identity, bindPc, readState, update } from "./db.js";
import { audienceCatalog } from "./audience-catalog.js";
import { uid, need, staff, visible, manages, fileAllowed, active, validRules, subset } from "./access.js";
import { snapshot, change, materialHistory, releaseDue } from "./service.js";
import { profiles } from "./seed.js";
import { inspect, mimes, readPdfResource } from "./files.js";
import { layoutPreview } from "./layout-preview.js";
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
async function originalBody(env,f) {
  if(f.seed) return f.ext==="pdf" ? Uint8Array.from(atob(pdfs[f.id]),c=>c.charCodeAt(0)) : f.preview;
  const o=await env.BUCKET.get(f.original);
  need(o,404,"附件不可用");
  return o.body;
}
async function previewResponse(env,ns,f,url,mode) {
  if (mode === "layout") {
    const load = async () => new Uint8Array(await new Response(await originalBody(env,f)).arrayBuffer());
    let layout;
    try {
      layout = await layoutPreview(env.BUCKET, f.original || ns + "/samples/" + f.id, f, load, url.searchParams.get("page"));
    } catch (e) {
      if (e.status) throw e;
      need(false, 422, "当前文件无法生成排版预览");
    }
    if (!layout.data) return json(layout);
    const response = fileResp(layout.data, layout.mime, f.id + "-page");
    if (layout.mime === "image/svg+xml")
      response.headers.set("content-security-policy", "sandbox; default-src 'none'; img-src data:");
    return response;
  }
  if (f.previewKey) {
    const o = await env.BUCKET.get(f.previewKey);
    need(o, 404, "预览不可用");
    return fileResp(o.body, f.mime, f.id + "-preview");
  }
  return json({ text: f.preview, title: f.name });
}
async function shareResponse(token,env,url) {
  const index=await env.BUCKET.get("share-index/"+token);
  need(index,404,"分享已失效或不可用");
  const ns=await index.text();
  const {s}=await releaseDue(env,ns);
  const {link,files}=await customerFiles(s,token,ns,env);
  const mode=url.searchParams.get("mode");
  if(mode==="info") return json({title:link.title,version:link.version,expiresAt:link.expiresAt,
    files:files.map(({file:{id,name,ext,size},canDownload})=>({id,name,ext,size,canDownload}))});
  const selected=files.find(x=>x.file.id===url.searchParams.get("f"));
  need(selected,404,"附件不可用");
  const f=selected.file;
  if(mode==="download") {
    need(selected.canDownload,403,"分享人未授权下载此附件");
    return fileResp(await originalBody(env,f),mimes[f.ext],f.name,true);
  }
  need(["preview","layout"].includes(mode),404,"未找到");
  return previewResponse(env,ns,f,url,mode);
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
    const token=shareRoute.exec(path)?.[1];
    if (token || path.startsWith("/share-fonts/")) {
      need(req.method==="GET",405,"请求方式无效");
      let result;
      if(token) result=await shareResponse(token,env,url);
      else {
        const font=readPdfResource(path.slice("/share-fonts/".length));
        need(font,404,"未找到");
        result=new Response(font,{headers:{"content-type":"application/octet-stream"}});
      }
      result.headers.set("cache-control","private,no-store");
      result.headers.set("referrer-policy","no-referrer");
      result.headers.set("x-content-type-options","nosniff");
      return result;
    }
    ctx = await identity(req, env);
    const raw=ctx.u, ns=ctx.ns;
    let stored=await releaseDue(env,ns);
    const directoryUser = ctx.actor || raw;
    if(!ctx.demo && JSON.stringify(stored.s.directory?.find(p=>p.id===directoryUser.id))!==JSON.stringify(knownProfile(directoryUser))) {
      await update(env,ns,s=>remember(s,directoryUser));
      stored=await readState(env,ns);
    }
    const scoped=(s)=>({...ctx,u:sessionUser(s,raw,ctx,env),raw});
    ctx=scoped(stored.s);
    const u=ctx.u;
    let response;
    if (req.method === "POST" && path === "/api/identity/bind") {
      await bindPc(req,env,ctx);
      response = json({ok:true});
    } else if (req.method === "POST" && path === "/api/identity/context") {
      const {companyId} = await req.json();
      need(ctx.actor?.employeeId && typeof companyId === "string" &&
        (!companyId || ctx.actor.delegations.some(d=>d.companyId===companyId)),403,"没有该企业的代办授权");
      response = json({path:"/"+ctx.source.toLowerCase()+"/"+(companyId ? "as/"+encodeURIComponent(companyId)+"/" : "")});
    } else if (req.method === "GET" && path === "/api/admin/access") {
      response=json({allowed:!!staff(u),demo:ctx.demo, choices:ctx.demo?Object.values(profiles).map(({id,name,org})=>({id,name,org})):[]},staff(u)?200:403);
    } else if (req.method === "GET" && ["/api/state","/api/portal/state","/api/admin/state"].includes(path)) {
      if(path==="/api/admin/state") need(staff(u),403,"当前账号没有资料管理权限");
      const { s, tag } = stored;
      response = json({ ...snapshot(s, ctx, env, path!=="/api/portal/state"), revision: tag, workspaceMode: ctx.workspaceMode });
    } else if (req.method === "GET" && path === "/api/admin/history") {
      const { s } = stored;
      response = json(materialHistory(s, u, url.searchParams.get("id")));
    } else if (req.method === "GET" && path === "/api/inbox") {
      const { s, tag } = stored;
      const state = snapshot(s, ctx, env, false);
      response = json({
        userId: u.id,
        revision: tag,
        notices: state.notices,
        requests: state.requests,
      });
    } else if (req.method === "POST" && path === "/api/profile") {
      need(ctx.demo, 403, "当前使用门户账号");
      const { id } = await req.json();
      need(Object.hasOwn(profiles, id), 400, "身份无效");
      response = json({ ok: true });
      setCookie(response, "material_profile", id, url);
    } else if (req.method === "GET" && path === "/api/admin/gaps") {
      need(any(u,["demand","audit"]),403,"无权查看运营报表");
      response=json(gapReport(stored.s,ctx,env));
    } else if (req.method === "POST" && path === "/api/admin/audience-preview") {
      response=json(await audiencePreview(stored.s,ctx,env,await req.json()));
    } else if (req.method === "GET" && path === "/api/admin/card-cover") {
      const s=stored.s;
      const m=[...s.drafts,...s.materials].find(x=>x.id===url.searchParams.get("id"));
      need(m && any(u,["edit","review","diagnose"],m.bg),404,"封面不可用");
      const f=s.uploads?.[m.coverId], obj=f?.previewKey && await env.BUCKET.get(f.previewKey);
      need(obj,404,"封面不可用");
      response=fileResp(obj.body,f.mime,"cover");
    } else if (req.method === "POST" && path === "/api/diagnose") {
      response=json(await diagnose(stored.s,ctx,env,await req.json()));
    } else if (req.method === "POST" && path === "/api/shares") {
      need(env.SHARE_ORIGIN,503,"尚未配置客户访问地址");
      if (!ctx.demo) need((u.employeeId ? env.OA_DIRECTORY_URL && env.OA_SERVICE_TOKEN : env.PC_DIRECTORY_URL && env.PC_SERVICE_TOKEN),503,"需要配置门户目录以实时校验分享人权限");
      response=json(await createLink(env,ctx,scoped,await req.json()));
    } else if (req.method === "POST" && path === "/api/actions") {
      const a = await req.json();
      const result=await update(env, ns, (s) => change(s, scoped(s), env, a));
      response=json(result?.blocked ? {ok:false, ...result} : {ok:true});
    } else if (req.method === "POST" && path === "/api/upload") {
      need(has(u,"edit"), 403, "无上传权限");
      need(
        +(req.headers.get("content-length") || 0) <= 8450000,
        413,
        "附件须小于 8 MB",
      );
      const form = await req.formData();
      const file = form.get("file");
      let permissions = {};
      if (form.has("permissions")) {
        let scope;
        try { scope = JSON.parse(form.get("permissions")); } catch {}
        need(scope && typeof scope.inherit === "boolean", 400, "上传权限格式无效");
        let previous;
        if (scope.draftId || scope.materialId) {
          const { s } = stored;
          previous = scope.draftId ? s.drafts.find((d) => d.id === scope.draftId)
            : s.materials.find((m) => m.id === scope.materialId);
          need(previous && has(u,"edit",previous.bg), 403, "无法使用此资料的权限");
        }
        const catalog = audienceCatalog(ctx);
        const defV = validRules(scope.defaultView, catalog, previous?.defaultView);
        const defD = validRules(scope.defaultDownload, catalog, previous?.defaultDownload);
        need(subset(defD, defV), 400, "资料的下载范围超出查看范围");
        const view = scope.inherit ? defV : validRules(scope.view, catalog, previous?.defaultView);
        const download = scope.inherit ? defD : validRules(scope.download, catalog, previous?.defaultDownload);
        need(subset(view, defV) && subset(download, defD), 400, "本次上传的附件权限超出资料默认范围");
        need(subset(download, view), 400, "本次上传的下载范围超出查看范围");
        permissions = { inherit: scope.inherit, view, download };
      }
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
        uploadedAt: new Date().toISOString(),
        ...permissions,
      };
      await update(env, ns, (s) => {
        need(has(scoped(s).u,"edit"),403,"无上传权限");
        (s.uploads || (s.uploads = {}))[id] = f;
      });
      response = json({ id, name, ext, size: f.size, ...permissions });
    } else if (req.method === "GET" && path === "/api/cover") {
      const { s } = stored;
      const m = s.materials.find((x) => x.id === url.searchParams.get("m"));
      need(m && visible(m, u, s.materials) && m.coverId, 404, "封面不可用");
      const file = s.uploads?.[m.coverId];
      need(file?.previewKey, 404, "封面不可用");
      const o = await env.BUCKET.get(file.previewKey);
      need(o, 404, "封面不可用");
      response = fileResp(o.body, file.mime, "cover");
    } else if (req.method === "GET" && path.startsWith("/api/preview-fonts/")) {
      const filename = path.split("/").pop();
      const font = readPdfResource(filename);
      need(font, 404, "字体资源不可用");
      response = new Response(font, {headers:{"content-type":"application/octet-stream"}});
    } else if (req.method === "GET" && path === "/api/file") {
      const { s } = stored,
        mid = url.searchParams.get("m"),
        id = url.searchParams.get("f"),
        mode = url.searchParams.get("mode");
      const draft = url.searchParams.get("draft") === "1";
      const m = (draft ? s.drafts : s.materials).find((x) => x.id === mid);
      need(
        m && (draft ? (any(u,materialCaps,m.bg) || canReview(m,u)) : visible(m, u, s.materials)),
        404,
        "资料不可用",
      );
      const f = m.files.find((x) => x.id === id);
      need(f && (draft || fileAllowed(u,f.view,"browse")), 404, "资料不可用");
      if (mode === "download") {
        need(!draft && fileAllowed(u,f.download,"download"), 403, "没有下载权限");
        const body=await originalBody(env,f);
        await update(env, ns, (state) => {
          const current = state.materials.find(x => x.id === mid);
          const account = scoped(state).u;
          need(current && current.version === m.version && visible(current, account, state.materials), 404, "资料不可用");
          need(fileAllowed(account, f.download, "download"), 403, "没有下载权限");
          state.audit.unshift({
            downloadMid: mid, version: m.version, userId: u.id,
            name: u.name, actorId:u.actorId || u.id, companyId:u.companyId, source:ctx.source, bg:current.bg,
            action: "下载附件",
            id: f.id,
            date: new Date().toISOString(),
          });
        });
        response = fileResp(body, mimes[f.ext], f.name, true);
      } else response = await previewResponse(env,ns,f,url,mode);
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
