import { decompress } from "fzstd";
import cmaps from "partner:pdf-cmaps";
import { unzipSync, strFromU8 } from "fflate";
import { need } from "./access.js";
import jpeg from "jpeg-js";
import { decode, encode } from "fast-png";
import { extractText, getDocumentProxy } from "unpdf";
let pdfResources;
function readPdfResource(filename) {
  pdfResources ??= decompress(
    Uint8Array.from(atob(cmaps.data), (c) => c.charCodeAt(0)),
  );
  const [offset, length] = cmaps.index[filename];
  return pdfResources.slice(offset, offset + length);
}
export const mimes = {
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain;charset=UTF-8",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};
export async function inspect(bytes, ext) {
  need(
    bytes.length > 0 && bytes.length <= 8 * 1024 * 1024,
    413,
    "附件须小于 8 MB",
  );
  need(mimes[ext], 415, "支持 PDF、DOCX、PPTX、TXT、JPG、PNG");
  if (ext === "txt") {
    const t = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    need(!t.includes("\0"), 422, "文件格式不符");
    return { text: t.slice(0, 70000) };
  }
  if (ext === "jpeg" || ext === "jpg") {
    need(bytes[0] === 255 && bytes[1] === 216, 422, "无效图片");
    const img = jpeg.decode(bytes, {
      useTArray: true,
      maxResolutionInMP: 12,
      maxMemoryUsageInMB: 96,
    });
    return { image: jpeg.encode(img, 72).data, mime: "image/jpeg" };
  }
  if (ext === "png") {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    need(
      v.getUint32(0) === 0x89504e47 &&
        v.getUint32(16) * v.getUint32(20) <= 12000000,
      422,
      "图片无效或尺寸过大",
    );
    const img = decode(bytes);
    return {
      image: encode({
        width: img.width,
        height: img.height,
        data: img.data,
        channels: img.channels,
        depth: img.depth,
      }),
      mime: "image/png",
    };
  }
  if (ext === "pdf") {
    need(
      new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-",
      422,
      "无效 PDF",
    );
    const pdf = await getDocumentProxy(bytes.slice(), {
      useWorkerFetch: false,
      cMapPacked: true,
      BinaryDataFactory: class {
        async fetch({ kind, filename }) {
          if (
            !["cMapUrl", "standardFontDataUrl"].includes(kind) ||
            !Object.hasOwn(cmaps.index, filename)
          )
            throw Error("Unsupported PDF resource");
          return readPdfResource(filename);
        }
      },
    });
    try {
      need(pdf.numPages <= 180, 422, "请分拆超过 180 页的资料");
      const { text } = await extractText(pdf);
      const t = text
        .map((p, i) => "— " + (i + 1) + " —\n" + p)
        .join("\n\n")
        .slice(0, 70000);
      need(
        text.join("").trim().length,
        422,
        "此文件没有可提取的文字，请上传文字版 PDF 或图片",
      );
      return { text: t };
    } finally {
      await pdf.cleanup?.();
    }
  }
  let total = 0;
  const docs = unzipSync(bytes, {
    filter: (e) => {
      need(
        !/vbaProject|embeddings\/|activeX/i.test(e.name),
        422,
        "请移除嵌入对象或宏",
      );
      if (!/^(word\/document|ppt\/slides\/slide\d+)\.xml$/.test(e.name))
        return false;
      total += e.originalSize;
      need(total <= 3e6, 422, "文档过大");
      return true;
    },
  });
  const names = Object.keys(docs)
    .filter((n) =>
      ext === "docx" ? n.startsWith("word/") : n.startsWith("ppt/"),
    )
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  need(names.length, 422, "文档扩展名与内容不符");
  const text = names
    .map((n) =>
      strFromU8(docs[n])
        .replace(/<\/(?:w:p|a:p)>/g, "\n")
        .replace(/<[^>]+>/g, "")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&"),
    )
    .join("\n")
    .slice(0, 70000);
  need(text.trim(), 422, "请提供包含文字的文档或图片");
  return { text };
}
