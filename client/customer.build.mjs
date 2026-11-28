import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { compileTemplate } from "@vue/compiler-sfc";
import { parse } from "@babel/parser";

// Compile both public-page templates at build time so the unauthenticated Site
// needs neither an unsafe-eval CSP exemption nor a second copy of the viewer.
function compile(source, filename) {
  const result = compileTemplate({ source, filename, isProd: true });
  if (result.errors.length) throw Error(filename + ": " + result.errors.join(", "));
  return result.code;
}
export async function buildCustomerBundle() {
  const result = await build({
    entryPoints:["client/customer.js"], bundle:true, write:false, minify:true,
    platform:"browser", target:"es2020", alias:{ vue:"vue/dist/vue.runtime.esm.js" },
    external:["/pdf.min.mjs"], define:{ "process.env.NODE_ENV":'"production"' },
    plugins: [{
      name:"public-templates",
      setup(builder) {
        builder.onResolve({filter:/^customer:page$/}, () => ({path:"page", namespace:"customer"}));
        builder.onLoad({filter:/^page$/, namespace:"customer"}, async () => {
          const source = await fs.readFile("client/customer.view.html","utf8");
          return {contents:compile(source,"customer.view.html") + "\nexport {render,staticRenderFns};"};
        });
        builder.onLoad({filter:/[/\\]document-preview\.js$/}, async ({path: filename}) => {
          const source = await fs.readFile(filename,"utf8");
          const ast = parse(source,{sourceType:"module"});
          const def = ast.program.body.find(n=>n.expression?.arguments?.[0]?.value === "document-preview");
          const prop = def?.expression.arguments[1].properties.find(p=>p.key?.name === "template");
          const literal = prop?.value;
          if(literal?.type !== "TemplateLiteral" || literal.expressions.length)
            throw Error("The shared preview template must be a static template literal");
          const compiled = compile(literal.quasis[0].value.cooked,filename);
          return {contents:compiled + "\n" + source.slice(0,prop.start) + "render, staticRenderFns" + source.slice(prop.end),resolveDir:path.dirname(filename)};
        });
      }
    }]
  });
  return result.outputFiles[0].contents;
}
