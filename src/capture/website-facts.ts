import type {WebsiteFact} from '../contracts/website';

/** Keep page metadata and sample every viewport/category before taking more of one kind. */
export function selectWebsiteFacts(facts:WebsiteFact[],maxBytes=14000,maxCount=80){
 const groups=new Map<string,WebsiteFact[]>();
 for(const fact of facts.filter(f=>f.viewport!=='page')){
  const key=`${fact.viewport}:${fact.category}`,group=groups.get(key)??[];
  group.push(fact);groups.set(key,group);
 }
 const ordered=facts.filter(f=>f.viewport==='page');
 while([...groups.values()].some(group=>group.length))for(const group of groups.values()){
  const fact=group.shift();if(fact)ordered.push(fact);
 }
 const selected:WebsiteFact[]=[];let bytes=2;
 for(const fact of ordered){
  const size=Buffer.byteLength(JSON.stringify(fact))+(selected.length?1:0);
  if(selected.length>=maxCount||bytes+size>maxBytes)continue;
  selected.push(fact);bytes+=size;
 }
 return {facts:selected,omitted:facts.length-selected.length};
}
