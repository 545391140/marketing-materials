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
const log = (s, u, action, id) =>
  s.audit.unshift({ name: u.name, action, id, date: stamp() });
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
export function snapshot(s, c) {
  const { u } = c,
    materials = s.materials.map((m) => visible(m, u)).filter(Boolean),
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
    user: publicPerson(u),
    demo: c.demo,
    choices: c.demo ? Object.values(profiles).map(publicPerson) : [],
    materials,
    packs,
    requests,
    notices: [
      ...s.notices.filter((n) => n.to === u.id),
      ...expiryNotices(materials, p),
    ],
    prefs: {
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
      drafts: s.drafts.filter((m) => manages(u, m)),
      published: s.materials
        .filter((m) => manages(u, m))
        .map((m) => ({
          ...m,
          files: m.files.map(({ original, previewKey, preview, ...f }) => f),
        })),
      queue: s.requests.filter(
        (r) => u.role === "reviewer" || u.grants.some((g) => g.bg === r.bg),
      ),
      library: s.library,
      packDrafts: s.packDrafts.filter((d) => manages(u, d)),
      packs: s.packs.filter((d) => manages(u, d)),
      audit: s.audit
        .filter((e) => e.name === u.name || u.role === "reviewer")
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
  const u = c.u,
    p = prefs(s, u),
    op = a.op;
  if (op === "fav" || op === "list") {
    const k = op;
    if (p[k].includes(a.id)) p[k] = p[k].filter((x) => x !== a.id);
    else {
      need(
        s.materials.some((m) => m.id === a.id && visible(m, u)),
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
        s.materials.some((m) => m.id === id && visible(m, u)),
      );
    return;
  }
  if (op === "read") {
    const warnings = expiryNotices(
      s.materials.map((m) => visible(m, u)).filter(Boolean),
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
    const r = {
      id: "RQ-" + uid().slice(0, 8),
      title: brief(a.title),
      purpose: str(a.purpose, 2000),
      format: brief(a.format),
      due: checkDate(a.due),
      external: !!a.external,
      needDownload: !!a.needDownload,
      bg: u.grants[0]?.bg || "未分派",
      by: u.id,
      name: u.name,
      owner: "",
      status: "待受理",
      created: stamp(),
      history: [],
    };
    note(s, r, u, "提交资料需求");
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
  need(staff(u), 403, "仅授权维护人员可访问");
  const request = (id) => {
    const r = s.requests.find((r) => r.id === id);
    need(
      r && (u.role === "reviewer" || u.grants.some((g) => g.bg === r.bg)),
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
        deliver(s, r, m, await recipient(c, env, r.by), a.files || []),
        409,
        "所选资料不符合提交人的权限或用途",
      );
      note(s, r, u, "已交付资料");
      return;
    }
    if (op === "assign") {
      need(u.role === "reviewer", 403, "分派需要运营权限");
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
  if (op === "library") {
    need(u.role === "reviewer", 403, "需要运营权限");
    const name = brief(a.name);
    need(name, 400, "名称不能为空");
    if (a.kind === "category") {
      if (!s.library.categories.includes(name)) s.library.categories.push(name);
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
        u.role === "reviewer" &&
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
    const defV = validRules(a.defaultView),
      defD = validRules(a.defaultDownload);
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
      const v = f.inherit ? defV : validRules(f.view),
        d = f.inherit ? defD : validRules(f.download);
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
    const d = {
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
    if (old) Object.assign(old, d);
    else s.drafts.unshift(d);
    if (assigned) {
      assigned.status = a.submit ? "审核中" : "处理中";
      assigned.owner = u.name;
      note(s, assigned, u, assigned.status);
    }
    log(s, u, d.state, d.id);
    return;
  }
  if (op === "review") {
    const d = s.drafts.find((x) => x.id === a.id);
    need(
      d &&
        manages(u, d) &&
        d.state === "待审核" &&
        u.role === "reviewer" &&
        d.author !== u.id,
      403,
      "需由另一名审核人审核",
    );
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
      log(s, u, "退回草稿", d.id);
      return;
    }
    const prev = s.materials.find((m) => m.id === d.mid);
    need(
      (prev?.version || 0) === d.baseVersion,
      409,
      "资料已有新版本，请从新版重新编辑",
    );
    need(!d.expires || d.expires >= day(), 409, "资料已过期");
    const {
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
      if (deliver(s, req, m, await recipient(c, env, req.by), deliveryFiles))
        note(s, req, u, "资料已发布并交付");
      else {
        req.status = "处理中";
        note(s, req, u, "需另备符合用途的版本");
      }
    }
    log(s, u, "审核发布 v" + m.version, m.id);
    return;
  }
  if (op === "withdraw") {
    const m = s.materials.find((x) => x.id === a.id);
    need(m && manages(u, m), 403, "无权下架");
    need(brief(a.comment), 400, "请填写下架原因");
    m.published = false;
    notifySaved(s, m, "清单或收藏中的资料已下架");
    log(s, u, "下架：" + brief(a.comment), m.id);
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
