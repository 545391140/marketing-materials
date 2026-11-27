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
import { recipient } from "./db.js";
const stamp = () => new Date().toISOString();
const publicPerson = (u) => ({
  id: u.id,
  name: u.name,
  role: u.role,
  org: u.org,
});
function notifySaved(s, m, msg) {
  for (const [to, p] of Object.entries(s.users))
    if (p.fav.includes(m.id) || p.list.includes(m.id))
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
        (p.fav.includes(m.id) || p.list.includes(m.id)),
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
function fileInfo({ id, name, ext, size, usage, inherit, view, download, uploadedAt }) {
  return { id, name, ext, size, usage, inherit, view, download, uploadedAt };
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

export function snapshot(s, c, env) {
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
      deliveryFiles: undefined,
    }));
  const out = {
    user: {...publicPerson(u),scopes:u.scopes,root:u.root},
    demo: c.demo,
    choices: c.demo ? Object.values(profiles).map(publicPerson) : [],
    materials,
    packs:packs.filter(k=>has(u,"kits",k.bg)),
    requests:has(u,"personal")?requests:[],
    notices: has(u,"personal") ? [
      ...s.notices.filter((n) => n.to === u.id),
      ...expiryNotices(materials, p),
    ] : [],
    prefs: !has(u,"personal") ? {fav:[],list:[],deadline:"",notes:""} : {
      ...p,
      fav: p.fav.filter((id) => ids.has(id)),
      list: p.list.map((id) => (ids.has(id) ? id : null)),
    },
    library: {
      types: [...new Set(materials.map((m) => m.type))],
      categories: [...new Set(materials.map((m) => m.cat))],
    },
    admin: null,
  };
  if (staff(u)) {
    out.admin = {
      system:any(u,["users","roles","diagnose"])?systemView(s,c,env):null,
      stalled:s.drafts.filter(d=>d.state==="待审核" && has(u,"flow",d.bg) && !people(s,c).some(p=>
        p.active!==false && canReview(d,effective(s,p,c,env)))).map(d=>d.id),
      reviewerChoices:c.demo && has(u,"flow") ? people(s,c).map(p=>({id:p.id,name:p.name,bgs:effective(s,p,c,env).scopes.filter(g=>has(u,"flow",g.bg) && g.caps.includes("review")).map(g=>g.bg)})).filter(p=>p.bgs.length):[],
      reviewerRoles:roleList(s).filter(r=>r.caps.includes("review")).map(({id,name})=>({id,name})),
      audienceCatalog: audienceCatalog(c),
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
export async function change(s, c, env, a) {
  const op=a.op;
  if(["saveRole","assignRoles","syncDirectory"].includes(op)) return administer(s,c,env,a);
  const caps={fav:"personal",list:"personal",checklist:"personal",read:"personal",request:"request",reply:"request",
    claim:"demand",assign:"assign",ask:"demand",decline:"demand",deliver:"demand",library:"catalog",savePack:"kitEdit",
    packReview:"review",save:"edit",withdraw:"withdraw",review:"review",saveFlow:"flow",reassignStep:"flow"};
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
    const r = {
      category: subject ? "资料纠错" : "资料需求",
      subjectId: subject?.id || "",
      id: "RQ-" + uid().slice(0, 8),
      title: brief(a.title),
      purpose: str(a.purpose, 2000),
      format: brief(a.format),
      due: checkDate(a.due),
      external: !!a.external,
      needDownload: !!a.needDownload,
      bg: subject?.bg || u.grants[0]?.bg || "未分派",
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
  if (["claim", "assign", "ask", "decline", "deliver"].includes(op)) {
    const r = request(a.id);
    need(!["已交付", "已关闭"].includes(r.status), 409, "需求已结束");
    if (op === "deliver") {
      const m = s.materials.find((x) => x.id === a.mid);
      need(m && manages(u, m), 404, "资料不可用");
      need(
        deliver(s, r, m, await recipientUser(r.by), a.files || []),
        409,
        "所选资料不符合提交人的权限或用途",
      );
      note(s, r, u, "已交付资料");
      return;
    }
    if (op === "assign") {
      r.owner = brief(a.owner);
      need(r.owner, 400, "填写负责人");
      r.status = "处理中";
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
      !old || (manages(u, old) && old.state !== "待审核"),
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
  if (op === "save") {
    const old = s.drafts.find((x) => x.id === a.id),
      base = a.mid && s.materials.find((m) => m.id === a.mid);
    need(
      !old || (manages(u, old) && old.state !== "待审核"),
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
      return {
        ...src,
        view: v,
        download: d,
        usage: f.usage,
        inherit: !!f.inherit,
      };
    });
    const assigned = a.req ? request(a.req) : null;
    if (assigned)
      need(!["已交付", "已关闭"].includes(assigned.status), 409, "需求已结束");
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
    const d = {
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
      owner: u.name,
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
    const req = d.req
      ? s.requests.find(
          (r) => r.id === d.req && !["已交付", "已关闭"].includes(r.status),
        )
      : null;
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
    const {
      approval,
      state,
      reason,
      author,
      mid,
      baseVersion,
      req: rid,
      deliveryFiles,
      ...meta
    } = d;
    const m = {
      ...meta,
      id: mid,
      published: true,
      version: baseVersion + 1,
      updated: day(),
    };
    s.materials = [m, ...s.materials.filter((x) => x.id !== mid)];
    s.drafts = s.drafts.filter((x) => x !== d);
    if (prev) notifySaved(s, m, "关注的资料已换版，请核对更新内容");
    if (req) {
      if (deliver(s, req, m, await recipientUser(req.by), deliveryFiles))
        note(s, req, u, "资料已发布并交付");
      else {
        req.status = "处理中";
        note(s, req, u, "需另备符合用途的版本");
      }
    }
    log(s, u, "审核发布 v" + m.version, m.id, {
      materialId: m.id, title: m.title, bg: m.bg, version: m.version,
      note: [stageNote, m.revisionNote, brief(a.comment)].filter(Boolean).join(" · "),
      owner: m.owner, filenames: m.files.map((f) => f.name),
    });
    return;
  }
  if (op === "withdraw") {
    const m = s.materials.find((x) => x.id === a.id);
    need(m && manages(u, m), 403, "无权下架");
    need(brief(a.comment), 400, "请填写下架原因");
    m.published = false;
    notifySaved(s, m, "清单或收藏中的资料已下架");
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
