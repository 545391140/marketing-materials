import { decompress } from "fzstd";
export function serveAsset(assets, path) {
  const a = assets[path === "/" ? "/index.html" : path];
  if (!a) return new Response("Not found", { status: 404 });
  const bytes = Uint8Array.from(atob(a.data), (c) => c.charCodeAt(0));
  return new Response(a.compressed ? decompress(bytes) : bytes, {
    headers: {
      "content-type": a.type,
      "x-content-type-options": "nosniff",
      "cache-control": path.startsWith("/img/")
        ? "public,max-age=300"
        : "private,no-cache",
      "referrer-policy": "same-origin",
    },
  });
}
export const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        c
      ])
  );
