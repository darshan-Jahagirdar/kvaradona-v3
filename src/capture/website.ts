import {randomUUID,createHash} from 'node:crypto';
import {hash,hostOf} from '../domain/policy';
import {safeRead,robotsAllows} from './fetch';
import {launchResearchBrowser} from './specialists';
import {websiteProbe} from './website-probe';
import {selectWebsiteFacts} from './website-facts';
import {websiteResources} from './website-resources';
import {websiteLimits as limits} from './website-limits';
import {WebsiteCapture,type WebsiteFact} from '../contracts/website';
import type {AIImage} from '../ai/images';
export const websiteViewports={mobile:{width:390,height:844},desktop:{width:1440,height:900}} as const;
export async function captureWebsiteEvidence(url:string,expectedHost:string){
 if(hostOf(url)!==expectedHost)throw Error('website_account_mismatch');
 const started=Date.now(),controller=new AbortController();
 const overall=AbortSignal.any([controller.signal,AbortSignal.timeout(limits.totalMs)]);
 const robots=await safeRead(new URL('/robots.txt',url).href,128000,overall);
 if(robots.status===200&&!robotsAllows(robots.text,new URL(url).pathname))throw Error('robots_disallowed');
 if(robots.status===429||robots.status>=500)throw Error('robots_unavailable');
 const sourceDocument=await safeRead(url,limits.criticalBytes,overall,30000);
 if(sourceDocument.status!==200||!/html/.test(sourceDocument.contentType))throw Error('website_document_unavailable');
 if(hostOf(sourceDocument.url)!==expectedHost)throw Error('website_redirect_account_mismatch');
 const id=randomUUID(),images:AIImage[]=[],screenshots:WebsiteCapture['screenshots']=[],facts:WebsiteFact[]=[],limitations:string[]=[];
 let criticalFailures=0,resourceFailures=0,stable=true,bodyUsable=true;
 const browser=await launchResearchBrowser();
 const resources=websiteResources(sourceDocument,robots.bytes.length,overall);
 const context=await browser.newContext({viewport:websiteViewports.mobile,deviceScaleFactor:1,serviceWorkers:'block',acceptDownloads:false,reducedMotion:'reduce'});
 const deadline=setTimeout(()=>{controller.abort();void context.close().catch(()=>{});},Math.max(1,limits.totalMs-(Date.now()-started)));
 try{
  await context.route('**/*',async route=>{
   const req=route.request(),kind=req.resourceType(),critical=['document','stylesheet','script'].includes(kind);
   if(req.method()!=='GET'||!['document','stylesheet','image','font','script'].includes(kind))return route.abort().catch(()=>{});
   try{
    if(overall.aborted)throw Error('capture_deadline');
    const r=await resources.read(req.url(),kind);if(r.status>=400){resourceFailures++;if(critical){criticalFailures++;limitations.push(`Critical ${kind} returned HTTP ${r.status}: ${new URL(req.url()).origin}${new URL(req.url()).pathname}`);}}
    await route.fulfill({status:r.status,contentType:r.contentType,body:r.bytes});
   }catch(error){if(!(error instanceof Error&&error.message==='capture_optional_limit'))resourceFailures++;if(critical){criticalFailures++;const reason=error instanceof Error&&/^[a-z_]+$/.test(error.message)?error.message:'retrieval_failed';limitations.push(`Critical ${kind} ${reason}: ${new URL(req.url()).origin}${new URL(req.url()).pathname}`);}await route.abort().catch(()=>{});}
  });
  const page=await context.newPage();
  for(const viewport of ['mobile','desktop'] as const){
   await page.setViewportSize(websiteViewports[viewport]);await page.goto(sourceDocument.url,{waitUntil:'domcontentloaded',timeout:Math.min(limits.navigationMs,Math.max(1,limits.totalMs-(Date.now()-started)))});
   // DOMContentLoaded does not mean async assets have finished. Allow the bounded
   // public resource queue to drain before interpreting missing content or layout.
   const settleUntil=Date.now()+limits.settleMs;let quietSince=Date.now();
   while(Date.now()<settleUntil){
    if(resources.pending)quietSince=Date.now();
    else if(Date.now()-quietSince>=500)break;
    await page.waitForTimeout(100);
   }
   if(resources.pending){bodyUsable=false;limitations.push(`${viewport}: resource collection did not settle before sampling.`);}
   await Promise.race([page.evaluate(()=>document.fonts.ready.then(()=>undefined)),new Promise(resolve=>setTimeout(resolve,5000))]);
   await page.evaluate(()=>{document.querySelectorAll('video,audio').forEach(e=>(e as HTMLMediaElement).pause());});
   await page.waitForTimeout(500);
   let frame0=await page.screenshot({type:'png',animations:'disabled',caret:'hide',timeout:5000}),first=await websiteProbe(page,viewport);
   let png=frame0,last=first;
   for(let sample=0;sample<5;sample++){
    await page.waitForTimeout(750);png=await page.screenshot({type:'png',animations:'disabled',caret:'hide',timeout:5000});last=await websiteProbe(page,viewport);
    if(hash(first.facts)===hash(last.facts)&&frame0.equals(png))break;
    if(sample<4){first=last;frame0=png;}
   }
   if(hash(first.facts)!==hash(last.facts)||!frame0.equals(png)){stable=false;limitations.push(`${viewport}: the render changed between samples. Do not classify animation or moving content as a defect.`);}
   if(last.bodyText.length<120||/just a moment|verify you are human|access denied/i.test(last.title))bodyUsable=false;
   facts.push(...last.facts);const dimensions=websiteViewports[viewport];
   images.push({id:viewport,png,...dimensions});screenshots.push({viewport,...dimensions,path:`${id}/${viewport}.png`,sha256:createHash('sha256').update(png).digest('hex'),bytes:png.length});
   if(viewport==='mobile'){
    const metadata=[['title',last.title],['robots',last.robots.join('; ')||'No robots/googlebot meta tag detected.'],['http_robots',sourceDocument.robotsHeader||'No X-Robots-Tag header detected.'],['canonical',last.canonical??'No canonical link detected.'],['description',last.description??'No meta description detected.'],['structured_data',last.structuredData.join('\n')||'No JSON-LD detected. Absence does not establish an AI visibility issue.']];
    for(const [key,value] of metadata)facts.push({id:`page_${key}`,category:key==='title'||key==='description'?'content':'discovery',viewport:'page',selector:null,text:value.slice(0,1600)});
    facts.push({id:'page_performance',category:'performance',viewport:'page',selector:null,text:`Field Core Web Vitals and PageSpeed: unavailable. Proxied capture DOMContentLoaded: ${last.domContentLoadedMs??'unknown'}ms; this transport diagnostic cannot establish visitor load speed or conversion loss.`});
   }
  }
 }finally{clearTimeout(deadline);controller.abort();await browser.close();}
 limitations.push('One public page, two viewports; no form submissions, menu activation, private analytics, field-performance or search-engine inclusion verification.','Network was bounded and proxied for safe public-only retrieval. Reduced motion was requested; media paused and screenshots disabled animations.','Resource policy: critical content, scripts and styles take priority, with four reserved read slots. Optional assets have two slots and separate collection ceilings. Collection allows 240 seconds, 90 seconds per navigation, 160 reads and 25 MB; these are collection limits, not visitor performance measurements.');
 if(resourceFailures)limitations.push(`${resourceFailures} resource requests failed or exceeded collection limits. Missing images or other resources may be capture artifacts, not website defects.`);
 if(resources.skipped.size)limitations.push(`${resources.skipped.size} distinct image/font resources were intentionally omitted. Capture permits twelve images and eight fonts, each at most 750 KB and five seconds; missing assets or fallback fonts are collection artifacts, not site defects.`);
 if(criticalFailures)limitations.push(`${criticalFailures} critical resource requests failed or exceeded capture limits. Missing content or styling is not a verified site defect.`);
 if(!bodyUsable)limitations.push('Rendered content was insufficient, appeared to be an access challenge, or its resource queue did not settle.');
 const {facts:bounded,omitted}=selectWebsiteFacts(facts);
 if(omitted)limitations.push(`${omitted} additional DOM observations were omitted at the capture context limit; page metadata and viewport/category coverage were prioritized.`);
 return {capture:WebsiteCapture.parse({id,url,finalUrl:sourceDocument.url,accountHost:expectedHost,observedAt:new Date().toISOString(),version:'web-1',mode:'live',complete:bodyUsable&&criticalFailures===0,facts:bounded,screenshots,limitations,...resources.stats,elapsedMs:Date.now()-started,renderStable:stable}),images};
}
