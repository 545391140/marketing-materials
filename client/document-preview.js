import Vue from "vue";

const imageTypes = ["png", "jpeg", "jpg"];
export async function readPreview(url, f) {
  if (imageTypes.includes(f.ext)) return { img: url };
  const data = async path => {
    const r = await fetch(path);
    const response = await r.json();
    if (!r.ok) throw Error(response.error || "无法读取预览");
    return response;
  };
  if (["docx", "pptx", "pdf"].includes(f.ext)) {
    const layoutUrl = new URL(url, window.location.origin);
    layoutUrl.searchParams.set("mode", "layout");
    try {
      const layout = await data(layoutUrl);
      return { layout: { ...layout, url: layoutUrl.href } };
    } catch (e) {
      const fallback = await data(url);
      return { text: fallback.text, warning: e.message + "，以下为可提取的文字。" };
    }
  }
  return { text: (await data(url)).text };
}

Vue.component("document-preview", {
  props: ["view"],
  data() { return { page: 1, zoom: 100, painting: false, pdfError: "", paintId: 0 }; },
  computed: {
    count() { return this.view.layout?.count || 1; },
    pdf() { return this.view.layout?.type === "pdf"; },
    src() {
      if (this.view.img) return this.view.img;
      if (!this.view.layout) return "";
      return this.view.layout.url + "&page=" + this.page;
    },
  },
  watch: {
    src: { immediate: true, handler() { this.paint(); } },
  },
  beforeDestroy() { this.paintId++; },
  methods: {
    async paint() {
      const id = ++this.paintId;
      this.pdfError = "";
      if (!this.pdf || !this.src) return;
      this.painting = true;
      let loadingTask;
      try {
        const lib = await import("/pdf.min.mjs");
        lib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        // Only the reconstructed single-page PDF is exposed to the renderer.
        const fontBase = this.view.fontBase || new URL("./preview-fonts/",this.view.layout.url).href;
        loadingTask = lib.getDocument({ url: this.src, isEvalSupported: false,
          useWasm: false, cMapUrl: fontBase, cMapPacked: true,
          standardFontDataUrl: fontBase });
        const document = await loadingTask.promise;
        const page = await document.getPage(1), original = page.getViewport({scale: 1});
        const viewport = page.getViewport({scale: Math.min(2.5, 2200 / Math.max(original.width, original.height))});
        const bitmap = window.document.createElement("canvas");
        bitmap.width = Math.ceil(viewport.width); bitmap.height = Math.ceil(viewport.height);
        await page.render({canvas: bitmap, canvasContext: bitmap.getContext("2d"), viewport}).promise;
        if (id !== this.paintId) return;
        await this.$nextTick();
        const canvas = this.$refs.canvas;
        if (!canvas) return;
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
      } catch {
        if (id === this.paintId) this.pdfError = "此浏览器无法绘制当前 PDF 页面。";
      } finally {
        await loadingTask?.destroy();
        if (id === this.paintId) this.painting = false;
      }
    },
    reset(next) { this.page = next; this.$refs.scroller?.scrollTo(0, 0); },
  },
  template: `<div class="document-preview"><div v-if="view.img || view.layout">
    <div class="preview-tools" aria-label="预览控制">
      <template v-if="view.layout"><button type="button" :disabled="page===1" @click="reset(page-1)" aria-label="上一页">‹</button>
      <span aria-live="polite">第 {{page}} / {{count}} 页</span><button type="button" :disabled="page===count" @click="reset(page+1)" aria-label="下一页">›</button></template>
      <button type="button" :disabled="zoom<=50" @click="zoom-=25" aria-label="缩小">−</button>
      <button type="button" @click="zoom=100" title="适应宽度">{{zoom}}%</button>
      <button type="button" :disabled="zoom>=300" @click="zoom+=25" aria-label="放大">＋</button>
    </div><p v-if="painting" role="status">正在绘制页面…</p><p v-if="pdfError" role="alert">{{pdfError}} <a :href="src" target="_blank" rel="noopener">打开此页预览</a></p>
    <div class="preview-paper" ref="scroller"><div :style="{width:zoom+'%'}">
      <canvas v-if="pdf" v-show="!painting && !pdfError" ref="canvas" :aria-label="view.title+' 第 '+page+' 页'"></canvas>
      <img v-else class="preview-img" :src="src" :alt="view.title" @error="pdfError='页面暂不可用'">
    </div></div>
  </div><template v-else><p v-if="view.warning" role="status">{{view.warning}}</p><pre v-if="view.text" class="preview-text">{{view.text}}</pre></template></div>`,
});
