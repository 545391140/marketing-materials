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
  expires: "",
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
  components: { ruleEditor, reviewScope },
  data() {
    return {
      sim: { role: "伙伴", bg: "EBG", region: "东南亚", country: "TH", channel: "经销" },
      section: "资料管理",
      filter: "",
      q: "",
      mine: false,
      view: "",
      form: blank(),
      tagText: "",
      uploading: false,
      localError: "",
      review: null,
      reqId: "",
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
      sections: [
        ["资料管理", "Library"],
        ["需求池", "Inbox"],
        ["发布审核", "ShieldCheck"],
        ["场景包", "Layers"],
        ["分类与类型", "Settings2"],
        ["操作记录", "Activity"],
      ],
    };
  },
  computed: {
    a() {
      return this.d.admin;
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
      return this.d.user.role === "reviewer";
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
    materialRows() {
      return [
        ...this.a.drafts.map((m) => ({ ...m, draft: true })),
        ...this.a.published.map((m) => ({
          ...m,
          state: m.published ? "已发布" : "已下架",
        })),
      ].filter(
        (m) =>
          (!this.filter || m.state === this.filter) &&
          (!this.q || m.title.includes(this.q)),
      );
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
  methods: {
    t(v) {
      return this.$root.tx(v);
    },
    date,
    action(a, msg) {
      return this.$root.action(a, msg);
    },
    sectionTo(s) {
      this.section = s;
      this.filter = "";
      this.q = "";
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
        b.files = b.files.map((x) => ({ ...x, inherit: !!x.inherit }));
      }
      if (req) {
        const r = this.r;
        b.req = req;
        b.title = r.title;
        b.summary = r.purpose;
      }
      this.form = b;
      this.tagText = b.tags.join("，");
      this.view = "edit";
    },
    async upload(e) {
      this.localError = "";
      this.uploading = true;
      try {
        for (const f of Array.from(e.target.files)) {
          const fd = new FormData();
          fd.append("file", f);
          const obj = await call("upload", fd);
          this.form.files.push({
            ...obj,
            inherit: true,
            view: rules(),
            download: rules(),
            usage: "伙伴学习",
          });
          if (this.form.req) this.form.deliveryFiles.push(obj.id);
        }
      } catch (e) {
        this.localError = e.message;
      } finally {
        this.uploading = false;
        e.target.value = "";
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
      this.form.tags = this.tagText
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (await this.action({ ...this.form, op: "save", submit })) {
        this.back();
        this.section = "资料管理";
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
      this.reqId = r.id;
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
      this.view = "withdraw";
    },
  },
};
