import { gunzipSync } from "fflate";
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
    const a = assets[path === "/" ? "/index.html" : path];
    if (!a) return new Response("Not found", { status: 404 });
    const data = Uint8Array.from(atob(a.data), (x) => x.charCodeAt(0));
    return new Response(
      a.compressed ? gunzipSync(data) : data,
      {
        headers: {
          "content-type": a.type,
          "x-content-type-options": "nosniff",
          "referrer-policy": "same-origin",
          "cache-control": path === "/" ? "no-cache" : "public,max-age=300",
        },
      },
    );
  },
};
