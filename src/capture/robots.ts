// RFC 9309: combine matching product groups; use * only if no product group matches.
// Compare unreserved percent escapes equivalently, retaining encoded reserved characters.
const normalize=(s:string)=>s.replace(/[^\x00-\x7f]/gu,c=>encodeURIComponent(c)).replace(/%[0-9a-f]{2}/gi,c=>{const decoded=String.fromCharCode(parseInt(c.slice(1),16));return /[a-z0-9._~-]/i.test(decoded)?decoded:c.toUpperCase();});
function matches(pattern:string,path:string){
 const anchored=pattern.endsWith('$'),parts=(anchored?pattern.slice(0,-1):pattern).split('*');
 if(!path.startsWith(parts[0]))return false;
 let end=parts[0].length;
 for(let i=1;i<parts.length;i++){
  const part=parts[i];
  if(anchored&&i===parts.length-1)return path.endsWith(part)&&path.length-part.length>=end;
  const at=path.indexOf(part,end);if(at<0)return false;end=at+part.length;
 }
 return !anchored||end===path.length;
}
export function robotsAllows(text:string,path:string){
 type Rule={path:string;allow:boolean};type Group={agents:string[];rules:Rule[]};
 const groups:Group[]=[];let group:Group|undefined,hasRules=false;
 for(const raw of text.replace(/^\uFEFF/,'').split(/\r?\n/)){
  const line=raw.split('#')[0].trim(),split=line.indexOf(':');if(split<0)continue;
  const key=line.slice(0,split).trim().toLowerCase(),value=line.slice(split+1).trim();
  if(key==='user-agent'){
   if(!group||hasRules){group={agents:[],rules:[]};groups.push(group);hasRules=false;}
   group.agents.push(value.toLowerCase());
  }else if(group&&['allow','disallow'].includes(key)){
   hasRules=true;if(value.startsWith('/'))group.rules.push({path:normalize(value),allow:key==='allow'});
  }
 }
 const specific=groups.filter(g=>g.agents.includes('kvaradonaresearch'));
 const rules=(specific.length?specific:groups.filter(g=>g.agents.includes('*'))).flatMap(g=>g.rules);
 const target=normalize(path),length=(r:Rule)=>Buffer.byteLength(r.path.replace(/\*/g,'').replace(/\$$/,''));
 const rule=rules.filter(r=>matches(r.path,target)).sort((a,b)=>length(b)-length(a)||Number(b.allow)-Number(a.allow))[0];
 return !rule||rule.allow;
}
