/** Only the observed guest CMS read operations qualify; arbitrary POSTs stay blocked. */
export function publicContentBody(url:string,origin:string,method:string,body:string|null){
 if(method!=='POST'||!body||body.length>4096)return undefined;
 const u=new URL(url);if(u.origin!==origin||u.pathname!=='/webruntime/api/apex/execute'||u.searchParams.get('asGuest')!=='true')return undefined;
 try{
  const p=JSON.parse(body);if(p.namespace!==''||!/^@udd\/[a-zA-Z0-9]{15,18}$/.test(p.classname)||p.isContinuation!==false||p.cacheable!==false)return undefined;
  if(Object.keys(p).some(k=>!['namespace','classname','method','isContinuation','params','cacheable'].includes(k)))return undefined;
  const fields=p.method==='getFromOrgCache'?['cacheKey']:p.method==='getContentfulData'?['lang','contentType','filterField','filterValue']:null;
  if(!fields||!p.params||Object.keys(p.params).length!==fields.length||fields.some(k=>typeof p.params[k]!=='string'||p.params[k].length>128))return undefined;
  return body;
 }catch{return undefined;}
}
