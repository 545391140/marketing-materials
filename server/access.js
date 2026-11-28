import {front,has} from "../shared/permissions.js";
import { allowed, ALL, roles, values } from "../shared/audience.js";
export { allowed, subset } from "../shared/audience.js";
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
export const staff = (u) => u.scopes?.some((s)=>s.caps.some((key)=>!front.includes(key)));
export const manages = (u, m) =>
  staff(u) && u.grants.some((g) => g.bg === m.bg);
export function fileAllowed(u,rules,cap) {
  return allowed(u.scopes ? {...u,grants:u.grants.filter((g)=>has(u,cap,g.bg) && has(u,"browse",g.bg))} : u,rules);
}
export function visible(m, u, catalog = [], visited = new Set()) {
  if (u.scopes && !has(u,"browse")) return null;
  if (!active(m) || visited.has(m.id)) return null;
  if (m.proofId) {
    const proof = catalog.find((x) => x.id === m.proofId);
    if (
      !proof ||
      proof.version !== m.proofVersion ||
      !visible(proof, u, catalog, new Set([...visited, m.id]))
    )
      return null;
  }
  const files = m.files
    .filter((f) => fileAllowed(u, f.view, "browse"))
    .map((f) => ({
      id: f.id,
      name: f.name,
      ext: f.ext,
      usage: f.usage,
      size: f.size || 0,
      canDownload: fileAllowed(u, f.download,"download"),
    }));
  if (!files.length) return null;
  const { defaultView, defaultDownload, files: orig, ownerId, reviewReminder, reviewRevision, reviewOn, reviewedAt, ...meta } = m;
  return { ...meta, files };
}
export function str(v, n = 240) {
  return typeof v === "string" ? v.trim().slice(0, n) : "";
}
function selection(v, label, options, legacy) {
  if (v === ALL) return ALL;
  const items = values(v);
  need(items.length && items.length <= 250 && items.every((item) =>
    typeof item === "string" && item.trim() && item.length <= 60 && item !== ALL &&
    (options.has(item) || legacy.has(item))), 400, "请选择有效的" + label);
  return [...new Set(items)].sort();
}
export function validRules(v, catalog, prior = []) {
  need(Array.isArray(v) && v.length <= 25, 400, "最多可配置 25 组受众");
  const options = (items) => new Set(items.map((x) => x.value));
  const countries = options(catalog.countries), channels = options(catalog.partnerTypes);
  const historical = (key) => new Set(prior.flatMap((r) => values(r[key])));
  const oldCountries = historical("country"), oldChannels = historical("channel");
  return v.map((r) => {
    need(r && [ALL, "员工", "伙伴", ...roles].includes(r.role) &&
      [r.bg, r.region].every((x) => typeof x === "string" && x.trim() && x.length <= 60),
      400, "请完整选择身份、BG 和区域");
    return { role: r.role, bg: r.bg.trim(), region: r.region.trim(),
      country: selection(r.country === undefined ? ALL : r.country, "国家", countries, oldCountries),
      channel: selection(r.channel, "伙伴类型", channels, oldChannels) };
  });
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
    !visible(m, u, s.materials) ||
    !f.every(
      (a) =>
        fileAllowed(u,a.view,"browse") &&
        (!r.external || (fileAllowed(u,a.download,"download") && a.usage === "可发客户")) &&
        (!r.needDownload || fileAllowed(u,a.download,"download")),
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
