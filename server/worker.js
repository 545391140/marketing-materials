import assets from "./built-assets.json";
import { api } from "./api.js";
export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/api/"))
      return api(req, {
        ...env,
        BUCKET: env.BUCKET,
        DEMO_MODE: env.DEMO_MODE ?? "true",
      });
    const a = assets[path === "/" ? "/index.html" : path];
    if (!a) return new Response("Not found", { status: 404 });
    return new Response(
      Uint8Array.from(atob(a.data), (x) => x.charCodeAt(0)),
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
