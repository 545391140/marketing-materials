import {build} from "esbuild";
import fs from "node:fs/promises";
import {buildCustomerBundle} from "../client/customer.build.mjs";
export async function bundleCustomer(dir) {
  const assets={};
  function add(path,source,type) {
    // Keep the uncompressed static resources in the separate customer Worker.
    assets[path]={data:Buffer.from(source).toString("base64"),compressed:false,type};
  }
  add("/index.html",await fs.readFile("client/customer.html"),"text/html;charset=utf-8");
  add("/customer.css",(await fs.readFile("client/preview.css","utf8"))+"\n"+await fs.readFile("client/customer.css","utf8"),"text/css;charset=utf-8");
  add("/customer.js",await buildCustomerBundle(),"application/javascript");
  for(const file of ["pdf.min.mjs","pdf.worker.min.mjs"]) add("/"+file,await fs.readFile("node_modules/pdfjs-dist/build/"+file),"application/javascript");
  await fs.mkdir(dir,{recursive:true});
  await build({
    entryPoints:["server/customer-worker.js"],outfile:dir+"/index.js",bundle:true,format:"esm",minify:true,
    plugins:[{name:"customer-assets",setup(b){
      b.onResolve({filter:/built-customer\.json$/},()=>({path:"assets",namespace:"customer"}));
      b.onLoad({filter:/.*/,namespace:"customer"},()=>({loader:"json",contents:JSON.stringify(assets)}));
    }}],
  });
}
