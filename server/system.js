import { need, uid, str, visible, active, fileAllowed } from "./access.js";
import { safeProfile, directoryEmployee, recipient } from "./db.js";
import { roleList, people, effective, remember, isRoot } from "./roles.js";
import { allowed, ALL, values } from "../shared/audience.js";
import { front, permissions, has } from "../shared/permissions.js";
const protectedCaps = ["users", "roles", "diagnose", "flow", "audit", "catalog"];
const recordFor = (s, id) => s.assignments?.find((v) => v.id === id);
const log = (s, u, action, id, bg) =>
  s.audit.unshift({
    name: u.name,
    action,
    id,
    bg,
    date: new Date().toISOString(),
  });
export function systemView(s, c, env) {
  const u = c.u;
  const accounts = people(s, c)
    .map((p) => {
      const person = effective(s, p, c, env);
      const scopes = person.scopes.filter(
        (g) => has(u, "users", g.bg) || has(u, "diagnose", g.bg) || u.root
      );
      return {
        ...p,
        grants: p.grants.filter((g) => scopes.some((b) => b.bg === g.bg)),
        scopes,
        root: person.root,
        version: recordFor(s, p.id)?.version || 0,
      };
    })
    .filter((p) => u.root || p.scopes.length);
  return {
    accounts,
    roles: roleList(s),
    cursor: s.directoryCursor || "",
    oaCursor:s.oaDirectoryCursor || "",
    canSyncOa:u.root && !c.demo && !!env.OA_SESSION_URL && !!env.OA_USERS_URL,
    canSync: u.root && !c.demo && !!env.PC_USERS_URL,
  };
}
export async function administer(s, c, env, a) {
  const u = c.u;
  if (a.op === "saveRole") {
    need(u.root, 403, "需要平台管理员权限");
    const list = s.businessRoles || (s.businessRoles = []),
      old = list.find((v) => v.id === a.id);
    need(
      !a.id || (old && old.version === a.version),
      409,
      "角色已更新，请重新打开"
    );
    const name = str(a.name, 80);
    need(
      name && !roleList(s).some((v) => v.id !== old?.id && v.name === name),
      400,
      "角色名称为空或重复"
    );
    need(
      Array.isArray(a.caps) &&
        a.caps.every((k) => Object.hasOwn(permissions, k) && k !== "roles"),
      400,
      "无效权限"
    );
    const r = {
      id: old?.id || uid(),
      name,
      caps: [...new Set(a.caps)],
      version: (old?.version || 0) + 1,
    };
    if (old) Object.assign(old, r);
    else list.push(r);
    log(
      s,
      u,
      "保存角色 " + name + " · " + r.caps.map((k) => permissions[k]).join("、"),
      r.id
    );
    return;
  }
  if (a.op === "syncDirectory") {
    const source = a.source === "OA" ? "OA" : "PC";
    const cursor = source === "OA" ? "oaDirectoryCursor" : "directoryCursor";
    const endpoint = env[source+"_USERS_URL"], token=env[source+"_SERVICE_TOKEN"];
    need(u.root && !c.demo && endpoint && token && (source==="PC" || env.OA_SESSION_URL),403,"用户目录未配置或无同步权限");
    const url = new URL(endpoint);
    if (s[cursor]) url.searchParams.set("cursor", s[cursor]);
    const res = await fetch(url, {
      headers: { authorization: "Bearer " + token },
      redirect: "error",
    });
    need(res.ok, 502, "门户用户目录同步失败");
    const data = await res.json();
    need(
      Array.isArray(data.users) &&
        (!data.next_cursor || typeof data.next_cursor === "string"),
      502,
      "无效的目录分页数据"
    );
    for (const p of data.users) {
      if (source === "PC" && env.OA_SESSION_URL && p.role !== "partner") continue;
      const row = source === "OA" ? directoryEmployee({...p, active:true}, s)
        : safeProfile({...p,active:true});
      remember(s,{...row,active:p.active!==false});
    }
    s[cursor] = data.next_cursor || "";
    log(s,u,"同步 "+source+" 目录 "+data.users.length+" 人","directory");
    return;
  }
  need(has(u, "users", a.bg) || u.root, 403, "无该 BG 用户管理权限");
  const p = await recipient(c, env, a.userId);
  need(
    p && !isRoot(p, c, env) && p.grants.some((g) => g.bg === a.bg),
    400,
    "用户不在此 BG 或为受保护账号"
  );
  const old = recordFor(s, p.id);
  need((old?.version || 0) === a.version, 409, "该用户授权已更新");
  const catalog = roleList(s);
  need(
    Array.isArray(a.ids) &&
      a.ids.every((id) => catalog.some((r) => r.id === id)),
    400,
    "无效角色"
  );
  const before = effective(s, p, c, env).scopes.find((g) => g.bg === a.bg).ids;
  if (!u.root) {
    need(p.id !== u.id, 403, "不能修改自己的授权");
    const protectedIds = catalog
      .filter((r) => r.caps.some((k) => protectedCaps.includes(k)))
      .map((r) => r.id);
    need(
      ![...a.ids, ...before].some((id) => protectedIds.includes(id)),
      403,
      "管理类角色由平台管理员授权"
    );
  }
  need(
    p.role !== "partner" ||
      catalog
        .filter((r) => a.ids.includes(r.id))
        .every((r) => r.caps.every((k) => front.includes(k))),
    400,
    "伙伴仅可分配前台角色"
  );
  const byBg = [
    ...(old?.byBg || []).filter((b) => b.bg !== a.bg),
    { bg: a.bg, ids: [...new Set(a.ids)] },
  ];
  const next = { id: p.id, version: a.version + 1, byBg };
  if (old) Object.assign(old, next);
  else (s.assignments || (s.assignments = [])).push(next);
  if (!c.demo) remember(s, p);
  const names = (ids) =>
    ids.map((id) => catalog.find((r) => r.id === id)?.name || id).join("、") ||
    "无角色";
  log(
    s,
    u,
    "授权 " + p.name + "：" + names(before) + " → " + names(a.ids),
    p.id,
    a.bg
  );
}
function mismatch(u, rules, cap = "browse") {
  if (!rules?.length) return "此附件未配置受众";
  const labels = {
    bg: "BG",
    region: "区域",
    country: "签约国家",
    channel: "伙伴类型", job:"员工岗位", companyId:"伙伴企业",
  };
  const grants = u.grants.filter((g) => has(u, "browse", g.bg));
  let closest;
  for (const rule of rules)
    for (const grant of grants) {
      const missing = Object.keys(labels)
        .filter(
          (k) =>
            rule[k] !== undefined &&
            rule[k] !== ALL &&
            !values(rule[k]).includes(grant[k] || (k === "job" ? u.job : undefined))
        )
        .map((k) => labels[k]);
      if (
        !allowed({ ...u, grants: [grant] }, [
          { ...rule, bg: ALL, region: ALL, country: ALL, channel: ALL, job:ALL, companyId:ALL },
        ])
      )
        missing.push("账号身份");
      if (!closest || missing.length < closest.length) closest = missing;
    }
  return closest?.length
    ? "最接近的授权组仍未匹配：" + closest.join("、")
    : "无符合条件的签约关系";
}
export async function diagnose(s, c, env, a) {
  const m = [...s.materials, ...s.drafts].find((x) => x.id === a.id);
  need(m && has(c.u, "diagnose", m.bg), 403, "无权诊断该资料");
  const p = await recipient(c, env, a.userId);
  need(
    p && p.grants.some((g) => has(c.u, "diagnose", g.bg)),
    404,
    "用户不可用或超出授权范围"
  );
  const u = effective(s, p, c, env);
  if (m.state) return { reason: "资料尚未发布 · " + m.state, files: [] };
  if (!active(m))
    return { reason: m.published ? "资料已过期" : "资料已下架", files: [] };
  if (!has(u, "browse")) return { reason: "角色缺少资料库权限", files: [] };
  const files = m.files.map((f) => ({
    name: f.name,
    reason: !fileAllowed(u, f.view, "browse")
      ? mismatch(u, f.view)
      : !has(u, "download")
      ? "可预览，角色未授权下载"
      : !fileAllowed(u, f.download, "download")
      ? "可预览，附件下载范围未匹配"
      : "可预览并下载",
  }));
  return {
    reason: visible(m, u, s.materials)
      ? "伙伴资料库可见"
      : files.some((f) => f.reason.startsWith("可预览"))
      ? "关联证据失效或对该账号不可见"
      : "没有符合查看授权的附件",
    files,
  };
}

