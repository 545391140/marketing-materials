import { serveAsset,escapeHtml } from "./ui-assets.js";
import { identity } from "./db.js";
import assets from "./built-assets.json";
import { api } from "./api.js";
import { sendPortalNotifications } from "./portal-notifications.js";
export default {
  scheduled(event, env, ctx) {
    ctx.waitUntil(sendPortalNotifications(env));
  },
  async fetch(req, env, ctx) {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/api/")) {
      const result = await api(req, {
        ...env,
        BUCKET: env.BUCKET,
        DEMO_MODE: env.DEMO_MODE ?? "true",
      });
      if (
        result.ok &&
        env.PC_SESSION_URL &&
        env.PC_MESSAGE_URL &&
        (req.method === "POST" || path === "/api/inbox")
      ) {
        const delivery = sendPortalNotifications(env).catch(() =>
          console.error("Portal notification dispatch deferred"),
        );
        if (ctx?.waitUntil) ctx.waitUntil(delivery);
        else await delivery;
      }
      return result;
    }
    if(path==="/manage"){
      if(!env.ADMIN_ORIGIN)return new Response("管理端地址尚未配置",{status:503});
      const target=new URL("/",env.ADMIN_ORIGIN);
      if(!env.PC_SESSION_URL && env.DEMO_PAIRING==="true"){
        const c=await identity(req,{...env,DEMO_MODE:env.DEMO_MODE ?? "true"});
        const headers=new Headers({"content-type":"text/html;charset=utf-8","cache-control":"no-store","referrer-policy":"no-referrer"});
        if(c.fresh)headers.append("set-cookie","material_space="+c.ns+"; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000");
        return new Response('<!doctype html><meta charset="utf-8"><title>打开资料管理端</title><form method="post" action="'+escapeHtml(new URL("/connect",target).href)+'"><input type="hidden" name="space" value="'+escapeHtml(c.ns)+'"><input type="hidden" name="profile" value="'+escapeHtml(c.u.id)+'"><button>进入资料管理端</button></form><script>document.forms[0].submit()</script>',{headers});
      }
      return Response.redirect(target.href,302);
    }
    return serveAsset(assets,path);
  },
};
