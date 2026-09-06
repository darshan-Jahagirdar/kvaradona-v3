import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {load} from 'cheerio';
import {z} from 'zod';
import {Evidence} from '../contracts/pipeline';
import {ProcurementDocuments,type ProcurementNotice} from '../contracts/procurement';
import {procurementIdentity} from '../domain/procurement';
import {hash} from '../domain/policy';
import {safeRead,robotsAllows} from './fetch';
import {required} from '../config/env';
import type {OperationGateway} from '../usage/operations';
const Result=z.object({evidence:z.array(Evidence),documents:ProcurementDocuments});
export async function pdfText(bytes:Uint8Array){
 const dir=await mkdtemp(join(tmpdir(),'kvara-pdf-'));try{
  const path=join(dir,'input.pdf');await writeFile(path,bytes,{mode:0o600});
  const {stdout}=await promisify(execFile)(process.execPath,['--max-old-space-size=128','src/capture/pdf-text.mjs',path],{timeout:10000,maxBuffer:100000});return z.object({text:z.string().max(18000)}).parse(JSON.parse(stdout)).text;
 }catch{throw Error('pdf_extraction_unavailable');}finally{await rm(dir,{recursive:true,force:true});}
}
function evidence(n:ProcurementNotice,url:string,text:string,title:string):z.infer<typeof Evidence>{return {id:randomUUID(),url,finalUrl:url,title,text,contentHash:hash(text),retrievedAt:new Date().toISOString(),publishedAt:n.postedAt,source:'procurement_original',origin:'original',status:n.active==='no'||n.awarded?'closed':'unknown',accountHost:n.buyerCode?procurementIdentity(n):null};}
export async function collectProcurement(n:ProcurementNotice,read:typeof safeRead=safeRead){
 const records:z.infer<typeof Evidence>[]=[],missing:string[]=[],attemptedUrls:string[]=[];
 if(n.descriptionTruncated)missing.push('Published description exceeds the extraction limit; verify the full original requirements.');
 const facts=JSON.stringify({noticeId:n.noticeId,buyer:n.buyer,buyerCode:n.buyerCode,title:n.title,type:n.type,active:n.active,deadline:n.deadlineRaw,setAside:n.setAside,awarded:n.awarded});
 records.push(evidence(n,n.url,facts,'Original published notice metadata'));
 if(n.description&&n.description.trim().length>=120)records.push(evidence(n,n.url,n.description,n.title));
 else if(n.descriptionUrl){
  const u=new URL(n.descriptionUrl);if(u.protocol!=='https:'||u.hostname!=='api.sam.gov'||u.username||u.password||u.port)throw Error('unsafe_description_url');
  attemptedUrls.push(n.descriptionUrl);u.searchParams.set('api_key',required('SAM_GOV_API_KEY'));
  // Authenticated URL is confined to the official API and never redirected or persisted.
  try{const response=await fetch(u,{redirect:'error',signal:AbortSignal.timeout(15000)});const reader=response.body?.getReader();if(!reader)throw Error('body_missing');const chunks:Uint8Array[]=[];let size=0;try{while(true){const x=await reader.read();if(x.done)break;size+=x.value.length;if(size>500000)throw Error('description_limit');chunks.push(x.value);}}finally{await reader.cancel().catch(()=>{});}
   if(response.status!==200)throw Error('description_unavailable');let raw=Buffer.concat(chunks).toString('utf8');const key=required('SAM_GOV_API_KEY');raw=raw.split(key).join('[redacted]').split(encodeURIComponent(key)).join('[redacted]');
   let value:unknown;try{value=JSON.parse(raw);}catch{value=raw;}const html=typeof value==='string'?value:z.object({description:z.string()}).parse(value).description;const text=load(html).text().replace(/\s+/g,' ').trim();if(text.length<120||text.length>18000)throw Error('description_text_limit');records.push(evidence(n,n.descriptionUrl,text,n.title));
  }catch{missing.push('Original notice description unavailable; no automatic retry.');}
 }else missing.push('Original notice description is missing.');
 for(const url of [...new Set(n.attachmentUrls)].slice(0,3)){
  attemptedUrls.push(url);try{
   const u=new URL(url),robots=await read(new URL('/robots.txt',u).href,128000);if(robots.status===200&&!robotsAllows(robots.text,u.pathname)||robots.status===429||robots.status>=500)throw Error('robots_unavailable');
   const r=await read(url,2000000);if(r.status!==200)throw Error('attachment_unavailable');let text:string;
   if(/application\/pdf/.test(r.contentType)||r.bytes.subarray(0,5).toString()==='%PDF-')text=await pdfText(r.bytes);
   else if(/html|text\/plain/.test(r.contentType)){const $=load(r.text);$('script,style,nav,footer,header').remove();text=$('body').text().replace(/\s+/g,' ').trim();if(text.length<120||text.length>18000)throw Error('attachment_text_limit');}else throw Error('attachment_format_unavailable');
   await mkdir('.local/procurement-documents',{recursive:true});const digest=createHash('sha256').update(r.bytes).digest('hex');await writeFile(`.local/procurement-documents/${digest}`,r.bytes,{mode:0o600});records.push(evidence(n,r.url,text,`Notice attachment ${records.length}`));
  }catch{missing.push(`Attachment unavailable or outside extraction limits: ${url}`);}
 }
 if(n.attachmentUrls.length>3)missing.push('Additional attachments exceed this run’s three-document limit.');
 return Result.parse({evidence:records,documents:{snapshotHash:n.snapshotHash,attemptedUrls,missing,collectedAt:new Date().toISOString()}});
}
export async function procurementEvidence(operations:OperationGateway,n:ProcurementNotice){return Result.parse(await operations.run('procurement_documents',n.source,{notice:n},'0',n.descriptionUrl?1:0,Result,async()=>({response:await collectProcurement(n),actual:'0',usage:{descriptionRequests:n.descriptionUrl?1:0,maxAttachments:3}})));}
