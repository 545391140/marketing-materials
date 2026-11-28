import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { constants, zstdCompressSync } from "node:zlib";
const manifest = JSON.parse(await fs.readFile(".openai/hosting.json", "utf8"));
const adminManifest = JSON.parse(
  await fs.readFile("hosting/admin/.openai/hosting.json", "utf8")
);
const adminCheckout = manifest.project_id === adminManifest.project_id;
const customerId=JSON.parse(await fs.readFile("hosting/customer/.openai/hosting.json","utf8")).project_id;
const customerCheckout=manifest.project_id===customerId;
const target = process.argv[2] || (adminCheckout ? "admin" : customerCheckout ? "customer" : "all");
if (!["all", "portal", "admin","customer"].includes(target))
  throw Error("Expected portal or admin");
async function bundleApp(side) {
  const admin = side === "admin";
  const dir = admin && !adminCheckout ? "dist/admin" : "dist/server";
  await fs.mkdir(dir, { recursive: true });
  const built = await build({
    entryPoints: [admin ? "client/admin.js" : "client/app.js"],
    bundle: true,
    minify: true,
    write: false,
    platform: "browser",
    loader: { ".html": "text" },
    external: ["/pdf.min.mjs"],
    target: "es2020",
    alias: { vue: "vue/dist/vue.esm.js" },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const assets = {};
  function add(k, v, type) {
    const compressed = !type.startsWith("image/");
    const bytes = compressed ? zstdCompressSync(v, { params: { [constants.ZSTD_c_compressionLevel]: 19 } }) : Buffer.from(v);
    assets[k] = { data: bytes.toString("base64"), type, compressed };
  }
  add(
    admin ? "/admin.js" : "/app.js",
    built.outputFiles[0].contents,
    "application/javascript"
  );
  add("/style.css", (await fs.readFile("client/style.css", "utf8")) + "\n" + (await fs.readFile("client/preview.css", "utf8")), "text/css");
  for (const name of ["pdf.min.mjs", "pdf.worker.min.mjs"])
    add("/" + name, await fs.readFile("node_modules/pdfjs-dist/build/" + name), "application/javascript");
  let html = await fs.readFile("client/index.html", "utf8");
  if (admin) {
    html = html
      .replaceAll("伙伴资料中心", "资料管理端")
      .replaceAll("Partner Hub", "Content Studio")
      .replace("/app.js", "/admin.js");
    add(
      "/entry.js",
      await fs.readFile("client/admin-entry.js"),
      "application/javascript"
    );
  }
  add("/index.html", html, "text/html;charset=utf-8");
  for (const f of await fs.readdir("public/img"))
    if (f.endsWith(".webp"))
      add("/img/" + f, await fs.readFile("public/img/" + f), "image/webp");
  const virtual = admin
    ? "server/built-admin.json"
    : "server/built-assets.json";
  await fs.writeFile(virtual, JSON.stringify(assets));
  try {
    await build({
      entryPoints: [admin ? "server/admin-worker.js" : "server/worker.js"],
      outfile: dir + "/index.js",
      bundle: true,
      minify: true,
      format: "esm",
      target: "es2022",
      platform: "browser",
      conditions: ["workerd", "browser"],
      plugins: [
        {
          name: "offline-pdf-cmaps",
          setup(build) {
            build.onResolve({ filter: /^partner:pdf-cmaps$/ }, () => ({
              path: "maps",
              namespace: "pdf-maps",
            }));
            build.onLoad({ filter: /.*/, namespace: "pdf-maps" }, async () => {
              const index = {};
              const chunks = [];
              let offset = 0;
              for (const directory of ["cmaps", "standard_fonts"]) {
                const dir = path.join("node_modules/pdfjs-dist", directory);
                for (const name of (await fs.readdir(dir)).sort()) {
                  if (!/\.(bcmap|ttf|pfb)$/.test(name)) continue;
                  const bytes = await fs.readFile(path.join(dir, name));
                  index[name] = [offset, bytes.length];
                  chunks.push(bytes);
                  offset += bytes.length;
                }
              }
              const data = zstdCompressSync(Buffer.concat(chunks), {
                params: { [constants.ZSTD_c_compressionLevel]: 19 },
              }).toString("base64");
              return {
                loader: "json",
                contents: JSON.stringify({ index, data }),
              };
            });
          },
        },
      ],
      loader: { ".zst": "binary" },
      // Select the OOXML layout readers from the pinned engine. Spreadsheet,
      // legacy binary, encryption and export engines are outside this bundle.
      alias: {
        "partner:pptx-reader": path.resolve("node_modules/reamkit/dist/esm/pptx/pptx-reader.js"),
        "partner:office-options": path.resolve("node_modules/reamkit/dist/esm/core/converter/project.js")
      },
      external: ["node:*"],
      define: { "process.env.NODE_ENV": '"production"' },
    });
  } finally {
    await fs.rm(virtual, { force: true });
  }
  console.log("Built " + side + " into " + dir);
}
if (target === "all" || target === "portal") await bundleApp("portal");
if (target === "all" || target === "admin") await bundleApp("admin");

if(target==="all" || target==="customer") {
  const {bundleCustomer}=await import("./build-customer.mjs");
  await bundleCustomer(customerCheckout?"dist/server":"dist/customer");
}
