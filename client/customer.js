import Vue from "vue";
import { readPreview } from "./document-preview.js";
import { render, staticRenderFns } from "customer:page";

const linkPath = location.pathname;
const validLink = /^\/s\/[A-Za-z0-9_-]{43}$/.test(linkPath);
const requestOptions = { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" };
const unavailable = "请联系资料发送人获取有效的分享链接。";
function fileUrl(file, mode) {
  const query = new URLSearchParams({ f: file.id, mode });
  return linkPath + "?" + query;
}
function isGone(status) { return [401, 403, 404, 410].includes(status); }
function expiry(value) {
  return typeof value === "number" ? value : Date.parse(value);
}

new Vue({
  el: "#shared-materials",
  render, staticRenderFns,
  data: () => ({
    info: null, selected: null, view: null, loading: true, busyFile: false,
    stateTitle: "", stateMessage: "", retryable: false, fileError: "",
    downloading: false, downloadError: "", fileAttempt: 0, infoAttempt: 0, timer: null,
  }),
  computed: {
    expiryLabel() {
      const end = expiry(this.info?.expiresAt);
      return Number.isFinite(end) ? new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium", timeStyle: "short",
      }).format(end) : "";
    },
  },
  created() {
    window.addEventListener("pageshow", this.onRestore);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.load();
  },
  beforeDestroy() {
    clearTimeout(this.timer);
    window.removeEventListener("pageshow", this.onRestore);
    document.removeEventListener("visibilitychange", this.onVisibility);
  },
  methods: {
    onRestore(event) { if (event.persisted) this.load(); },
    onVisibility() { if (!document.hidden && this.info) this.load(); },
    sizeLabel(size) {
      if (!Number.isFinite(size) || size <= 0) return "文件";
      if (size < 1024) return size + " B";
      if (size < 1048576) return Math.ceil(size / 1024) + " KB";
      return (size / 1048576).toFixed(1) + " MB";
    },
    hide(title, message, retryable = false) {
      clearTimeout(this.timer);
      this.infoAttempt++; this.fileAttempt++;
      this.info = this.selected = this.view = null;
      this.downloading = this.loading = this.busyFile = false;
      this.stateTitle = title; this.stateMessage = message; this.retryable = retryable;
      document.title = "客户资料 · 锐捷网络";
    },
    armExpiry(end) {
      clearTimeout(this.timer);
      if (!Number.isFinite(end)) return;
      const delta = end - Date.now();
      if (delta <= 0) this.hide("分享已到期", unavailable);
      else this.timer = setTimeout(() => this.armExpiry(end), Math.min(delta, 2147483647));
    },
    async load() {
      if (!validLink) { this.hide("分享链接不可用", unavailable); return; }
      const attempt = ++this.infoAttempt;
      this.loading = !this.info; this.retryable = false;
      try {
        const res = await fetch(linkPath + "?mode=info", requestOptions);
        if (attempt !== this.infoAttempt) return;
        if (isGone(res.status)) { this.hide("分享链接不可用", unavailable); return; }
        if (!res.ok) throw Error();
        const info = await res.json();
        if (attempt !== this.infoAttempt) return;
        if (!Array.isArray(info.files) || !info.files.length) {
          this.hide("暂无可查看的附件", unavailable); return;
        }
        const previousVersion = this.info?.version;
        this.info = info;
        this.armExpiry(expiry(info.expiresAt));
        if (!this.info) return;
        document.title = info.title + " · 锐捷网络";
        const selected = info.files.find(f => f.id === this.selected?.id);
        if (selected && previousVersion === info.version) this.selected = selected;
        else await this.selectFile(info.files[0], true);
      } catch {
        if (attempt === this.infoAttempt) this.hide("暂时无法读取资料", "请检查网络连接后重试。", true);
      } finally {
        if (attempt === this.infoAttempt) this.loading = false;
      }
    },
    async selectFile(file, force = false) {
      if (!force && this.selected?.id === file.id && (this.view || this.busyFile)) return;
      const attempt = ++this.fileAttempt;
      this.selected = file; this.view = null; this.busyFile = true;
      this.downloading = false; this.downloadError = this.fileError = "";
      try {
        const view = await readPreview(fileUrl(file, "preview"), file);
        if (attempt === this.fileAttempt) this.view = { ...view, title: file.name, fontBase: "/share-fonts/" };
      } catch {
        if (attempt === this.fileAttempt) this.fileError = "此附件暂不可预览。";
      } finally {
        if (attempt === this.fileAttempt) this.busyFile = false;
      }
    },
    async download() {
      const file = this.selected, attempt = this.fileAttempt;
      if (!file?.canDownload || this.downloading) return;
      this.downloading = true; this.downloadError = "";
      try {
        const res = await fetch(fileUrl(file, "download"), requestOptions);
        if (attempt !== this.fileAttempt) return;
        if (isGone(res.status)) {
          await this.load();
          if (this.selected?.id === file.id) this.downloadError = "当前无法下载此附件。";
          return;
        }
        if (!res.ok) throw Error();
        const blob = await res.blob();
        if (attempt !== this.fileAttempt || this.selected?.id !== file.id) return;
        const url = URL.createObjectURL(blob), anchor = document.createElement("a");
        anchor.href = url; anchor.download = file.name; anchor.rel = "noopener";
        document.body.append(anchor); anchor.click(); anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      } catch {
        if (attempt === this.fileAttempt) this.downloadError = "下载失败，请稍后重试。";
      } finally {
        if (attempt === this.fileAttempt) this.downloading = false;
      }
    },
  },
});