export async function audiencePreview(s,c,env,a) {
  const draft=s.drafts.find(d=>d.id===a.id);
  const m=draft || s.materials.find(m=>m.id===a.id);
  const permitted=bg=>["edit","review","diagnose"].some(cap=>has(c.u,cap,bg));
  need(m && permitted(m.bg),403,"没有此资料的受众预览权限");
  const p=await recipient(c,env,a.userId);
  need(p && p.active!==false && p.grants.some(g=>permitted(g.bg)),404,"账号超出管理范围");
  const u=effective(s,p,c,env);
  const proposed=draft ? {...m,id:m.mid,version:m.baseVersion+1,published:true} : m;
  const catalog=[proposed,...s.materials.filter(x=>x.id!==proposed.id)];
  const card=visible(proposed,u,catalog);
  const files=m.files.map(f=>{
    const canView=fileAllowed(u,f.view,"browse"), canDownload=fileAllowed(u,f.download,"download");
    const reason=!has(u,"browse") ? "账号角色没有资料库权限" :
      !active(proposed) ? "资料已过期或下架" :
      !canView ? "查看范围 · "+mismatch(u,f.view) :
      !card ? "引用证据已失效或不可见" :
      !has(u,"download") ? "仅预览 · 角色缺少下载权限" :
      !canDownload ? "仅预览 · 下载范围 · "+mismatch(u,f.download,"download") : "可预览并下载";
    return {name:f.name,reason};
  });
  return {card:card && {id:card.id,img:card.img,coverId:card.coverId,title:card.title,summary:card.summary,
    bg:card.bg,type:card.type,cat:card.cat,industry:card.industry,version:card.version,updated:card.updated,
    language:card.language,markets:card.markets,files:card.files},files};
}
