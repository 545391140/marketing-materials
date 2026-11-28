import { has, any } from "../shared/permissions.js";
import { allowed, active, day, need, prefs, str, uid, visible } from "./access.js";
import { people, effective } from "./roles.js";
import { matchesMaterial, searchContext } from "../shared/discovery.js";

export function directoryOptions(s, c, env) {
  return people(s, c).filter(p => p.active !== false).map(p => {
    const scopes = effective(s, p, c, env).scopes.filter(g => any(c.u, ["edit","review","diagnose"], g.bg));
    return { id: p.id, name: p.name, bgs: scopes.map(g => g.bg),
      editorBgs: scopes.filter(g => g.caps.includes("edit")).map(g => g.bg) };
  }).filter(p => p.bgs.length);
}
export function validDay(input) {
  const value = str(input, 10);
  need(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0,10) === value, 400, "请选择有效日期");
  return value;
}
export function opportunities(s, u, materials) {
  return (prefs(s,u).opportunities || []).map(({id,name,items}) => ({
    id, name, items: items.map(item => {
      const m = materials.find(x => x.id === item.mid);
      const orig = s.materials.find(x => x.id === item.mid);
      return { key: item.key, title: item.title, version: item.version, mid: m?.id || null,
        status: m ? (m.version === item.version ? "可用" : "已换版") :
          orig?.published === false ? "已下架" : orig?.expires && orig.expires < day() ? "已过期" : "不可用" };
    })
  }));
}
export function editOpportunity(s,u,a) {
  need(has(u,"personal"),403,"没有清单权限");
  const p = prefs(s,u), lists = p.opportunities ||= [];
  if (a.op === "createOpportunity") {
    const name = str(a.name,80);
    need(name && !lists.some(l => l.name === name),400,"清单名称为空或重复");
    lists.push({id:uid(), name, items:[]});
    return;
  }
  const list = lists.find(x => x.id === a.listId);
  need(list,404,"找不到清单");
  if (a.op === "removeOpportunityItem") {
    list.items = list.items.filter(i => i.key !== a.key);
    return;
  }
  const m = s.materials.find(x => x.id === a.mid && visible(x,u,s.materials));
  need(m,404,"资料不可用");
  const item = list.items.find(i => i.mid === m.id);
  if (item) Object.assign(item,{version:m.version,title:m.title});
  else list.items.push({key:uid(),mid:m.id,version:m.version,title:m.title});
}
export function recordSearch(s,u,a) {
  need(has(u,"browse"),403,"没有资料库权限");
  const filters = searchContext(a.filters);
  if (!filters.query && !Object.entries(filters).some(([k,v])=>k!=="query" && v && v!=="全部")) return;
  if (s.materials.some(m => { const view=visible(m,u,s.materials); return view && matchesMaterial(view,filters); })) return;
  const bg=u.scopes.find(g=>has(u,"browse",g.bg))?.bg;
  const term=filters.query || Object.values(filters).filter(v=>v && v!=="全部").join(" / ");
  const rows=s.searchMisses ||= [], today=day();
  const row=rows.find(r=>r.day===today && r.bg===bg && r.term===term);
  if (row) row.count++;
  else rows.push({day:today,bg,term,count:1});
  const cutoff=new Date(Date.now()-30*864e5).toISOString().slice(0,10);
  s.searchMisses=rows.filter(r=>r.day>=cutoff);
}
export function gapReport(s,c,env) {
  const scope = bg => has(c.u,"demand",bg) || has(c.u,"audit",bg);
  const cutoff=new Date(Date.now()-30*864e5).toISOString().slice(0,10);
  const terms = new Map(), demand = new Map(), inaccessible=[];
  for (const r of s.searchMisses || []) if(scope(r.bg) && r.day>=cutoff)
    terms.set(r.term,(terms.get(r.term)||0)+r.count);
  for (const r of s.requests) if(scope(r.bg) && r.created.slice(0,10)>=cutoff) {
    const key=[r.country || "未登记国家",r.channel || "未登记伙伴类型",r.searchContext?.query || r.title].join(" · ");
    demand.set(key,(demand.get(key)||0)+1);
  }
  const users=people(s,c).filter(p=>p.role==="partner" && p.active!==false).map(p=>effective(s,p,c,env));
  for (const m of s.materials.filter(m=>active(m) && scope(m.bg))) {
    const targets=users.filter(u=>allowed(u,m.defaultView));
    let blocked=0, blockedDownload=0;
    for (const u of targets) {
      const view=visible(m,u,s.materials);
      if (!view) blocked++;
      else if (allowed(u,m.defaultDownload) && !view.files.some(f=>f.canDownload)) blockedDownload++;
    }
    if (blocked || blockedDownload) inaccessible.push({id:m.id,title:m.title,bg:m.bg,blocked,blockedDownload,total:targets.length});
  }
  const ranked = map => Array.from(map,([label,count])=>({label,count})).sort((a,b)=>b.count-a.count || a.label.localeCompare(b.label));
  return {terms:ranked(terms),demand:ranked(demand),inaccessible};
}
