import { slotId, myShares, closeLink, updateSharedVersions } from "./shares.js";
import { opportunities, editOpportunity, recordSearch, directoryOptions, validDay } from "./operations.js";
import { searchContext, languages } from "../shared/discovery.js";
import { systemView, administer } from "./system.js";
import { effective, permittedUser, roleList, people } from "./roles.js";
import { has, any, materialCaps } from "../shared/permissions.js";
import { saveFlow, startApproval } from "./approval.js";
import { canReview, currentStep } from "../shared/approval.js";
import {
  need,
  uid,
  day,
  str,
  validRules,
  subset,
  visible,
  allowed,
  active,
  staff,
  manages,
  prefs,
  deliver,
} from "./access.js";
import { audienceCatalog } from "./audience-catalog.js";
import { profiles, taskNames } from "./seed.js";
import { recipient, readState, update } from "./db.js";
const stamp = () => new Date().toISOString();
const tracks = (p,id) => p.fav.includes(id) || p.list.includes(id) ||
  p.opportunities?.some(list => list.items.some(item => item.mid === id));
const publicPerson = (u) => ({
  id: u.id,
  name: u.name,
  role: u.role,
  org: u.org,
});
function notifySaved(s, m, msg, excluded = new Set()) {
  for (const [to, p] of Object.entries(s.users))
    if (!excluded.has(to) && tracks(p,m.id))
      s.notices.unshift({
        key: uid(),
        to,
        mid: m.id,
        msg,
        date: day(),
        read: false,
      });
}
const note = (s, r, user, action) => {
  r.history.push({ at: stamp(), name: user.name, action });
  r.updated = stamp();
};
const log = (s, u, action, id, details = {}) =>
  s.audit.unshift({ name: u.name, action, id, date: stamp(), ...details });
const message = (s, r, msg) =>
  s.notices.unshift({
    to: r.by,
    rid: r.id,
    key: uid(),
    msg,
    date: day(),
    read: false,
  });
function checkDate(s) {
  need(!s || /^\d{4}-\d{2}-\d{2}$/.test(s), 400, "日期格式错误");
  return s || "";
}
function expiryNotices(materials, p) {
  const cutoff = new Date(Date.now() + 30 * 86400000)
    .toISOString()
    .slice(0, 10);
  return materials
    .filter(
      (m) =>
        m.expires &&
        m.expires <= cutoff &&
        tracks(p,m.id),
    )
    .map((m) => {
      const key = "expiry:" + m.id + ":" + m.version + ":" + m.expires;
      return {
        key,
        mid: m.id,
        msg: "关注的资料即将到期：" + m.title,
        date: m.expires,
        read: (p.readExpiry || []).includes(key),
      };
    });
}
function fileInfo({ id, name, ext, size, usage, inherit, view, download, uploadedAt, customerShare, customerDownload, shareSlot }) {
  return { id, name, ext, size, usage, inherit, view, download, uploadedAt, customerShare, customerDownload, shareSlot };
}

function pendingUploads(s, u) {
  const referenced = new Set();
  for (const m of [...s.materials, ...s.drafts]) {
    referenced.add(m.coverId);
    for (const f of m.files) referenced.add(f.id);
  }
  return Object.values(s.uploads || {})
    .filter((f) => f.uploader === u.id && !f.filed && !referenced.has(f.id))
    .reverse().map(fileInfo);
}

export function materialHistory(s, u, id) {
  const m = s.drafts.find((d) => d.id === id) || s.materials.find((m) => m.id === id);
  need(m && any(u,materialCaps,m.bg), 404, "资料不可用");
  const mid = m.mid || m.id;
  return s.audit.filter((e) =>
    e.materialId ? e.materialId === mid && any(u,materialCaps,e.bg)
      : e.id === m.id || e.id === mid);
}

