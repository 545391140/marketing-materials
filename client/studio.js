import { audienceCheck,reviewRecord,gapPanel } from "./editor-tools.js";
import { languages } from "../shared/discovery.js";
import systemAdmin from "./system-admin.js";
import {has,menus} from "../shared/permissions.js";
import flowConfig from "./flow-config.js";
import { selectFlow, currentStep, canReview } from "../shared/approval.js";
import { rules, call, date, tasks } from "./shared.js";
import { ruleEditor, reviewScope } from "./audience.js";
import { allowed } from "../shared/audience.js";
import template from "./studio.html";
const clone = (x) => JSON.parse(JSON.stringify(x));
const blank = () => ({
  id: "",
  mid: "",
  title: "",
  type: "解决方案",
  cat: "园区网络",
  product: "",
  solution: "",
  industry: "通用",
  bg: "EBG",
  task: tasks[0],
  img: "campus",
  summary: "",
  tags: [],
  opening: "",
  advice: "",
  evidence: "",
  proofId: "",
  support: "",
  expires: "",language:"", markets:[],models:[],aliases:[],ownerId:"",reviewOn:"",
  publishAt: "",
  defaultView: rules(),
  defaultDownload: rules(),
  files: [],
  fields: {},
  req: "",
  deliveryFiles: [],
});
export default {
  template,
  props: ["d", "busy"],
  components: { audienceCheck,reviewRecord,gapPanel,ruleEditor, reviewScope, flowConfig, systemAdmin },
  data() {
    return {
      sim: { role: "伙伴", job:"售前", companyId:"", bg: "EBG", region: "东南亚", country: "TH", channel: "经销" },
      section: "资料管理",
      filter: "",
      q: "",
      typeFilter: "",
      bgFilter: "",
      historyRows: null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      replacementId: "",
      mine: false,
      assignedOnly: false,
      view: "",
      form: blank(),
      tagText: "",
      uploadScope: { inherit: true, view: [], download: [] },
      uploading: false,
      localError: "",
      review: null,
      reqId: "",mergeChild:"",promiseDate:"",modelsText:"",aliasesText:"",languages,
      comment: "",
      delivery: "",
      fileIds: [],
      assignTo: "",
      lib: { kind: "type", name: "", fields: "", active: true },
      pack: {},
      steps: "",
      reviewPack: null,
      images: ["campus", "retail", "factory", "office", "datacenter", "event"],
      tasks,

    };
  },
  computed: {
    menuGroups(){return menus(this.d.user);},
    availableSections(){return this.menuGroups.flatMap(([,items])=>items.map(i=>i[0]));},
    a() {
      return this.d.admin;
    },
    matchedFlow() { return selectFlow(this.a.approvalRules, this.form, this.a.flowDefaults.find(x=>x.bg===this.form.bg)?.enabled) || {name:"未配置匹配流程",steps:[]}; },
    reviewQueue() {
      return this.a.drafts.filter((d) => d.state === "待审核" && (this.can("review",d.bg) || canReview(d,this.d.user)) &&
        (!this.assignedOnly || canReview(d, this.d.user)));
    },
    reviewKits() {
      return this.a.packDrafts.filter((d) => d.state === "待审核" &&
        (!this.assignedOnly || (this.isRev && d.author !== this.d.user.id)));
    },
    previousMaterial() {
      return this.review && this.a.published.find((m) => m.id === this.review.mid);
    },
    removedFiles() {
      if (!this.previousMaterial) return [];
      const current = new Set(this.review.files.map((f) => f.id));
      return this.previousMaterial.files.filter((f) => !current.has(f.id));
    },
    isRev() {
      return this.can("review");
    },
    pending() {
      return (
        this.a.drafts.filter((x) => x.state === "待审核").length +
        this.a.packDrafts.filter((x) => x.state === "待审核").length
      );
    },
    queue() {
      return this.a.queue
        .filter(
          (r) =>
            (!this.filter || r.status === this.filter) &&
            (!this.mine || r.owner === this.d.user.name) &&
            (!this.q || [r.title, r.name, r.id].join(" ").includes(this.q)),
        )
        .sort((x, y) => (x.due || "9999").localeCompare(y.due || "9999"));
    },
    ledger() {
      const today = new Date().toISOString().slice(0, 10);
      const cutoff = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      return [
        ...this.a.drafts.map((m) => ({ ...m, draft: true })),
        ...this.a.published.map((m) => ({
          ...m,
          state: !m.published ? "已下架" : m.expires && m.expires < today ? "已过期" : "已发布",
          expiring: m.published && m.expires >= today && m.expires <= cutoff,
        })),
      ];
    },
    workItems() {
      return [
        { title: "待整理附件", count: this.a.pendingUploads.length, section: "待整理附件", icon: "UploadCloud" },
        { title: "待受理需求", count: this.a.queue.filter((r) => r.status === "待受理").length, section: "需求池", filter: "待受理", icon: "Inbox" },
        { title: "待我审核", count: this.a.drafts.filter(d=>canReview(d,this.d.user)).length + this.a.packDrafts.filter(d=>d.state==="待审核" && d.author!==this.d.user.id && this.can("review",d.bg)).length, section: "发布审核", icon: "ShieldCheck" },
        ...["待内容复核","待定时发布", "已退回", "即将到期", "已过期", "证据待复核"].map((title) => ({
          title, count: this.ledger.filter((m) => this.matchesState(m, title)).length,
          section: "资料管理", filter: title, icon: title === "已退回" ? "PenLine" : "Clock3",
        })),
      ].filter(w=>this.availableSections.includes(w.section));
    },
    materialRows() {
      const keyword = this.q.trim().toLowerCase();
      return this.ledger.filter((m) =>
        ["read","edit","withdraw"].some(key=>this.can(key,m.bg)) && this.matchesState(m, this.filter) && (!this.typeFilter || m.type === this.typeFilter) &&
        (!this.bgFilter || m.bg === this.bgFilter) &&
        [m.title, m.owner, m.cat, ...m.files.map((f) => f.name)].some((s) => s?.toLowerCase().includes(keyword)));
    },
    r() {
      return this.a.queue.find((r) => r.id === this.reqId);
    },
    dm() {
      return this.a.published.find((x) => x.id === this.delivery);
    },
    typ() {
      return this.a.library.types.find((t) => t.name === this.form.type);
    },
  },
  mounted() {
    const params=new URLSearchParams(location.search);
    const draft=this.a.drafts.find(d=>d.id===params.get("review"));
    if(draft && canReview(draft,this.d.user)) { this.sectionTo("发布审核"); this.inspect(draft); }
    else if(params.has("flow") && this.can("flow",params.get("flow"))) this.sectionTo("审批流程");
  },
  watch:{
    availableSections:{immediate:true,handler(list){
      if(!list.includes(this.section)) this.sectionTo(list.includes("资料管理")?"资料管理":list[0]);
    }},
  },
  methods: {
    can(k,bg){return has(this.d.user,k,bg);},
    t(v) {
      return this.$root.tx(v);
    },
    date,
    releaseTime(value) {
      return value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "long" }) : "终审通过后立即发布";
    },
    currentStep,
    canReview,
    action(a, msg) {
      return this.$root.action(a, msg);
    },
    matchesState(m, filter) {
      if (filter === "待内容复核") return m.published && (!m.ownerId || !m.reviewOn || m.reviewOn <= new Date().toISOString().slice(0,10));
      if (filter === "即将到期") return m.expiring;
      if (filter === "证据待复核") return m.published && m.proofNeedsReview;
      return !filter || m.state === filter;
    },
    openWork(item) {
      this.sectionTo(item.section);
      this.filter = item.filter || "";
      if(item.section==="发布审核") this.assignedOnly=true;
    },
    resumeUpload(file) {
      this.edit();
      this.form.title = file.name.replace(/\.[^.]+$/, "");
      this.form.defaultView = clone(file.view || []);
      this.form.defaultDownload = clone(file.download || []);
      this.form.files = [{ ...clone(file), view: clone(file.view || []),
        download: clone(file.download || []), usage: "伙伴学习", inherit: !!file.inherit }];
    },
    async showHistory(m) {
      this.review = m;
      this.view = "history";
      this.localError = "";
      this.historyRows = null;
      try {
        const entries = await call("admin/history?id=" + encodeURIComponent(m.id));
        if (this.review === m) this.historyRows = entries;
      } catch (e) {
        if (this.review === m) this.localError = e.message;
      }
    },
    sectionTo(s) {
      this.section = s;
      this.filter = "";
      this.assignedOnly = false;
      this.q = "";
      this.typeFilter = "";
      this.bgFilter = "";
      this.view = "";
      this.localError = "";
    },
    back() {
      this.view = "";
      this.localError = "";
    },
    edit(m = null, req = "") {
      this.localError = "";
      let b = blank();
      b.bg = this.d.user.scopes.find(s=>s.caps.includes("edit"))?.bg || "";
      if (m) {
        const isDraft = m.draft || !!m.mid;
        b = {
          ...b,
          ...clone(m),
          id: isDraft ? m.id : "",
          mid: isDraft
            ? this.a.published.some((p) => p.id === m.mid)
              ? m.mid
              : ""
            : m.id,
        };
        if (isDraft && m.publishAt) {
          const time = new Date(m.publishAt);
          b.publishAt = new Date(time.getTime() - time.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        } else b.publishAt = "";
        const base=this.a.published.find(p=>p.id===b.mid);
        b.files = b.files.map(x => {
          const original=base?.files.find(f=>f.id!==x.id && (f.shareSlot||f.id)===x.shareSlot);
          return {...x,inherit:!!x.inherit,replaces:original?.id||""};
        });
      }
      if (req) {
        const r = this.r;
        b.req = req;
        b.title = r.title;
        b.summary = r.purpose;
      }
      this.uploadScope = { inherit: true, view: [], download: [] };
      if(!b.ownerId) b.ownerId=this.d.user.id;
      if(!b.reviewOn) b.reviewOn=new Date(Date.now()+90*864e5).toISOString().slice(0,10);
      this.modelsText=(b.models||[]).join("，"); this.aliasesText=(b.aliases||[]).join("，");
      this.form = b;
      this.tagText = b.tags.join("，");
      this.view = "edit";
    },
    async upload(e) {
      this.localError = "";
      this.uploading = true;
      try {
        const draft = this.form;
        const scope = JSON.stringify({
          inherit: this.uploadScope.inherit,
          defaultView: draft.defaultView,
          defaultDownload: draft.defaultDownload,
          view: this.uploadScope.inherit ? draft.defaultView : this.uploadScope.view,
          download: this.uploadScope.inherit ? draft.defaultDownload : this.uploadScope.download,
          draftId: draft.id, materialId: draft.mid,
        });
        for (const f of Array.from(e.target.files)) {
          const fd = new FormData();
          fd.append("file", f);
          fd.append("permissions", scope);
          const obj = await call("upload", fd);
          draft.files.push({ ...obj, usage: "伙伴学习" });
          if (draft.req) draft.deliveryFiles.push(obj.id);
        }
      } catch (e) {
        this.localError = e.message;
      } finally {
        this.uploading = false;
        e.target.value = "";
        this.$root.pollInbox();
      }
    },
    async uploadCover(e) {
      const file = e.target.files[0];
      if (!file) return;
      this.uploading = true;
      try {
        const fd = new FormData();
        fd.append("file", file);
        const x = await call("upload", fd);
        this.$set(this.form, "coverId", x.id);
        this.$root.toast("封面图片已上传");
      } catch (e) {
        this.localError = e.message;
      } finally {
        this.uploading = false;
      }
    },
    simulate(f) {
      const a = this.sim;
      const role = a.role === "伙伴" ? "partner" : "sales";
      const match = (rs) => allowed({role, grants: [a]}, rs);
      const v = f.inherit ? this.form.defaultView : f.view,
        d = f.inherit ? this.form.defaultDownload : f.download;
      return match(v) ? (match(d) ? "可查看及下载" : "仅可预览") : "完全隐藏";
    },
    setInherit(f, checked) {
      if (!checked) {
        f.view = clone(this.form.defaultView);
        f.download = clone(this.form.defaultDownload);
      }
      f.inherit = checked;
    },
    oldScope(id, key) {
      if (!this.previousMaterial) return undefined;
      return this.previousMaterial.files.find((f) => f.id === id)?.[key] || [];
    },
    async save(submit) {
      this.form.models=this.modelsText.split(/[,，]/).map(v=>v.trim()).filter(Boolean);
      this.form.aliases=this.aliasesText.split(/[,，]/).map(v=>v.trim()).filter(Boolean);
      this.form.tags = this.tagText
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (await this.action({ ...this.form, publishAt: this.form.publishAt ? new Date(this.form.publishAt).toISOString() : "", op: "save", submit },
        submit ? "已提交审核，请由另一位审核人到发布审核处理" : "已保存草稿，提交审核后才会进入审核队列")) {
        this.sectionTo("资料管理");
      } else this.localError = this.$root.err;
    },
    inspect(m) {
      this.review = m;
      this.comment = "";
      this.view = "review";
    },
    async decide(approve) {
      if (
        await this.action({
          op: "review",
          id: this.review.id,
          stepToken: this.review.approval?.token,
          approve,
          comment: this.comment,
        })
      )
        this.back();
    },
    peek(m, f) {
      this.$root.previewFile(m, f, true);
    },
    startReq(r) {
      this.reqId = r.id; this.mergeChild=""; this.promiseDate=r.promised||"";
      this.view = "req";
      this.comment = "";
      this.fileIds = [];
      this.delivery = "";
      this.assignTo = "";
    },
    async handle(op) {
      if (
        await this.action({
          op,
          id: this.r.id,
          mid: this.delivery,
          files: this.fileIds,
          comment: this.comment,
          owner: this.assignTo,
        })
      ) {
        this.comment = "";
        this.fileIds = [];
      }
    },
    async saveType() {
      if (
        await this.action({
          ...this.lib,
          fields: this.lib.fields
            .split(/[,，]/)
            .map((x) => x.trim())
            .filter(Boolean),
          op: "library",
        })
      )
        this.lib = { kind: "type", name: "", fields: "", active: true };
    },
    editKit(k) {
      this.pack = k
        ? {
            ...clone(k),
            id: k.state ? k.id : "",
            baseId: k.state ? k.baseId : k.id,
          }
        : {
            id: "",
            baseId: "",
            title: "",
            intro: "",
            refs: [],
            img: "campus",
            task: tasks[0],
          };
      this.steps = k ? k.steps.join("\n") : "";
      this.view = "pack";
    },
    async submitKit() {
      if (
        await this.action({
          ...this.pack,
          op: "savePack",
          steps: this.steps
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean),
        })
      )
        this.back();
    },
    withdraw(m) {
      this.review = m;
      this.comment = "";
      this.replacementId = "";
      this.view = "withdraw";
    },
  },
};
