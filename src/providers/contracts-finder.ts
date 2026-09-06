import {z} from 'zod';
import {load} from 'cheerio';
import {supportedService} from '../domain/service-fit';
import {hash} from '../domain/policy';
import {ProcurementNotice} from '../contracts/procurement';
import {safeRead} from '../capture/fetch';
import type {OperationGateway} from '../usage/operations';
export const ContractsQuery=z.object({publishedFrom:z.string().datetime(),publishedTo:z.string().datetime(),stages:z.literal('tender'),limit:z.literal(100)});
const Saved=z.object({body:z.unknown(),observedAt:z.string().datetime()});
const Document=z.object({url:z.string().optional(),documentType:z.string().optional()}).passthrough();
const Release=z.object({ocid:z.string(),id:z.string(),date:z.string(),buyer:z.object({id:z.string(),name:z.string()}),tag:z.array(z.string()).default([]),tender:z.object({id:z.string().optional(),title:z.string(),description:z.string().default(''),status:z.string().optional(),tenderPeriod:z.object({endDate:z.string().optional()}).optional(),documents:z.array(Document).default([]),submissionMethodDetails:z.string().optional()}).passthrough(),awards:z.array(z.unknown()).optional()}).passthrough();
export function contractsQuery(now=new Date()){return ContractsQuery.parse({publishedFrom:new Date(now.getTime()-30*86400000).toISOString(),publishedTo:now.toISOString(),stages:'tender',limit:100});}
export function normalizeContractsFinder(body:unknown,observedAt:string){
 const releases=z.object({releases:z.array(z.unknown()).max(100)}).parse(body).releases;
 const latest=new Map<string,z.infer<typeof Release>>();
 for(const raw of releases){const parsed=Release.safeParse(raw);if(!parsed.success)continue;const n=parsed.data,prior=latest.get(n.ocid);if(!prior||Date.parse(n.date)>Date.parse(prior.date))latest.set(n.ocid,n);}
 return [...latest.values()].filter(n=>supportedService(n.tender.title+' '+n.tender.description)).slice(0,3).map(n=>{
  const t=n.tender,deadline=t.tenderPeriod?.endDate??null;
  const links=t.documents.map(d=>d.url).filter((u):u is string=>Boolean(u&&/^https:\/\//i.test(u)));
  const publicLink=links.find(u=>new URL(u).hostname==='www.contractsfinder.service.gov.uk')??`https://www.contractsfinder.service.gov.uk/Published/OCDS/Record/${encodeURIComponent(n.ocid)}`;
  const facts={source:'contracts_finder',noticeId:n.ocid,releaseId:n.id,solicitationNumber:t.id??null,buyer:n.buyer.name,buyerCode:n.buyer.id,title:t.title,url:publicLink,postedAt:n.date,type:'Solicitation',baseType:'tender',active:t.status==='active'?'yes':['cancelled','unsuccessful','complete','withdrawn'].includes(t.status??'')?'no':'unknown',deadlineRaw:deadline,deadlineUtc:deadline&&/(Z|[+-]\d{2}:\d{2})$/i.test(deadline)&&Number.isFinite(Date.parse(deadline))?new Date(deadline).toISOString():null,archiveDate:null,setAside:null,naics:null,awarded:Boolean(n.awards?.length||n.tag.some(t=>/award/i.test(t))),descriptionUrl:null,attachmentUrls:links.filter(u=>u!==publicLink),descriptionTruncated:load(t.description).text().replace(/\s+/g,' ').trim().length>18000,description:load(t.description).text().replace(/\s+/g,' ').trim().slice(0,18000)};
  return ProcurementNotice.parse({...facts,observedAt,snapshotHash:hash(facts)});
 });
}
export async function searchContractsFinder(operations:OperationGateway,key:string,query:z.infer<typeof ContractsQuery>){
 const saved=Saved.parse(await operations.run(key,'contracts_finder',query,'0',1,Saved,async()=>{
  const url=new URL('https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search');for(const [k,v] of Object.entries(ContractsQuery.parse(query)))url.searchParams.set(k,String(v));
  const r=await safeRead(url.href,2000000);if(r.status!==200)throw Error(`contracts_finder_http_${r.status}`);
  return {response:{body:JSON.parse(r.text),observedAt:new Date().toISOString()},actual:'0',usage:{requests:1}};
 }));return normalizeContractsFinder(saved.body,saved.observedAt);
}
