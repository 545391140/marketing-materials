import { has } from "../shared/permissions.js";
import { shareable, downloadableToCustomer, need, uid, visible } from "./access.js";
import { recipient, update } from "./db.js";
import { effective } from "./roles.js";

export const shareRoute = /^\/s\/([A-Za-z0-9_-]{43})$/;
export const slotId = f => f.shareSlot || f.id;
const versionKey = (id,version) => id + "@" + version;
const isOpen = link => !link.revoked && Date.parse(link.expiresAt) > Date.now();

function available(s,link,u) {
  if (!has(u,"personal") || !isOpen(link)) return [];
  const live=s.materials.find(m=>m.id===link.mid);
  const pinned=s.shareVersions?.[versionKey(link.mid,link.version)];
  if(!live || !pinned || !visible(live,u,s.materials) || !visible(pinned,u,s.materials)) return [];
  return pinned.files.filter(f=>link.files.includes(f.id) && !(link.blocked||[]).includes(f.id) && shareable(f,u)).flatMap(f=>{
    const current=live.files.find(x=>slotId(x)===slotId(f));
    if(!current || !shareable(current,u)) return [];
    return [{file:f,canDownload:link.downloads.includes(f.id) && downloadableToCustomer(f,u) && downloadableToCustomer(current,u)}];
  });
}
export function myShares(s,u,origin) {
  return (s.customerShares||[]).filter(x=>x.owner===u.id).map(link=>{
    const files=available(s,link,u);
    const status=link.revoked ? "已关闭" : Date.parse(link.expiresAt)<=Date.now() ? "已到期" :
      !files.length ? "不可用" : files.length<link.files.length ? "部分可用" : "有效";
    return {id:link.id,mid:link.mid,title:link.title,version:link.version,created:link.created,expiresAt:link.expiresAt,
      count:link.files.length,status,latest:s.materials.find(x=>x.id===link.mid)?.version,
      path:files.length ? (origin||"")+"/s/"+link.token : null};
  });
}
export async function createLink(env,ctx,scoped,input) {
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  const token=btoa(String.fromCharCode(...bytes)).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"");
  const id=uid();
  await update(env,ctx.ns,async s=>{
    const u=scoped(s).u, m=s.materials.find(x=>x.id===input.mid);
    need(has(u,"personal") && m && visible(m,u,s.materials),403,"没有分享权限");
    need(m.version===input.version,409,"资料已换版，请重新选择附件");
    const files=input.files,downloads=input.downloads??[];
    need(Array.isArray(files) && files.length>0 && files.length<=m.files.length && new Set(files).size===files.length &&
      Array.isArray(downloads) && downloads.every(fid=>files.includes(fid)) && [1,7,30].includes(input.days),400,"请选择附件和有效期");
    for(const fid of files){
      const f=m.files.find(x=>x.id===fid);
      need(f && shareable(f,u),403,"包含无法对外分享的附件");
      need(!downloads.includes(fid) || downloadableToCustomer(f,u),403,"不能扩大客户下载权限");
    }
    const now=Date.now(), expiresAt=new Date(now+input.days*86400000).toISOString();
    const versions=s.shareVersions ||= {};
    const key=versionKey(m.id,m.version);
    versions[key] ??= {id:m.id,title:m.title,bg:m.bg,published:true,version:m.version,expires:m.expires,
      proofId:m.proofId,proofVersion:m.proofVersion,files:m.files.filter(f=>f.customerShare && f.usage==="可发客户")};
    const link={id,token,mid:m.id,title:m.title,owner:u.id,version:m.version,files,downloads,
      created:new Date(now).toISOString(),expiresAt};
    (s.customerShares ||= []).unshift(link);
    s.audit.unshift({id,materialId:m.id,bg:m.bg,version:m.version,name:u.name,actorId:u.actorId || u.id,companyId:u.companyId,action:"创建客户分享",date:link.created});
    // The index alone cannot open a link. The committed workspace record is also required.
    await env.BUCKET.put("share-index/"+token,ctx.ns);
  });
  return {id};
}
export function closeLink(s,u,id){
  const link=s.customerShares?.find(x=>x.id===id && x.owner===u.id);
  need(link,404,"未找到分享记录");
  if(link.revoked) return;
  link.revoked=new Date().toISOString();
  const m=s.materials.find(x=>x.id===link.mid);
  s.audit.unshift({id,materialId:link.mid,bg:m?.bg,version:link.version,name:u.name,actorId:u.actorId || u.id,companyId:u.companyId,action:"关闭客户分享",date:link.revoked});
}
export function updateSharedVersions(s,m) {
  const notified=new Set();
  for(const link of s.customerShares||[]) {
    if(link.mid!==m.id || !isOpen(link)) continue;
    if(!m.published){link.revoked=new Date().toISOString();continue;}
    const pinned=s.shareVersions[versionKey(m.id,link.version)];
    const disabled=pinned.files.filter(f=>link.files.includes(f.id) &&
      !m.files.some(x=>slotId(x)===slotId(f) && x.usage==="可发客户" && x.customerShare));
    link.blocked=[...new Set([...(link.blocked||[]),...disabled.map(f=>f.id)])];
    if(notified.has(link.owner)) continue;
    notified.add(link.owner);
    s.notices.unshift({key:uid(),to:link.owner,mid:m.id,read:false,date:new Date().toISOString().slice(0,10),
      msg:"《"+m.title+"》已发布 v"+m.version+"，已有客户链接仍固定在原版本。请在「我的分享」核对。"});
  }
}
export async function customerFiles(s,token,ns,env) {
  const link=s.customerShares?.find(x=>x.token===token);
  need(link && isOpen(link),404,"分享已失效或不可用");
  const ctx={demo:!env.OA_SESSION_URL && !env.PC_SESSION_URL,u:{id:""}};
  need(ctx.demo ? ns!=="portal" : ns==="portal",404,"分享不可用");
  const user=await recipient(ctx,env,link.owner);
  const files=available(s,link,effective(s,user,ctx,env));
  need(files.length,404,"分享已失效或不可用");
  return {link,files};
}
