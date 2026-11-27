import Vue from "vue";
import Vuex from "vuex";
import VueI18n from "vue-i18n";
import en from "./i18n.js";
import { call, card, date, fileUrl, tasks } from "./shared.js";
import Studio from "./studio.js";
import shell from "./shell.html";
import overlays from "./overlays.html";
Vue.use(Vuex);
Vue.use(VueI18n);
Vue.component("resource-card", card);
Vue.component("studio", Studio);
const store = new Vuex.Store({
  state: { data: null },
  mutations: {
    refresh(s, v) {
      s.data = v;
    },
  },
  actions: {
    async load({ commit }) {
      commit("refresh", await call("state"));
    },
  },
});
const portalLang = new URL(location.href).searchParams.get("lang");
const locale =
  (portalLang && ["en", "zh"].includes(portalLang) ? portalLang : null) ||
  localStorage.getItem("material-language") ||
  (document.documentElement.lang.startsWith("en") ? "en" : "zh");
const i18n = new VueI18n({ locale, messages: { en, zh: {} } });
const initialForm = () => ({
  title: "",
  purpose: "",
  format: "",
  due: "",
  external: false,
  needDownload: false,
});
const app = new Vue({
  el: "#app",
  store,
  i18n,
  template: shell.replace("<!--OVERLAYS-->", overlays),
  data() {
    return {
      page: "discover",
      tab: "我的收藏",
      modal: "",
      detailId: "",
      kitId: "",
      requestId: "",
      pick: 0,
      query: "",
      type: "全部",
      cat: "",
      ind: "",
      task: "",
      sort: "new",
      filters: false,
      account: false,
      menu: false,
      mobileSearch: false,
      locale,
      loading: true,
      fatal: "",
      alert: "",
      alertError: false,
      busy: false,
      err: "",
      form: initialForm(),
      reply: "",
      due: "",
      notes: "",
      preview: {},
      previewSeq: 0,
      toastTimer: null,
      focusReturn: null,
      taskNames: tasks,
      scenes: [
        {
          title: "走进智慧园区",
          desc: "从客户首访到方案交流，备齐园区网络的实战资料。",
          img: "hero",
          kit: "camp",
          en: "CAMPUS COLLECTION",
        },
        {
          title: "连锁门店新实践",
          desc: "从新店规划到集中运维，了解连锁门店的网络需求。",
          img: "retail",
          kit: "store",
          en: "RETAIL COLLECTION",
        },
        {
          title: "制造现场新视角",
          desc: "聚焦工业无线选型，准备客户关心的技术依据。",
          img: "factory",
          kit: "objection",
          en: "INDUSTRY COLLECTION",
        },
      ],
      shortcuts: [
        ["准备客户拜访", "拜访提纲与行业案例", "BriefcaseBusiness", "indigo"],
        ["回应客户问题", "选型依据与应答指南", "MessagesSquare", "green"],
        ["准备投标", "参数、资质与授权核对", "ClipboardCheck", "amber"],
      ],
      tabs: ["我的收藏", "任务清单", "我的需求", "站内消息"],
    };
  },
  computed: {
    d() {
      return store.state.data;
    },
    sc() {
      return this.scenes[this.pick];
    },
    staff() {
      return !!this.d?.admin;
    },
    filtered() {
      let out = this.d.materials.filter(
        (m) =>
          (this.type === "全部" || m.type === this.type) &&
          (!this.cat || m.cat === this.cat) &&
          (!this.ind || m.industry === this.ind) &&
          (!this.task || m.task === this.task) &&
          (!this.query ||
            [
              m.title,
              m.en,
              m.type,
              m.cat,
              m.industry,
              m.summary,
              m.opening,
              m.advice,
              ...m.tags,
            ]
              .join(" ")
              .toLowerCase()
              .includes(this.query.trim().toLowerCase())),
      );
      return out.sort((a, b) =>
        this.sort === "name"
          ? a.title.localeCompare(b.title, "zh")
          : b.updated.localeCompare(a.updated),
      );
    },
    material() {
      return this.d?.materials.find((m) => m.id === this.detailId);
    },
    kit() {
      return this.d?.packs.find((k) => k.id === this.kitId);
    },
    requestItem() {
      return this.d?.requests.find((r) => r.id === this.requestId);
    },
    unread() {
      return this.d?.notices.filter((n) => !n.read).length || 0;
    },
    fav() {
      return this.d.materials.filter((m) => this.d.prefs.fav.includes(m.id));
    },
    checklist() {
      return this.d.prefs.list
        .map((id) => this.d.materials.find((m) => m.id === id))
        .filter(Boolean);
    },
    packsShown() {
      return this.d.packs.filter(
        (p) =>
          (!this.task || p.task === this.task) &&
          (!this.query ||
            [p.title, p.intro, p.task].join("").includes(this.query)),
      );
    },
    title() {
      return this.tx(
        {
          discover: "资料发现",
          library: "资料库",
          packs: "场景包",
          work: "我的工作台",
          studio: "资料维护台",
        }[this.page] || "资料发现",
      );
    },
    roles() {
      return {
        partner: "伙伴",
        sales: "一线销售",
        editor: "资料编辑",
        reviewer: "发布审核",
      };
    },
  },
  async created() {
    try {
      await this.refresh();
      this.route();
    } catch (e) {
      this.fatal = e.message;
    } finally {
      this.loading = false;
    }
    window.addEventListener("hashchange", this.route);
    window.addEventListener("keydown", this.key);
    this.inboxTimer = window.setInterval(this.pollInbox, 30000);
    window.addEventListener("focus", this.pollInbox);
  },
  beforeDestroy() {
    clearInterval(this.inboxTimer);
    window.removeEventListener("focus", this.pollInbox);
    window.removeEventListener("keydown", this.key);
    window.removeEventListener("hashchange", this.route);
  },
  watch: {
    modal(v, old) {
      document.body.classList.toggle("lock", !!v);
      this.err = "";
      if (!old && v) this.focusReturn = document.activeElement;
      if (v) this.$nextTick(() => this.$refs.dialog?.focus());
      else this.$nextTick(() => this.focusReturn?.focus?.());
    },
  },
  methods: {
    tx(s) {
      return this.locale === "en" && Object.hasOwn(en, s)
        ? String(this.$t(s))
        : s;
    },
    date,
    fileUrl,
    tasks() {
      return tasks;
    },
    name(m) {
      return this.locale === "en" && m.en ? m.en : m.title;
    },
    async pollInbox() {
      if (
        !this.d ||
        this.busy ||
        this.pollingInbox ||
        document.visibilityState === "hidden"
      )
        return;
      this.pollingInbox = true;
      const prev = this.d;
      try {
        const inbox = await call("inbox");
        if (this.d !== prev || this.busy) return;
        const identityChanged = prev.user.id !== inbox.userId;
        const next = identityChanged || inbox.revision !== prev.revision
          ? await call("state")
          : { ...prev, notices: inbox.notices, requests: inbox.requests };
        if (this.d !== prev || this.busy) return;
        const seen = new Set(prev.notices.map((n) => n.key));
        const fresh = next.notices.find((n) => !n.read && !seen.has(n.key));
        store.commit("refresh", next);
        if (identityChanged) {
          this.due = next.prefs.deadline;
          this.notes = next.prefs.notes;
          this.nav(next.admin ? "studio" : "discover");
        }
        if (fresh) this.toast(fresh.msg);
      } catch {
        /* Keep the open form and retry at the next poll. */
      } finally {
        this.pollingInbox = false;
      }
    },
    async refresh() {
      await store.dispatch("load");
      this.due = this.d.prefs.deadline;
      this.notes = this.d.prefs.notes;
    },
    toast(msg, bad = false) {
      this.alert = msg;
      this.alertError = bad;
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => (this.alert = ""), 3500);
    },
    async action(a, msg = "操作已保存") {
      if (this.busy) return false;
      this.busy = true;
      this.err = "";
      try {
        await call("actions", a);
        await this.refresh();
        if (msg) this.toast(this.tx(msg));
        return true;
      } catch (e) {
        this.err = e.message;
        this.toast(e.message, true);
        return false;
      } finally {
        this.busy = false;
      }
    },
    nav(page, tab = "") {
      this.menu = false;
      this.account = false;
      this.modal = "";
      this.filters = false;
      const h = "#/" + page + (tab ? "/" + encodeURIComponent(tab) : "");
      if (location.hash === h) this.route();
      else location.hash = h;
    },
    route() {
      let [pg, id] = location.hash.replace(/^#\/?/, "").split("/");
      try {
        id = decodeURIComponent(id || "");
      } catch {
        id = "";
      }
      this.modal = "";
      if (pg === "material" || pg === "kit") {
        this.page = pg === "kit" ? "packs" : "library";
        if (pg === "kit") {
          this.kitId = id;
          this.modal = this.kit ? "kit" : "unavailable";
        } else {
          this.detailId = id;
          this.modal = this.material ? "detail" : "unavailable";
        }
      } else {
        this.page = ["library", "packs", "work", "studio"].includes(pg)
          ? pg
          : "discover";
        if (this.page === "studio" && !this.staff) this.page = "discover";
        if (this.page === "work" && this.tabs.includes(id)) this.tab = id;
      }
      this.account = false;
      this.menu = false;
      window.scrollTo(0, 0);
    },
    setPage(pg) {
      this.query = "";
      this.resetFilters();
      this.nav(pg);
    },
    resetFilters() {
      this.type = "全部";
      this.cat = "";
      this.ind = "";
      this.task = "";
      this.sort = "new";
    },
    search() {
      this.resetFilters();
      this.mobileSearch = false;
      this.nav("library");
    },
    shortcut(t) {
      this.query = "";
      this.resetFilters();
      this.task = t;
      this.nav("packs");
    },
    open(m) {
      this.detailId = m.id;
      this.modal = "detail";
      this.err = "";
    },
    openKit(id) {
      this.kitId = id;
      this.modal = this.kit ? "kit" : "unavailable";
    },
    close() {
      const deep = /^#\/(material|kit)\//.test(location.hash);
      this.modal = "";
      if (deep) this.nav(this.page);
    },
    jumpTab(t) {
      this.nav("work", t);
    },
    toggleFav(m) {
      return this.action(
        { op: "fav", id: m.id },
        this.d.prefs.fav.includes(m.id) ? "操作已保存" : "资料已加入收藏",
      );
    },
    toggleList(m) {
      return this.action({ op: "list", id: m.id });
    },
    requestForm() {
      this.form = initialForm();
      this.form.title = this.query;
      this.modal = "request";
    },
    reportMaterial(m) {
      this.form = {
        ...initialForm(),
        title: "资料纠错 · " + m.title,
        subjectId: m.id,
      };
      this.modal = "request";
    },
    async submitReq() {
      if (await this.action({ op: "request", ...this.form }, "需求已提交"))
        this.jumpTab("我的需求");
    },
    showReq(id) {
      this.requestId = id;
      this.reply = "";
      this.modal = "reqDetail";
    },
    async openNotice(n) {
      await this.action({ op: "read", key: n.key }, "");
      if (n.rid) this.showReq(n.rid);
      else {
        const m = this.d.materials.find((x) => x.id === n.mid);
        if (m) this.open(m);
        else this.modal = "unavailable";
      }
    },
    async previewFile(m, f, draft = false) {
      let seq = ++this.previewSeq;
      this.preview = {
        title: f.name,
        loading: true,
        back: draft ? "" : "detail",
      };
      this.modal = "preview";
      try {
        const url = fileUrl(m, f, "preview", draft);
        if (["jpg", "jpeg", "png"].includes(f.ext)) {
          if (seq === this.previewSeq)
            this.preview = { ...this.preview, img: url, loading: false };
        } else {
          const res = await fetch(url);
          const j = await res.json();
          if (!res.ok) throw Error(j.error);
          if (seq === this.previewSeq)
            this.preview = { ...this.preview, text: j.text, loading: false };
        }
      } catch (e) {
        if (seq === this.previewSeq)
          this.preview = { ...this.preview, text: e.message, loading: false };
      }
    },
    async profile(id) {
      this.account = false;
      try {
        await call("profile", { id });
        this.query = "";
        this.resetFilters();
        await this.refresh();
        this.nav(this.staff ? "studio" : "discover");
        this.toast(
          this.d.user.name + " · " + this.tx(this.roles[this.d.user.role]),
        );
      } catch (e) {
        this.toast(e.message, true);
      }
    },
    lang() {
      this.locale = this.locale === "zh" ? "en" : "zh";
      this.$i18n.locale = this.locale;
      document.documentElement.lang = this.locale === "en" ? "en" : "zh-CN";
      localStorage.setItem("material-language", this.locale);
      this.account = false;
    },
    support(m) {
      this.form = initialForm();
      this.form.title = "资料支持 · " + m.title;
      this.modal = "support";
      this.preview = {
        text:
          m.support ||
          "请通过现有渠道经理或区域售前申请方案支撑。示例空间暂未连接正式区域通讯录。",
      };
    },
    exportList() {
      const txt = [
        ["资料", "版本", "有效期", "核对结果"],
        ...this.checklist.map((m) => [
          m.title,
          "v" + m.version,
          m.expires || "未设置",
          this.due && m.expires && m.expires < this.due
            ? "需更新"
            : "请核实适用范围",
        ]),
      ]
        .map((a) =>
          a
            .map(
              (x) =>
                '"' +
                String(x)
                  .replace(/^[=+@-]/, "'$&")
                  .replaceAll('"', '""') +
                '"',
            )
            .join(","),
        )
        .join("\n");
      const url = URL.createObjectURL(
        new Blob(["\ufeff" + txt], { type: "text/csv;charset=utf-8" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "投标资料核对表.csv";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    },
    key(e) {
      if (e.key === "Escape") {
        if (this.modal) this.close();
        else {
          this.account = false;
          this.menu = false;
          this.mobileSearch = false;
        }
      }
      if (
        e.key === "/" &&
        !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)
      ) {
        e.preventDefault();
        this.mobileSearch = true;
        this.$nextTick(() => this.$refs.search?.focus());
      }
      if (e.key === "Tab" && this.modal) {
        const nodes = [
          ...this.$refs.dialog.querySelectorAll(
            "button,input,textarea,select,a[href]",
          ),
        ].filter((n) => !n.disabled && n.offsetParent !== null);
        if (
          nodes.length &&
          ((e.shiftKey &&
            [nodes[0], this.$refs.dialog].includes(document.activeElement)) ||
            (!e.shiftKey && document.activeElement === nodes.at(-1)))
        ) {
          e.preventDefault();
          (e.shiftKey ? nodes.at(-1) : nodes[0]).focus();
        }
      }
    },
  },
});
