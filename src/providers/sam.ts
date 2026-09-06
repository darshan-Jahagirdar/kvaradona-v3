import {z} from 'zod';
import {required} from '../config/env';
import {hash} from '../domain/policy';
import type {OperationGateway} from '../usage/operations';
export const SamQuery=z.object({title:z.string().trim().min(2).max(120),postedFrom:z.string(),postedTo:z.string(),limit:z.literal(3),offset:z.literal(0)});
export const SamSaved=z.object({status:z.number(),body:z.unknown(),observedAt:z.string().datetime()});
const text=z.string().nullish();
const Notice=z.object({noticeId:z.string().min(1).max(100),title:z.string(),solicitationNumber:text,fullParentPathName:text,fullParentPathCode:text,postedDate:text,type:text,baseType:text,active:text,responseDeadLine:text,reponseDeadLine:text,archiveDate:text,setAside:text,setAsideCode:text,typeOfSetAside:text,typeOfSetAsideDescription:text,naicsCode:text,description:text,uiLink:text,resourceLinks:z.array(z.string()).nullish(),award:z.unknown().optional()});
import {ProcurementNotice} from '../contracts/procurement';
export {ProcurementNotice} from '../contracts/procurement';
export function samQuery(title:string,days=30,now=new Date()){
 z.number().int().min(1).max(90).parse(days);
 const format=(d:Date)=>`${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')}/${d.getUTCFullYear()}`;
 return SamQuery.parse({title,postedFrom:format(new Date(now.getTime()-days*86400000)),postedTo:format(now),limit:3,offset:0});
}
function cleanUrl(value:string|null|undefined){try{const u=new URL(value??'');if(u.protocol!=='https:'||u.username||u.password||u.port)return null;for(const key of [...u.searchParams.keys()])if(/key|token|signature/i.test(key))u.searchParams.delete(key);return u.href;}catch{return null;}}
export function normalizeSam(input:unknown,observedAt:string){
 const body=z.object({opportunitiesData:z.array(Notice).max(3),totalRecords:z.number().optional()}).parse(input);
 return body.opportunitiesData.map(n=>{
  const deadlineRaw=n.responseDeadLine??n.reponseDeadLine??null;
  // SAM dates without an explicit offset remain ambiguous; never assume the laptop timezone.
  const utc=deadlineRaw&&/(Z|[+-]\d{2}:?\d{2})$/i.test(deadlineRaw)&&Number.isFinite(Date.parse(deadlineRaw))?new Date(deadlineRaw).toISOString():null;
  const descriptionUrl=cleanUrl(n.description),url=cleanUrl(n.uiLink);
  const facts={noticeId:n.noticeId,solicitationNumber:n.solicitationNumber??null,buyer:n.fullParentPathName??null,buyerCode:n.fullParentPathCode??null,title:n.title,url:url&&new URL(url).hostname==='sam.gov'?url:`https://sam.gov/opp/${encodeURIComponent(n.noticeId)}/view`,postedAt:n.postedDate??null,type:n.type??null,baseType:n.baseType??null,active:/^yes$/i.test(n.active??'')?'yes' as const:/^no$/i.test(n.active??'')?'no' as const:'unknown' as const,deadlineRaw,deadlineUtc:utc,archiveDate:n.archiveDate??null,setAside:n.typeOfSetAsideDescription??n.setAside??n.typeOfSetAside??n.setAsideCode??null,naics:n.naicsCode??null,awarded:Boolean(n.award)||/award/i.test(n.type??''),descriptionUrl:descriptionUrl&&new URL(descriptionUrl).hostname==='api.sam.gov'?descriptionUrl:null,attachmentUrls:(n.resourceLinks??[]).map(cleanUrl).filter((u):u is string=>Boolean(u))};
  return ProcurementNotice.parse({...facts,observedAt,snapshotHash:hash(facts)});
 });
}
export async function readSam(query:z.infer<typeof SamQuery>,fetcher:typeof fetch=fetch){
 const key=required('SAM_GOV_API_KEY'),url=new URL('https://api.sam.gov/opportunities/v2/search');
 for(const [name,value] of Object.entries(SamQuery.parse(query)))url.searchParams.set(name,String(value));url.searchParams.set('api_key',key);
 try{
  const response=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(20000)}),reader=response.body?.getReader();if(!reader)throw Error('sam_body_missing');
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>1000000)throw Error('sam_response_limit');chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});}
  // Some APIs echo authenticated request URLs. Never persist the credential in a raw response.
  const safe=Buffer.concat(chunks).toString('utf8').split(key).join('[redacted]').split(encodeURIComponent(key)).join('[redacted]');
  let body:unknown;try{body=JSON.parse(safe);}catch{body={error:'non_json_response'};}
  return SamSaved.parse({status:response.status,body,observedAt:new Date().toISOString()});
 }catch{throw Error('sam_transport_unavailable');}
}
export async function searchSam(operations:OperationGateway,key:string,query:z.infer<typeof SamQuery>){
 const saved=SamSaved.parse(await operations.run(key,'sam',query,'0',1,SamSaved,async()=>{const response=await readSam(query);return {response,actual:'0',usage:{requests:1,http_status:response.status}};}));
 if(saved.status!==200)throw Error(`sam_http_${saved.status}`);return normalizeSam(saved.body,saved.observedAt);
}
