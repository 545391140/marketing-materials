import { readDocx, FontRegistry, layoutStyledDocument, writeSvg } from "reamkit";
import { readPptx } from "partner:pptx-reader";
import { flowRenderOptions } from "partner:office-options";
import { PDFDict, PDFDocument, PDFName, PDFStream } from "pdf-lib";
import { SaxesParser } from "saxes";
import { decompress } from "fzstd";
import { unzipSync } from "fflate";
import fontData from "./preview-assets/metrics.otf.zst";
import { need } from "./access.js";

let layoutFonts;
const pageLimit = 180;
const svgBudget = 32 * 1024 * 1024;
const encoder = new TextEncoder();
const tags = new Set(("g rect circle ellipse path polygon polyline line text tspan image defs use pattern clipPath " +
  "linearGradient radialGradient stop filter feGaussianBlur feOffset feMerge feMergeNode feColorMatrix").split(" "));
const attrs = new Set(("id x y x1 y1 x2 y2 cx cy r rx ry width height d points transform fill fill-opacity fill-rule stroke " +
  "stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-opacity opacity font-family font-size font-style " +
  "font-weight textLength lengthAdjust text-anchor xml:space clip-path clip-rule offset stop-color stop-opacity " +
  "gradientUnits gradientTransform spreadMethod patternUnits patternTransform preserveAspectRatio filter filterUnits " +
  "in in2 result stdDeviation dx dy type values").split(" "));
const escape = s => s.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]));

function checkOfficeArchive(bytes) {
  let total = 0, entries = 0;
  unzipSync(bytes, { filter(entry) {
    total += entry.originalSize;
    need(++entries <= 6000 && total <= 48 * 1024 * 1024, 422, "文档展开后过大，请分拆上传");
    return false;
  } });
}

