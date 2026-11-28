import Vue from "vue";
import Studio from "./studio.js";
import { call, fileUrl } from "./shared.js";
import template from "./admin.html";

new Vue({
  el: "#app",
  template,
  components: { Studio },
  data: () => ({
    d: null,
    busy: false,
    account: false,
    preview: null,
    alert: "",
    err: "",
    fatal: "",
    reading: false,
  }),
  async created() {
    await this.refresh();
    this.timer = setInterval(this.pollInbox, 30000);
    window.addEventListener("focus", this.pollInbox);
    window.addEventListener("keydown", this.key);
  },
  beforeDestroy() {
    clearInterval(this.timer);
    clearTimeout(this.toastTimer);
    window.removeEventListener("focus", this.pollInbox);
    window.removeEventListener("keydown", this.key);
  },
  methods: {
    tx(value) {
      return value;
    },
    key(e) {
      if (e.key === "Escape") {
        this.preview = null;
        this.account = false;
      }
    },

    reload() {
      location.reload();
    },
    async refresh() {
      try {
        this.d = await call("admin/state");
        this.fatal = "";
        return true;
      } catch (e) {
        this.d = null;
        this.preview = null;
        this.fatal = e.message;
        return false;
      }
    },
    async pollInbox() {
      if (this.busy || this.reading || document.visibilityState === "hidden")
        return;
      this.reading = true;
      try {
        const prev = this.d,
          next = await call("inbox");
        if (
          prev === this.d &&
          !this.busy &&
          (!prev ||
            prev.revision !== next.revision ||
            prev.user.id !== next.userId)
        )
          await this.refresh();
      } catch {
        await this.refresh();
      } finally {
        this.reading = false;
      }
    },
    toast(msg) {
      this.alert = msg;
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => (this.alert = ""), 3500);
    },
    async action(payload, message = "操作已保存") {
      if (this.busy) return false;
      this.busy = true;
      this.err = "";
      try {
        await call("actions", payload);
        if (!(await this.refresh())) return false;
        this.toast(message);
        return true;
      } catch (e) {
        this.err = e.message;
        this.toast(e.message);
        return false;
      } finally {
        this.busy = false;
      }
    },
    async profile(id) {
      this.account = false;
      try {
        await call("profile", { id });
        if (!(await this.refresh())) this.reload();
      } catch (e) {
        this.toast(e.message);
      }
    },
    async previewFile(m, f) {
      const view = { title: f.name, loading: true, text: "", img: "" };
      this.preview = view;
      const url = fileUrl(m, f, "preview", true);
      try {
        if (["jpg", "jpeg", "png"].includes(f.ext)) view.img = url;
        else {
          const res = await fetch(url);
          const data = await res.json();
          if (!res.ok) throw Error(data.error);
          view.text = data.text;
        }
      } catch (e) {
        view.text = e.message;
      } finally {
        view.loading = false;
      }
    },
  },
});
