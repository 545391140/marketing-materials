export class HttpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}
export function need(ok, status, msg) {
  if (!ok) throw new HttpError(status, msg);
}
export const uid = () => crypto.randomUUID();
export const day = () => new Date().toISOString().slice(0, 10);
export const active = (m) => m.published && (!m.expires || m.expires >= day());
export const staff = (u) => u.role === "editor" || u.role === "reviewer";
export const manages = (u, m) =>
  staff(u) && u.grants.some((g) => g.bg === m.bg);
export function allowed(u, rules) {
  return (rules || []).some(
    (r) =>
      (r.role === "全部" ||
        r.role === u.role ||
        (r.role === "员工" && u.role !== "partner") ||
        (r.role === "伙伴" && u.role === "partner")) &&
      u.grants.some((g) =>
        ["bg", "region", "channel"].every(
          (k) => r[k] === "全部" || g[k] === r[k],
        ),
      ),
  );
}
export function visible(m, u) {
  if (!active(m)) return null;
  const files = m.files
    .filter((f) => allowed(u, f.view))
    .map((f) => ({
      id: f.id,
      name: f.name,
      ext: f.ext,
      usage: f.usage,
      size: f.size || 0,
      canDownload: allowed(u, f.download),
    }));
  if (!files.length) return null;
  const { defaultView, defaultDownload, files: orig, ...meta } = m;
  return { ...meta, files };
}
export function str(v, n = 240) {
  return typeof v === "string" ? v.trim().slice(0, n) : "";
}
export function validRules(v) {
  need(
    Array.isArray(v) &&
      v.length <= 25 &&
      v.every(
        (r) =>
          r &&
          ["role", "bg", "region", "channel"].every(
            (k) =>
              typeof r[k] === "string" && r[k].length > 0 && r[k].length <= 60,
          ),
      ),
    400,
    "请完整选择受众范围",
  );
  return v.map((r) =>
    Object.fromEntries(
      ["role", "bg", "region", "channel"].map((k) => [k, str(r[k], 60)]),
    ),
  );
}
export function subset(dl, view) {
  return dl.every((d) =>
    view.some((v) =>
      ["role", "bg", "region", "channel"].every(
        (k) =>
          v[k] === "全部" ||
          v[k] === d[k] ||
          (k === "role" &&
            v[k] === "员工" &&
            ["sales", "editor", "reviewer"].includes(d[k])),
      ),
    ),
  );
}
export const prefs = (s, u) =>
  s.users[u.id] ||
  (s.users[u.id] = { fav: [], list: [], deadline: "", notes: "" });
export function deliver(s, r, m, u, fileIds) {
  need(m && active(m), 409, "资料尚未发布或已过期");
  const f = m.files.filter((a) => fileIds.includes(a.id));
  need(f.length === fileIds.length && f.length > 0, 400, "请选择交付附件");
  const formats = {
    PDF: ["pdf"],
    Word: ["docx"],
    PPT: ["pptx"],
    TXT: ["txt"],
    图片: ["jpg", "jpeg", "png"],
  };
  if (formats[r.format] && !f.some((x) => formats[r.format].includes(x.ext)))
    return false;
  if (
    !u ||
    !f.every(
      (a) =>
        allowed(u, a.view) &&
        (!r.external || (allowed(u, a.download) && a.usage === "可发客户")) &&
        (!r.needDownload || allowed(u, a.download)),
    )
  )
    return false;
  r.status = "已交付";
  r.material = m.id;
  r.version = m.version;
  r.deliveryFiles = fileIds;
  const key = [r.id, m.id, m.version].join(":");
  if (!s.notices.some((n) => n.key === key))
    s.notices.unshift({
      key,
      to: r.by,
      rid: r.id,
      msg: "你需要的资料已发布",
      date: day(),
      read: false,
    });
  return true;
}
