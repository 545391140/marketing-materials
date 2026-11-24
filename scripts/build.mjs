import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
await fs.rm("dist", { recursive: true, force: true });
await fs.mkdir("dist/server", { recursive: true });
await fs.mkdir("dist/.openai", { recursive: true });
await fs.copyFile(".openai/hosting.json", "dist/.openai/hosting.json");
const front = await build({
  entryPoints: ["client/app.js"],
  bundle: true,
  minify: true,
  write: false,
  platform: "browser",
  loader: { ".html": "text" },
  target: "es2020",
  alias: { vue: "vue/dist/vue.esm.js" },
  define: { "process.env.NODE_ENV": '"production"' },
});
const assets = {};
function add(k, v, type) {
  assets[k] = { data: Buffer.from(v).toString("base64"), type };
}
add("/app.js", front.outputFiles[0].contents, "application/javascript");
add("/style.css", await fs.readFile("client/style.css"), "text/css");
add(
  "/index.html",
  await fs.readFile("client/index.html"),
  "text/html;charset=utf-8",
);
for (const f of await fs.readdir("public/img"))
  if (f.endsWith(".webp"))
    add("/img/" + f, await fs.readFile("public/img/" + f), "image/webp");
await fs.writeFile("server/built-assets.json", JSON.stringify(assets));
try {
  await build({
    entryPoints: ["server/worker.js"],
    outfile: "dist/server/index.js",
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
            const dir = "node_modules/pdfjs-dist/cmaps";
            const maps = {};
            for (const name of await fs.readdir(dir)) {
              if (name.endsWith(".bcmap"))
                maps[name] = (await fs.readFile(path.join(dir, name))).toString(
                  "base64",
                );
            }
            const fonts = "node_modules/pdfjs-dist/standard_fonts";
            for (const name of await fs.readdir(fonts))
              if (/\.(ttf|pfb)$/.test(name))
                maps[name] = (
                  await fs.readFile(path.join(fonts, name))
                ).toString("base64");
            return { loader: "json", contents: JSON.stringify(maps) };
          });
        },
      },
    ],
    external: ["node:*"],
    define: { "process.env.NODE_ENV": '"production"' },
  });
} finally {
  await fs.rm("server/built-assets.json", { force: true });
}
console.log("Built partner hub and authenticated application API");
