export const languages = ["中文", "English", "Tiếng Việt", "ไทย", "Bahasa Indonesia", "Español", "Português", "Français", "العربية", "日本語", "한국어", "其他"];
export function searchContext(value = {}) {
  return Object.fromEntries(["query", "type", "cat", "ind", "task", "language", "market"]
    .map(k => [k, typeof value?.[k] === "string" ? value[k].trim().slice(0, 160) : ""]));
}
const normalize = value => String(value || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
const compact = value => value.replace(/[\s‐‑–—_-]+/gu, "");
export function matchesMaterial(m, filters) {
  if (filters.type && filters.type !== "全部" && m.type !== filters.type) return false;
  if (filters.cat && m.cat !== filters.cat || filters.ind && m.industry !== filters.ind ||
      filters.task && m.task !== filters.task || filters.language && m.language !== filters.language ||
      filters.market && !m.markets?.includes(filters.market) && !m.markets?.includes("全球")) return false;
  const query = normalize(filters.query);
  if (!query) return true;
  const haystack = normalize([m.title,m.en,m.type,m.cat,m.industry,m.summary,m.opening,m.advice,
    m.product,m.solution,m.language,...(m.tags || []),...(m.aliases || []),...(m.models || []),
    ...(m.markets || []),...(m.files || []).map(f => f.name)].join(" "));
  return query.split(/\s+/u).every(word => haystack.includes(word) || (compact(word) && compact(haystack).includes(compact(word))));
}