// The converter emits a stack of page groups. Re-serialize only display primitives
// into standalone images. Clickable links, foreign documents and remote resources are discarded.
function officePages(input) {
  const parser = new SaxesParser(), pages = [], stack = [];
  let page, defs = "", depth = 0;
  function write(s) {
    if (page) page.body += s; else defs += s;
  }
  parser.on("doctype", () => { throw Error("Unsupported layout"); });
  parser.on("opentag", ({ name, attributes: a }) => {
    depth++;
    if (depth === 1) { stack.push(""); return; }
    if (depth === 2 && name === "g" && a["data-page"]) {
      need(pages.length < pageLimit, 422, "请分拆超过 180 页的资料");
      page = { width: 0, height: 0, body: "" };
      stack.push("page");
      return;
    }
    if (depth === 3 && page && !page.width && name === "rect") {
      page.width = Number(a.width);
      page.height = Number(a.height);
    }
    if (!tags.has(name)) { stack.push(""); return; }
    let attributes = "";
    for (const [key, value] of Object.entries(a)) {
      if (key === "href") {
        const localUse = name === "use" && /^#[\w.-]+$/.test(value);
        const image = name === "image" && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=]+$/i.test(value);
        if (!localUse && !image) continue;
      } else {
        if (!attrs.has(key)) continue;
        if (/(?:url|[:;\\])/i.test(value) && !/^url\(#[\w.-]+\)$/.test(value)) continue;
      }
      attributes += ' ' + key + '="' + escape(value) + '"';
    }
    write('<' + name + attributes + '>');
    stack.push(name);
  });
  parser.on("text", t => { if (["text", "tspan"].includes(stack.at(-1))) write(escape(t)); });
  parser.on("closetag", () => {
    const name = stack.pop();
    if (name === "page") {
      need(page.width > 0 && page.height > 0, 422, "页面尺寸无效");
      pages.push(encoder.encode('<svg xmlns="http://www.w3.org/2000/svg" width="' + page.width +
        '" height="' + page.height + '" viewBox="0 0 ' + page.width + ' ' + page.height + '">' + defs + page.body + '</svg>'));
      page = null;
    } else if (name) write('</' + name + '>');
    depth--;
  });
  parser.write(input).close();
  need(pages.length > 0, 422, "没有可预览的页面");
  return pages;
}

async function pdfPage(bytes, index) {
  const source = await PDFDocument.load(bytes, { updateMetadata: false });
  const count = source.getPageCount();
  need(count > 0 && count <= pageLimit, 422, "PDF 页数超出支持范围");
  if (!index) return { count, type: "pdf" };
  need(index <= count, 404, "页码无效");
  const original = source.getPage(index - 1), box = original.getCropBox(), rotation = original.getRotation();
  const leaf = original.node;
  const media = leaf.MediaBox(), resources = leaf.Resources();
  // pdf-lib copies indirect objects reachable from the page even when its
  // embedder never paints them. Detach every nonpainting page entry first.
  for (const key of leaf.keys()) {
    if (!["Type", "Contents"].includes(key.decodeText())) leaf.delete(key);
  }
  leaf.set(PDFName.MediaBox, media);
  if (resources) {
    const paintResources = source.context.obj({});
    for (const category of ["ExtGState", "ColorSpace", "Pattern", "Shading", "XObject", "Font", "ProcSet", "Properties"]) {
      const key = PDFName.of(category), entry = resources.get(key);
      if (entry) paintResources.set(key, entry);
    }
    leaf.set(PDFName.Resources, paintResources);
  }
  const excluded = ["Metadata", "PieceInfo", "LastModified", "AF", "FS", "EF", "RF", "AA", "OpenAction", "JS", "JavaScript", "EmbeddedFiles", "OPI", "Ref", "Thumb", "Annots"];
  for (const [, value] of source.context.enumerateIndirectObjects()) {
    const dict = value instanceof PDFStream ? value.dict : value instanceof PDFDict ? value : null;
    if (dict) for (const key of excluded) dict.delete(PDFName.of(key));
  }
  const document = await PDFDocument.create({ updateMetadata: false });
  const page = document.addPage([box.width, box.height]);
  // Copy only page drawing commands/resources into a fresh document. The original
  // catalog, annotations, embedded attachments and form fields are never delivered.
  if (original.node.Contents()) {
    const embedded = await document.embedPage(original, {
      left: box.x, bottom: box.y, right: box.x + box.width, top: box.y + box.height,
    });
    page.drawPage(embedded, { x: 0, y: 0 });
  }
  page.setRotation(rotation);
  return { data: await document.save(), mime: "application/pdf" };
}

export async function layoutPreview(bucket, cache, file, readOriginal, pageParameter) {
  const index = pageParameter == null ? 0 : Number(pageParameter);
  need(pageParameter == null || (Number.isInteger(index) && index > 0 && index <= pageLimit), 404, "页码无效");
  const key = cache + "/layout-v1/";
  const manifest = await bucket.get(key + "manifest");
  let meta = manifest && JSON.parse(await manifest.text());
  const requestPage = async () => {
    if (!index) return meta;
    need(index <= meta.count, 404, "页码无效");
    const asset = await bucket.get(key + index);
    return asset ? { data: asset.body, mime: meta.type === "pdf" ? "application/pdf" : "image/svg+xml" } : null;
  };
  if (meta) {
    const result = await requestPage();
    if (result) return result;
  }
  const bytes = await readOriginal();
  if (file.ext === "pdf") {
    if (!meta) {
      meta = await pdfPage(bytes, 0);
      await bucket.put(key + "manifest", JSON.stringify(meta));
    }
    if (!index) return meta;
    const result = await pdfPage(bytes, index);
    await bucket.put(key + index, result.data);
    return result;
  }
  need(["pptx","docx"].includes(file.ext), 415, "此格式没有分页预览");
  checkOfficeArchive(bytes);
  const { doc } = file.ext === "pptx" ? readPptx(bytes) : readDocx(bytes);
  layoutFonts ??= FontRegistry.fromBytes({regular: decompress(fontData)});
  const laid = layoutStyledDocument(doc.body, { registry: layoutFonts, ...flowRenderOptions(doc) });
  need(laid.pages.length > 0 && laid.pages.length <= pageLimit, 422, "请分拆超过 180 页的资料");
  meta = { count: laid.pages.length, type: "svg" };
  need(!index || index <= meta.count, 404, "页码无效");
  const pageNo = index || 1;
  const svg = writeSvg({ ...laid, pages: [laid.pages[pageNo - 1]] }).bytes;
  need(svg.length <= svgBudget, 422, "排版预览过大，请分拆文档");
  const [pageBytes] = officePages(new TextDecoder().decode(svg));
  await bucket.put(key + pageNo, pageBytes);
  if (!manifest) await bucket.put(key + "manifest", JSON.stringify(meta));
  return index ? {data: pageBytes, mime: "image/svg+xml"} : meta;
}
