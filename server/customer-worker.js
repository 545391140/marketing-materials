import assets from "./built-customer.json";
import {serveAsset} from "./ui-assets.js";

const linkPath=/^\/s\/[A-Za-z0-9_-]{43}$/;
const fontPath=/^\/share-fonts\/[\w.-]{1,120}$/;
const staticPaths=new Set(["/customer.js","/customer.css","/pdf.min.mjs","/pdf.worker.min.mjs"]);
const missing=()=>new Response("请通过完整的客户分享链接访问资料。",{status:404,headers:{"cache-control":"no-store"}});
export default {
  async fetch(req,env) {
    if(req.method!=="GET") return new Response(null,{status:405});
    const url=new URL(req.url);
    let response;
    if(url.pathname==="/") {
      response=new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>锐捷客户资料</title><link rel="stylesheet" href="/customer.css"><main style="max-width:42rem;margin:18vh auto;padding:2rem;font-family:system-ui"><strong>Ruijie</strong><h1>客户资料分享</h1><p>请打开销售或伙伴发给你的完整分享链接，查看本次交付的附件。</p></main></html>',{headers:{"content-type":"text/html;charset=utf-8"}});
    } else if(staticPaths.has(url.pathname)) response=serveAsset(assets,url.pathname);
    else if(linkPath.test(url.pathname) && !url.search) {
      response=serveAsset(assets,"/index.html");
      response.headers.set("content-security-policy","default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    } else if(linkPath.test(url.pathname) || fontPath.test(url.pathname)) {
      // Build a new request. Customer cookies, authorization and routing headers never reach the portal.
      const upstream=new URL(env.PORTAL_ORIGIN);
      upstream.pathname=url.pathname;
      for(const key of ["mode","f","page"]) if(url.searchParams.has(key)) upstream.searchParams.set(key,url.searchParams.get(key));
      const headers=new Headers();
      if(env.PORTAL_SERVICE_TOKEN) headers.set("OAI-Sites-Authorization","Bearer "+env.PORTAL_SERVICE_TOKEN);
      const query=new Request(upstream,{headers,redirect:"manual"});
      const result=env.LOCAL_API?await env.LOCAL_API.fetch(query):await fetch(query);
      if(result.status>=300 && result.status<400) return missing();
      const filtered=new Headers();
      for(const name of ["content-type","content-security-policy","content-disposition"])
        if(result.headers.has(name)) filtered.set(name,result.headers.get(name));
      response=new Response(result.body,{status:result.status,headers:filtered});
    } else return missing();
    response.headers.set("cache-control","private,no-store");
    response.headers.set("referrer-policy","no-referrer");
    response.headers.set("x-content-type-options","nosniff");
    response.headers.set("x-robots-tag","noindex, nofollow, noarchive");
    return response;
  }
};