export function snapshot(s, c, env, includeAdmin = true) {
  const { u } = c,
    materials = s.materials
      .map((m) => visible(m, u, s.materials))
      .filter(Boolean),
    ids = new Set(materials.map((m) => m.id)),
    p = prefs(s, u);
  const packs = s.packs
    .map((k) => ({ ...k, refs: k.refs.filter((id) => ids.has(id)) }))
    .filter((k) => k.refs.length);
  const requests = s.requests
    .filter((r) => r.by === u.id)
    .map((r) => ({
      ...r,
      material: materials.some(
        (m) =>
          m.id === r.material &&
          m.version === r.version &&
          (r.deliveryFiles || []).every((id) =>
            m.files.some(
              (f) =>
                f.id === id &&
                (!r.external || (f.usage === "可发客户" && f.canDownload)) &&
                (!r.needDownload || f.canDownload),
            ),
          ),
      )
        ? r.material
        : null,
      deliveryFiles: undefined, parentId:undefined,
    }));
  const out = {
    user: {...publicPerson(u),scopes:u.scopes,root:u.root},
    affiliations: u.grants.filter(g=>has(u,"request",g.bg)).map(({bg,region,country,channel})=>({bg,region,country,channel})),
    shares: myShares(s,u,env.SHARE_ORIGIN),
    opportunities: has(u,"personal") ? opportunities(s,u,materials) : [],
    demo: c.demo,
    choices: c.demo ? Object.values(profiles).map(publicPerson) : [],
    materials,
    packs:packs.filter(k=>has(u,"kits",k.bg)),
    requests:has(u,"personal")?requests:[],
    notices: has(u,"personal") ? [
      ...s.notices.filter(n => n.to === u.id).map(({ replacementId, ...n }) => {
        const replacement = replacementId && materials.find(m => m.id === replacementId);
        return replacement ? { ...n, mid: replacement.id, msg: n.msg + "。替代资料：《" + replacement.title + "》" } : n;
      }),
      ...expiryNotices(materials, p),
    ] : [],
    prefs: !has(u,"personal") ? {fav:[],list:[],deadline:"",notes:""} : {
      ...p, opportunities: undefined,
      fav: p.fav.filter((id) => ids.has(id)),
      list: p.list.map((id) => (ids.has(id) ? id : null)),
    },
    library: {
      types: [...new Set(materials.map((m) => m.type))],
      categories: [...new Set(materials.map((m) => m.cat))],
    },
    canManage: !!staff(u),
    admin: null,
  };
  if (includeAdmin && staff(u)) {
    out.admin = {
      system:any(u,["users","roles","diagnose"])?systemView(s,c,env):null,
      stalled:s.drafts.filter(d=>d.state==="待审核" && has(u,"flow",d.bg) && !people(s,c).some(p=>
        p.active!==false && canReview(d,effective(s,p,c,env)))).map(d=>d.id),
      reviewerChoices:c.demo && has(u,"flow") ? people(s,c).map(p=>({id:p.id,name:p.name,bgs:effective(s,p,c,env).scopes.filter(g=>has(u,"flow",g.bg) && g.caps.includes("review")).map(g=>g.bg)})).filter(p=>p.bgs.length):[],
      reviewerRoles:roleList(s).filter(r=>r.caps.includes("review")).map(({id,name})=>({id,name})),
      audienceCatalog: audienceCatalog(c),
      accountOptions:directoryOptions(s,c,env),
      managementBgs: [...new Set(u.grants.map((g) => g.bg))],
      pendingUploads: has(u,"edit")?pendingUploads(s, u):[],
      approvalRules: (s.approvalRules || []).filter((r) => any(u,["edit","flow"],r.bg)).sort((a, b) => a.priority - b.priority),
      drafts: s.drafts.filter((m) => any(u,[...materialCaps,"diagnose"],m.bg)).map((m) => ({ ...m, files: m.files.map(fileInfo) })),
      published: s.materials
        .filter((m) => any(u,[...materialCaps,"demand","diagnose","kitEdit"],m.bg))
        .map((m) => ({
          ...m,
          proofNeedsReview:
            !!m.proofId &&
            !s.materials.some(
              (p) =>
                p.id === m.proofId && active(p) && p.version === m.proofVersion,
            ),
          files: m.files.map(fileInfo),
        })),
      queue: s.requests.filter(
        (r) => any(u,["demand","assign"],r.bg),
      ),
      library: s.library,
      packDrafts: s.packDrafts.filter((d) => any(u,["review","kitEdit"],d.bg)),
      packs: s.packs.filter((d) => any(u,["review","kitEdit"],d.bg)),
      audit: s.audit
        .filter((e) => e.bg ? has(u,"audit",e.bg) : u.root)
        .slice(0, 60),
    };
  }
  return out;
}
const brief = (a) => str(a, 240);
function listTags(a) {
  return (Array.isArray(a) ? a : []).slice(0, 12).map(brief).filter(Boolean);
}
const scheduled = "待定时发布";
function publicationTime(input, expires) {
  if (!input) return "";
  need(typeof input === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(input) &&
    Number.isFinite(Date.parse(input)), 400, "发布时间须包含日期、时间和时区");
  const iso = new Date(input).toISOString();
  need(!expires || iso.slice(0, 10) <= expires, 400, "发布时间晚于资料有效期");
  return iso;
}
function linkedRequest(s, d) {
  return s.requests.find(r => r.id === d.req && !["已交付", "已关闭"].includes(r.status));
}
function stopSchedule(s, d, u, reason) {
  d.state = "已退回";
  d.reason = reason;
  d.publishAt = "";
  delete d.releaseApproval;
  d.approval = null;
  const req = linkedRequest(s, d);
  if (req) {
    req.status = "处理中";
    note(s, req, u, reason);
  }
  log(s, u, "取消定时发布", d.id, { materialId: d.mid, title: d.title, bg: d.bg, note: reason });
}
async function deliverMerged(s,parent,m,recipientUser,files,u) {
  let delivered=0;
  for(const child of s.requests.filter(x=>x.parentId===parent.id && x.status==="合并处理中")) {
    if(deliver(s,child,m,await recipientUser(child.by),files)) {
      delivered++;
      note(s,child,u,"资料已发布并交付");
    }
    else {
      child.parentId=""; child.status="处理中";
      note(s,child,u,"当前版本未满足此需求的权限或用途，已单独跟进");
    }
  }
  return delivered;
}
async function publishApproved(s, d, u, stageNote, comment, recipientUser) {
  const prev = s.materials.find(m => m.id === d.mid);
  const req = linkedRequest(s, d);
  const {
    approval, publishAt, releaseApproval,
    state,
    reason,
    author,
    mid,
    baseVersion,
    req: rid,
    deliveryFiles,
    ...meta
  } = d;
  if(prev && (prev.reviewRevision||0)>(d.baseReviewRevision||0)) {
    meta.owner=prev.owner;meta.ownerId=prev.ownerId;meta.reviewOn=prev.reviewOn;
  }
  delete meta.baseReviewRevision;
  const m = {
    ...meta,reviewRevision:prev?.reviewRevision||0,
    id: mid,
    published: true,
    version: baseVersion + 1,
    updated: day(),
  };
  s.materials = [m, ...s.materials.filter((x) => x.id !== mid)];
  s.drafts = s.drafts.filter((x) => x !== d);
  if (prev) updateSharedVersions(s,m);
  if (prev) notifySaved(s, m, "关注的资料已换版，请核对更新内容");
  if (req) {
    if (deliver(s, req, m, await recipientUser(req.by), deliveryFiles))
      note(s, req, u, "资料已发布并交付");
    else {
      req.status = "处理中";
      note(s, req, u, "需另备符合用途的版本");
    }
  }
  if(req) await deliverMerged(s,req,m,recipientUser,deliveryFiles,u);
  log(s, u, "审核发布 v" + m.version, m.id, {
    materialId: m.id, title: m.title, bg: m.bg, version: m.version,
    note: [stageNote, m.revisionNote, comment].filter(Boolean).join(" · "),
    owner: m.owner, filenames: m.files.map((f) => f.name),
  });
}
export async function releaseDue(env, ns) {
  const stored = await readState(env, ns);
  const due = d => d.state === scheduled && Date.parse(d.publishAt) <= Date.now();
  const dueReview = m => active(m) && m.ownerId && m.reviewOn && m.reviewOn<=day() &&
    m.reviewReminder !== [m.version,m.ownerId,m.reviewOn,m.reviewRevision||0].join("/");
  if (!stored.s.drafts.some(due) && !stored.s.materials.some(dueReview)) return {...stored,released:0,notified:0};
  const counts=await update(env, ns, async s => {
    let released=0;
    const before=s.notices.length;
    for (const m of s.materials.filter(dueReview)) {
      m.reviewReminder=[m.version,m.ownerId,m.reviewOn,m.reviewRevision||0].join("/");
      s.notices.unshift({to:m.ownerId,key:uid(),studio:true,mid:m.id,msg:"请复核《"+m.title+"》v"+m.version+" 的内容有效性",date:day(),read:false});
    }
    for (const d of s.drafts.filter(due).sort((a,b) => a.publishAt.localeCompare(b.publishAt))) {
      const u = d.releaseApproval;
      const prev = s.materials.find(m => m.id === d.mid);
      const proof = d.proofId && s.materials.find(m => m.id === d.proofId);
      const ctx = { demo: !env.PC_SESSION_URL, u: { id: "" } };
      const reviewer = people(s, ctx).find(p => p.id === u.id);
      if ((prev?.version || 0) !== d.baseVersion || (d.expires && d.expires < day()) ||
          (d.proofId && (!proof || proof.version !== d.proofVersion || !reviewer || !visible(proof, effective(s, reviewer, ctx, env), s.materials)))) {
        stopSchedule(s, d, u, "资料版本、有效期或引用证据已变化，请复核后重新送审");
        continue;
      }
      const previousNotices=s.notices.length;
      await publishApproved(s, d, u, u.stageNote, u.comment,
        async id => {
          try {
            return effective(s, await recipient(ctx, env, id), ctx, env);
          } catch {
            // Publication can proceed. Delivery stays assigned until recipient access can be checked.
            return null;
          }
        });
      released++;
      const m=s.materials.find(x=>x.id===d.mid);
      const notified=new Set(s.notices.slice(0,s.notices.length-previousNotices).map(n=>n.to));
      for(const p of people(s,ctx)) {
        const account=effective(s,p,ctx,env);
        if(p.active===false || !["sales","partner"].includes(p.role) || notified.has(p.id) ||
          !has(account,"personal") || !visible(m,account,s.materials)) continue;
        s.notices.unshift({to:p.id,key:uid(),mid:m.id,date:day(),read:false,msg:"《"+m.title+"》v"+m.version+" 已按计划发布"});
      }
    }
    return {released,notified:s.notices.length-before};
  });
  return {...await readState(env,ns),...counts};
}
export async function change(s, c, env, a) {
  const op=a.op;
  if (op==="closeShare") return closeLink(s,c.u,a.id);
  if (["createOpportunity","saveOpportunityItem","removeOpportunityItem"].includes(op)) return editOpportunity(s,c.u,a);
  if (op==="searchMiss") return recordSearch(s,c.u,a);
  if(["saveRole","assignRoles","syncDirectory"].includes(op)) return administer(s,c,env,a);
  const caps={fav:"personal",list:"personal",checklist:"personal",read:"personal",request:"request",reply:"request",
    planDemand:"demand",mergeDemand:"demand",contentReview:"edit",claim:"demand",assign:"assign",ask:"demand",decline:"demand",deliver:"demand",library:"catalog",savePack:"kitEdit",
    packReview:"review",save:"edit",cancelSchedule:"edit",withdraw:"withdraw",review:"review",saveFlow:"flow",reassignStep:"flow"};
  const cap=caps[op];
  need(cap && has(c.u,cap),403,"当前账号缺少此操作权限");
  const u=permittedUser(c.u,cap), p=prefs(s,u);
  const recipientUser=async id=>effective(s,await recipient(c,env,id),c,env);
  if (op === "fav" || op === "list") {
    const k = op;
    if (p[k].includes(a.id)) p[k] = p[k].filter((x) => x !== a.id);
    else {
      need(
        s.materials.some((m) => m.id === a.id && visible(m, u, s.materials)),
        404,
        "资料不可用",
      );
      p[k].push(a.id);
    }
    return;
  }
  if (op === "checklist") {
    p.deadline = checkDate(a.deadline);
    p.notes = str(a.notes, 2000);
    if (a.clean)
      p.list = p.list.filter((id) =>
        s.materials.some((m) => m.id === id && visible(m, u, s.materials)),
      );
    return;
  }
  if (op === "read") {
    const warnings = expiryNotices(
      s.materials.map((m) => visible(m, u, s.materials)).filter(Boolean),
      p,
    );
    p.readExpiry = [
      ...new Set([
        ...(p.readExpiry || []),
        ...warnings.filter((n) => !a.key || n.key === a.key).map((n) => n.key),
      ]),
    ];
    for (const n of s.notices)
      if (n.to === u.id && (!a.key || n.key === a.key)) n.read = true;
    return;
  }
  if (op === "request") {
    need(brief(a.title) && str(a.purpose), 400, "请说明需要什么资料和用途");
    const subject = a.subjectId
      ? s.materials.find(
          (m) => m.id === a.subjectId && visible(m, u, s.materials),
        )
      : null;
    if (a.subjectId) need(subject, 404, "资料不可用");
    const affiliation=u.grants[a.affiliation ?? 0];
    need(affiliation,400,"请选择有效签约关系");
    const r = {
      searchContext:searchContext(a.searchContext),country:affiliation.country || "",channel:affiliation.channel || "",
      category: subject ? "资料纠错" : "资料需求",
      subjectId: subject?.id || "",
      id: "RQ-" + uid().slice(0, 8),
      title: brief(a.title),
      purpose: str(a.purpose, 2000),
      format: brief(a.format),
      due: checkDate(a.due),
      external: !!a.external,
      needDownload: !!a.needDownload,
      bg: subject?.bg || affiliation.bg || "未分派",
      by: u.id,
      name: u.name,
      owner: subject?.owner || "",
      status: "待受理",
      created: stamp(),
      history: [],
    };
    note(s, r, u, subject ? "问题已反馈给资料负责人" : "提交资料需求");
    s.requests.unshift(r);
    return;
  }
  if (op === "reply") {
    const r = s.requests.find((r) => r.id === a.id && r.by === u.id);
    need(r && r.status === "待补充" && str(a.comment), 400, "请填写补充信息");
    r.status = "处理中";
    note(s, r, u, str(a.comment, 1500));
    return;
  }
  need(staff(u) && u.grants.length, 403, "仅授权维护人员可访问");
  const request = (id) => {
    const r = s.requests.find((r) => r.id === id);
    need(
      r && u.grants.some(g=>g.bg===r.bg),
      404,
      "未找到需求",
    );
    return r;
  };
  if (op==="contentReview") {
    const m=s.materials.find(x=>x.id===a.id);
    need(m && manages(u,m),403,"没有该资料的复核权限");
    need(m.version===a.version && (m.reviewRevision||0)===(a.reviewRevision||0),409,"复核记录已更新，请刷新");
    const owner=await recipientUser(a.ownerId);
    need(owner && has(owner,"edit",m.bg),400,"负责人须有该 BG 的编辑权限");
    const reviewOn=validDay(a.reviewOn);
    need(reviewOn>=day(),400,"下次复核日期已过");
    if(m.ownerId!==owner.id && u.id!==owner.id) s.notices.unshift({
      to:owner.id,key:uid(),mid:m.id,msg:"你已接手《"+m.title+"》的内容复核，截止 "+reviewOn,date:day(),read:false,studio:true
    });
    m.ownerId=owner.id; m.owner=owner.name; m.reviewOn=reviewOn;
    m.reviewRevision=(m.reviewRevision||0)+1;
    if(a.confirm) m.reviewedAt=stamp();
    log(s,u,a.confirm?"已确认内容仍有效":"更新复核责任",m.id,{materialId:m.id,bg:m.bg,title:m.title,note:owner.name+" · "+reviewOn});
    return;
  }
  if (op==="mergeDemand" || op==="planDemand") {
    const r=request(a.id);
    need(!["已交付","已关闭"].includes(r.status) && !r.parentId,409,"请选择未结束的主需求");
    if(op==="planDemand") {
      r.promised=validDay(a.promised);
      for(const member of s.requests.filter(x=>x.id===r.id || x.parentId===r.id)) {
        if(["已交付","已关闭"].includes(member.status)) continue;
        member.promised=r.promised;
        note(s,member,u,"承诺交付日期 "+r.promised);
        message(s,member,"资料预计于 "+r.promised+" 交付");
      }
    } else {
      const child=request(a.childId);
      need(r.id!==child.id && r.bg===child.bg && !child.parentId && !s.requests.some(x=>x.parentId===child.id) &&
        !["已交付","已关闭","审核中","待定时发布"].includes(child.status),409,"请选择同 BG 可合并的独立需求");
      child.parentId=r.id; child.status="合并处理中"; child.promised=r.promised||"";
      child.owner=r.owner; note(s,child,u,"已纳入同类需求统一制作");
      note(s,r,u,"合并需求 "+child.id);
    }
    return;
  }
  if (["claim", "assign", "ask", "decline", "deliver"].includes(op)) {
    const r = request(a.id);
    need(!["已交付", "已关闭"].includes(r.status), 409, "需求已结束");
    need(!r.parentId,409,"请从主需求处理");
    if (op === "deliver") {
      const m = s.materials.find((x) => x.id === a.mid);
      need(m && manages(u, m), 404, "资料不可用");
      const files=a.files || [];
      const parentDelivered=deliver(s,r,m,await recipientUser(r.by),files);
      const childCount=await deliverMerged(s,r,m,recipientUser,files,u);
      need(parentDelivered || childCount,409,"所选资料不符合提交人的权限或用途");
      if(parentDelivered) note(s,r,u,"已交付资料");
      else {
        r.status="处理中";
        note(s,r,u,"已向有权限的关联需求交付，主需求待补充适用版本");
      }
      return;
    }
    if (op === "assign") {
      r.owner = brief(a.owner);
      need(r.owner, 400, "填写负责人");
      r.status = "处理中";
      for (const child of s.requests.filter(x=>x.parentId===r.id && x.status==="合并处理中")) child.owner=r.owner;
      note(s, r, u, "已分派给 " + r.owner);
      return;
    }
    if (op === "claim") {
      r.owner = u.name;
      r.status = "处理中";
    } else {
      need(str(a.comment), 400, "请填写说明");
      r.status = op === "ask" ? "待补充" : "已关闭";
      message(s, r, op === "ask" ? "资料需求待补充" : "资料需求已有处理说明");
    }
    for (const child of s.requests.filter(x=>x.parentId===r.id && x.status==="合并处理中")) {
      if(op==="claim") child.owner=r.owner;
      if(op==="decline") {
        child.status="已关闭";note(s,child,u,str(a.comment,1500));message(s,child,"资料需求已有处理说明");
      }
    }
    note(s, r, u, str(a.comment, 1500) || "已认领");
    return;
  }
  if (op === "reassignStep") {
    const d=s.drafts.find(m=>m.id===a.id && m.state==="待审核" && has(u,"flow",m.bg));
    need(d && str(a.comment) && (d.approval?.token || "")===a.token,409,"请重新打开当前节点并填写原因");
    const target=await recipientUser(a.to);
    need(target && target.id!==d.author && has(target,"review",d.bg),400,"请选择可审核该 BG 的其他人员");
    if(!d.approval) d.approval={name:"标准发布审核",ruleId:"转派",index:0,steps:[{name:"发布审核"}]};
    const step=currentStep(d), before=step.reviewerName || "该 BG 审核人";
    Object.assign(step,{roleId:"",reviewerId:target.id,reviewerName:target.name});
    d.approval.token=uid();
    d.approval.reassigned=true;
    log(s,u,"转派 "+step.name,d.id,{materialId:d.mid,title:d.title,bg:d.bg,note:before+" → "+target.name+" · "+str(a.comment)});
    return;
  }
  if (op === "saveFlow") {
    const rule = await saveFlow(s, c, env, a);
    log(s, u, (rule.active ? "保存审批流程 " : "停用审批流程 ") + rule.name, rule.id, { bg: rule.bg });
    return;
  }
  if (op === "library") {
    const name = brief(a.name);
    need(name, 400, "名称不能为空");
    if (a.kind === "category") {
      if (!s.library.categories.includes(name)) s.library.categories.push(name);
    } else if (a.kind === "product" || a.kind === "solution") {
      const key = a.kind === "product" ? "products" : "solutions";
      const entries = s.library[key] || (s.library[key] = []);
      if (!entries.includes(name)) entries.push(name);
    } else {
      const old = s.library.types.find((t) => t.name === name);
      const t = {
        name,
        fields: listTags(a.fields),
        active: a.active !== false,
      };
      if (old) Object.assign(old, t);
      else s.library.types.push(t);
    }
    log(s, u, "维护分类与类型", name);
    return;
  }
  if (op === "savePack") {
    const old = s.packDrafts.find((d) => d.id === a.id);
    need(
      !old || (manages(u, old) && !["待审核", scheduled].includes(old.state)),
      409,
      "草稿不可编辑",
    );
    need(
      brief(a.title) && str(a.intro) && a.refs?.length && a.steps?.length,
      400,
      "请填写名称、介绍、步骤并选择资料",
    );
    need(
      a.refs.every((id) =>
        s.materials.some((m) => m.id === id && manages(u, m) && active(m)),
      ),
      400,
      "引用资料不可用",
    );
    const t = {
      id: old?.id || uid(),
      baseId: old?.baseId || brief(a.baseId),
      title: brief(a.title),
      intro: str(a.intro, 1500),
      steps: listTags(a.steps),
      refs: listTags(a.refs),
      img: cover(a.img),
      task: taskNames.includes(a.task) ? a.task : taskNames[0],
      state: "待审核",
      author: u.id,
      owner: u.name,
      bg: u.grants[0].bg,
    };
    if (t.baseId)
      need(
        s.packs.some((x) => x.id === t.baseId && manages(u, x)),
        403,
        "无权修改",
      );
    if (old) Object.assign(old, t);
    else s.packDrafts.unshift(t);
    return;
  }
  if (op === "packReview") {
    const d = s.packDrafts.find((x) => x.id === a.id);
    need(
      d &&
        manages(u, d) &&
        u.id !== d.author &&
        d.state === "待审核",
      403,
      "不可审核此场景包",
    );
    if (!a.approve) {
      need(brief(a.comment), 400, "填写退回原因");
      d.state = "已退回";
      d.reason = brief(a.comment);
      return;
    }
    const id = d.baseId || uid();
    s.packs = [
      {
        id,
        title: d.title,
        intro: d.intro,
        steps: d.steps,
        refs: d.refs,
        img: d.img,
        task: d.task,
        owner: d.owner,
        bg: d.bg,
      },
      ...s.packs.filter((x) => x.id !== id),
    ];
    s.packDrafts = s.packDrafts.filter((x) => x !== d);
    log(s, u, "发布场景包", id);
    return;
  }
  if (op === "cancelSchedule") {
    const d = s.drafts.find(x => x.id === a.id);
    need(d && manages(u, d), 403, "无权取消定时发布");
    need(d.state === scheduled && a.publishAt === d.publishAt, 409, "发布计划已变更，请刷新");
    stopSchedule(s, d, u, "编辑已取消定时发布，修改后请重新送审");
    return;
  }
  if (op === "save") {
    const old = s.drafts.find((x) => x.id === a.id),
      base = a.mid && s.materials.find((m) => m.id === a.mid);
    need(
      !old || (manages(u, old) && !["待审核", scheduled].includes(old.state)),
      409,
      "草稿不可编辑",
    );
    need(!a.mid || (base && manages(u, base)), 403, "无权修改");
    const bg = brief(a.bg) || u.grants[0].bg;
    need(
      u.grants.some((g) => g.bg === bg),
      403,
      "BG 超出管理范围",
    );
    const typ = s.library.types.find((t) => t.name === a.type);
    need(
      typ &&
        (typ.active || base?.type === a.type) &&
        s.library.categories.includes(a.cat),
      400,
      "请选择有效分类和类型",
    );
    const catalog = audienceCatalog(c);
    const previous = old || base;
    const defV = validRules(a.defaultView, catalog, previous?.defaultView),
      defD = validRules(a.defaultDownload, catalog, previous?.defaultDownload);
    need(subset(defD, defV), 400, "下载范围须包含在查看范围内");
    need(
      brief(a.title) &&
        str(a.summary) &&
        Array.isArray(a.files) &&
        a.files.length &&
        a.files.length <= 15,
      400,
      "填写标题、简介并上传附件",
    );
    const sources = [
      ...(old?.files || []),
      ...(base?.files || []),
      ...Object.values(s.uploads || {}).filter((f) => f.uploader === u.id),
    ];
    const files = a.files.map((f) => {
      const src = sources.find((x) => x.id === f.id);
      need(src, 400, "附件不在当前草稿中");
      const v = f.inherit ? defV : validRules(f.view, catalog, src.view),
        d = f.inherit ? defD : validRules(f.download, catalog, src.download);
      if (!f.inherit)
        need(subset(v, defV) && subset(d, defD), 400, "附件权限不能超出资料默认范围");
      need(
        subset(d, v) &&
          ["仅内部", "伙伴学习", "可发客户", "内部学习"].includes(f.usage),
        400,
        "请核对附件用途和权限",
      );
      need(
        f.usage !== "仅内部" ||
          v.every(
            (r) =>
              r.role !== "伙伴" && r.role !== "partner" && r.role !== "全部",
          ),
        400,
        "仅内部附件需限定员工身份",
      );
      const replaces=f.replaces && base?.files.find(x=>x.id===f.replaces);
      need(!f.replaces || replaces,400,"只能替换当前资料原有的附件");
      const customerShare=f.usage==="可发客户" && (f.customerShare ?? src.customerShare)===true;
      return {
        ...src, shareSlot:replaces ? slotId(replaces) : f.replaces==="" && !base?.files.some(x=>x.id===src.id) ? src.id : slotId(src), customerShare,
        customerDownload:customerShare && (f.customerDownload ?? src.customerDownload)===true,
        view: v,
        download: d,
        usage: f.usage,
        inherit: !!f.inherit,
      };
    });
    const assigned = a.req ? request(a.req) : null;
    if (assigned)
      need(!assigned.parentId && !["已交付", "已关闭"].includes(assigned.status), 409, "需求已结束");
    const proof = a.proofId
      ? s.materials.find((x) => x.id === a.proofId)
      : null;
    if (a.proofId)
      need(
        proof && proof.id !== base?.id && visible(proof, u, s.materials),
        400,
        "选择有效且可引用的证据资料",
      );
    const product = brief(a.product ?? previous?.product), solution = brief(a.solution ?? previous?.solution);
    need((!product || s.library.products?.includes(product)) &&
      (!solution || s.library.solutions?.includes(solution)), 400, "请选择目录中的产品和方案");
    const language=brief(a.language ?? previous?.language);
    need(!language || languages.includes(language),400,"请选择有效的资料语言");
    const markets=listTags(a.markets ?? previous?.markets);
    need(markets.every(x=>x==="全球" || catalog.countries.some(c=>c.value===x)),400,"请选择有效适用国家");
    const ownerId=brief(a.ownerId || previous?.ownerId || u.id);
    const owner=ownerId===u.id ? u : await recipientUser(ownerId);
    need(owner && has(owner,"edit",bg),400,"负责人须有该 BG 的编辑权限");
    const d = {
      language,models:listTags(a.models ?? previous?.models),aliases:listTags(a.aliases ?? previous?.aliases),
      markets, ownerId, baseReviewRevision:old?.baseReviewRevision ?? base?.reviewRevision ?? 0, reviewOn:a.reviewOn ? validDay(a.reviewOn) : previous?.reviewOn || new Date(Date.now()+90*86400000).toISOString().slice(0,10),
      product, solution,
      proofId: proof?.id || "",
      proofVersion: proof?.version || 0,
      id: old?.id || uid(),
      mid: base?.id || old?.mid || uid(),
      baseVersion: old?.baseVersion ?? base?.version ?? 0,
      title: brief(a.title),
      type: a.type,
      cat: a.cat,
      industry: brief(a.industry),
      task: taskNames.includes(a.task) ? a.task : taskNames[0],
      img: cover(a.img),
      summary: str(a.summary, 1800),
      tags: listTags(a.tags),
      revisionNote: str(a.revisionNote, 700),
      opening: str(a.opening, 900),
      advice: str(a.advice, 900),
      evidence: str(a.evidence, 600),
      support: str(a.support, 350),
      fields: Object.fromEntries(
        typ.fields.map((k) => [k, str(a.fields?.[k], 500)]),
      ),
      expires: checkDate(a.expires),
      publishAt: publicationTime(a.publishAt, a.expires),
      bg,
      defaultView: defV,
      defaultDownload: defD,
      files,
      req: assigned?.id || "",
      deliveryFiles: (a.deliveryFiles || []).filter((id) =>
        files.some((f) => f.id === id),
      ),
      state: a.submit ? "待审核" : "草稿",
      author: u.id,
      owner: owner.name,
      updated: day(),
    };
    d.approval = a.submit ? await startApproval(s, d,c,env) : null;
    if (a.coverId) {
      const f = s.uploads?.[a.coverId];
      need(
        f?.previewKey &&
          (f.uploader === u.id ||
            base?.coverId === f.id ||
            old?.coverId === f.id),
        400,
        "封面图片不可用",
      );
      d.coverId = f.id;
    } else d.coverId = "";
    if (d.req && a.submit)
      need(d.deliveryFiles.length, 400, "请选择交付给提交人的附件");
    for (const id of [...files.map((f) => f.id), d.coverId])
      if (s.uploads?.[id]) s.uploads[id].filed = true;
    need(new Set(files.map(slotId)).size===files.length,400,"同一个附件位置不能重复使用");
    if (old) Object.assign(old, d, { reason: "" });
    else s.drafts.unshift(d);
    if (assigned) {
      assigned.status = a.submit ? "审核中" : "处理中";
      assigned.owner = u.name;
      note(s, assigned, u, assigned.status);
    }
    log(s, u, d.state, d.id, { materialId: d.mid, title: d.title, bg: d.bg, note: d.approval?.name });
    return;
  }
  if (op === "review") {
    const d = s.drafts.find((x) => x.id === a.id);
    need(
      d &&
        manages(u, d) &&
        canReview(d, u),
      403,
      "需由另一名审核人审核",
    );
    const flow = d.approval;
    // Legacy clients can still process the built-in one-step route.
    if (flow?.ruleId || flow?.reassigned || a.stepToken)
      need(flow && a.stepToken === flow.token, 409, "审批节点已更新，请重新打开资料");
    need(typeof a.approve === "boolean", 400, "请选择审批结果");
    const stage = currentStep(d).name;
    const stageNote = flow?.ruleId ? flow.name + " · " + stage : "";
    const req = linkedRequest(s, d);
    if (!a.approve) {
      need(brief(a.comment), 400, "请填写退回原因");
      d.state = "已退回";
      d.reason = brief(a.comment);
      if (req) {
        req.status = "处理中";
        note(s, req, u, "资料退回修改");
      }
      log(s, u, "退回草稿", d.id, { materialId: d.mid, title: d.title, bg: d.bg, note: [stageNote, d.reason].filter(Boolean).join(" · ") });
      return;
    }
    if (flow && flow.index < flow.steps.length - 1) {
      flow.index += 1;
      flow.token = uid();
      log(s, u, "节点通过：" + stage, d.id, { materialId: d.mid, title: d.title,
        bg: d.bg, note: [flow.name, brief(a.comment)].filter(Boolean).join(" · ") });
      return;
    }
    if (d.proofId)
      need(
        s.materials.some(
          (x) =>
            x.id === d.proofId &&
            x.version === d.proofVersion &&
            visible(x, u, s.materials),
        ),
        409,
        "引用证据已有变化，请退回重新核实",
      );
    const prev = s.materials.find((m) => m.id === d.mid);
    need(
      (prev?.version || 0) === d.baseVersion,
      409,
      "资料已有新版本，请从新版重新编辑",
    );
    need(!d.expires || d.expires >= day(), 409, "资料已过期");
    if (d.publishAt && Date.parse(d.publishAt) > Date.now()) {
      need(!s.drafts.some(x => x !== d && x.mid === d.mid && x.state === scheduled), 409, "此资料已有待定时发布的版本");
      d.state = scheduled;
      if (req) {
        req.status = scheduled;
        note(s, req, u, "终审通过，等待定时发布");
      }
      d.releaseApproval = { name: u.name, id: u.id, stageNote, comment: brief(a.comment) };
      log(s, u, "终审通过，等待定时发布", d.id, { materialId: d.mid, title: d.title, bg: d.bg, note: d.publishAt });
      return;
    }
    await publishApproved(s, d, u, stageNote, brief(a.comment), recipientUser);
    return;
  }
  if (op === "withdraw") {
    const m = s.materials.find((x) => x.id === a.id);
    need(m && manages(u, m), 403, "无权下架");
    need(brief(a.comment), 400, "请填写下架原因");
    need(m.published && (a.version == null || a.version === m.version), 409, "发布版本已变化，请刷新");
    const replacement = a.replacementId && s.materials.find(x => x.id === a.replacementId);
    need(!a.replacementId || (replacement && replacement.id !== m.id && active(replacement) && manages(u, replacement)), 400, "替代资料不可用");
    m.published = false;
    updateSharedVersions(s,m);
    for (const d of s.drafts.filter(x => x.mid === m.id && x.state === scheduled))
      stopSchedule(s, d, u, "当前版本已下架，定时发布已取消");
    const downloaders = new Set(s.audit.filter(e => e.action === "下载附件" && e.downloadMid === m.id &&
      e.version === m.version).map(e => e.userId));
    for (const to of downloaders)
      s.notices.unshift({ key: uid(), to, msg: "请停止使用已下载的《" + m.title + "》v" + m.version +
        "。下架原因：" + brief(a.comment), replacementId: replacement?.id, date: day(), read: false });
    notifySaved(s, m, "清单或收藏中的资料已下架", downloaders);
    log(s, u, "下架：" + brief(a.comment), m.id, { materialId: m.id, title: m.title, bg: m.bg });
    return;
  }
  need(false, 400, "未知操作");
}
export const cover = (s) =>
  [
    "campus",
    "retail",
    "office",
    "factory",
    "datacenter",
    "event",
    "hero",
  ].includes(s)
    ? s
    : "campus";
