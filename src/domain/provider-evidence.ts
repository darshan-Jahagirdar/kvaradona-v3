import {z} from 'zod';
import {ProviderObservation,type Packet} from '../contracts/pipeline';
import {hash,hostOf} from './policy';
export type SavedOperation={id:string;provider:string;state:string;response:unknown;created_at:string;opportunity_id?:string|null;operation_key?:string;request_hash?:string;actual_usd?:string|number|null};
const object=(x:unknown):Record<string,unknown>=>x&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,unknown>:{};
const uuid=(s:string)=>{const h=hash(s);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
/** Normalize only validated saved response fields. No invented URL quotations or paid refresh. */
export function savedProviderObservations(p:Packet,operations:SavedOperation[]):z.infer<typeof ProviderObservation>[]{
 const c=p.candidate?.providerCompany;if(!c?.domain)return [];
 const out:z.infer<typeof ProviderObservation>[]=[];
 for(const op of operations){
  if(!Number.isFinite(Date.parse(op.created_at)))continue;
  if(op.state!=='succeeded'||op.provider!==c.provider||!z.string().uuid().safeParse(op.id).success)continue;
  const response=object(op.response);if(response.httpStatus!==200)continue;
  const body=object(response.body),rows=Array.isArray(body.data)?body.data:Array.isArray(body.organizations)?body.organizations:[];
  const add=(field:z.infer<typeof ProviderObservation>['field'],value:unknown,path:string,date:string|null=null,topic?:string)=>{
   if(typeof value!=='string'&&typeof value!=='number')return;
   if(field==='employees'&&(typeof value!=='number'||!Number.isInteger(value)||value<0))return;
   if(field==='employeeRange'&&!/^\d+-\d+$/.test(String(value)))return;
   const statement=topic?`${c.provider} reported ${topic} score ${value}${date?` for ${date}`:' (source date unknown)'} for ${c.name}.`:`${c.provider} reported ${field} ${value} for ${c.name} (observed ${op.created_at.slice(0,10)}).`;
   const parsed=ProviderObservation.safeParse({id:uuid(op.id+path),provider:c.provider,companyId:c.id,companyHost:c.domain,field,value,topic,sourceDate:date,observedAt:new Date(op.created_at).toISOString(),operationId:op.id,responseHash:hash(op.response),fieldPath:path,statement});if(parsed.success)out.push(parsed.data);
  };
  rows.forEach((raw,i)=>{
   const r=object(raw);if(String(r.business_id??r.id)!==c.id)return;
   const detail=object(r.data);let domain:string|null=null;
   try{const d=r.domain??r.primary_domain??detail.company_website;if(typeof d==='string')domain=hostOf(d.includes('://')?d:'https://'+d);}catch{}
   if(domain!==c.domain)return;
   const base=`body.${Array.isArray(body.data)?'data':'organizations'}[${i}]`;
   for(const [field,key] of [['companyName','name'],['employees','estimated_num_employees'],['employeeRange','number_of_employees_range'],['country','country_name'],['country','country'],['industry','naics_description'],['industry','industry']] as const)add(field,r[key],base+'.'+key);
   const topics=Array.isArray(r.business_intent_topics)?r.business_intent_topics:[];
   topics.forEach((t,j)=>{const v=object(t);if(typeof v.topic==='string'&&typeof v.score==='number'&&v.score>=0&&v.score<=100)add('intent',v.score,base+`.business_intent_topics[${j}].score`,null,v.topic);});
   if(typeof detail.intent_topics==='string'&&typeof detail.date_stamp==='string'){
    const date=detail.date_stamp.replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)return;
    try{const ts=JSON.parse(detail.intent_topics);if(Array.isArray(ts))ts.forEach((t,j)=>{const v=object(t);if(typeof v.topic==='string'&&typeof v.composite_score==='number'&&v.composite_score>=0&&v.composite_score<=100)add('intent',v.composite_score,base+`.data.intent_topics[${j}].composite_score`,date,v.topic);});}catch{}
   }
  });
 }
 return [...new Map(out.map(o=>[o.id,o])).values()].slice(-80);
}
export function attachProviderObservations(p:Packet,operations:SavedOperation[]){p.providerObservations=[...new Map([...(p.providerObservations??[]),...savedProviderObservations(p,operations)].map(o=>[o.id,o])).values()].slice(-80);}
