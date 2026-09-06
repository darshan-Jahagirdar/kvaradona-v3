import {randomUUID,createHash} from 'node:crypto';
import {hash,hostOf} from '../domain/policy';
import {safeRead,robotsAllows} from './fetch';
import {launchResearchBrowser} from './specialists';
import {websiteProbe} from './website-probe';
import {WebsiteCapture,type WebsiteFact} from '../contracts/website';
import type {AIImage} from '../ai/images';
export const websiteViewports={mobile:{width:390,height:844},desktop:{width:1440,height:900}} as const;
export async function captureWebsiteEvidence(url:string,expectedHost:string){
 if(hostOf(url)!==expectedHost)throw Error('website_account_mismatch');
 const started=Date.now(),robots=await safeRead(new URL('/robots.txt',url).href,128000);
 if(robots.status===200&&!robotsAllows(robots.text,new URL(url).pathname))throw Error('robots_disallowed');
 if(robots.status===429||robots.status>=500)throw Error('robots_unavailable');
 const sourceDocument=await safeRead(url);
 if(sourceDocument.status!==200||!/html/.test(sourceDocument.contentType))throw Error('website_document_unavailable');
 if(hostOf(sourceDocument.url)!==expectedHost)throw Error('website_redirect_account_mismatch');
 const id=randomUUID(),images:AIImage[]=[],screenshots:WebsiteCapture['screenshots']=[],facts:WebsiteFact[]=[],limitations:string[]=[];
 let requests=2,bytes=robots.bytes.length+sourceDocument.bytes.length,criticalFailures=0,resourceFailures=0,stable=true,bodyUsable=true;
 const cache=new Map<string,Promise<Awaited<ReturnType<typeof safeRead>>>>([[sourceDocument.url,Promise.resolve(sourceDocument)]]);
 const browser=await launchResearchBrowser();let active=0,reservedBytes=0;const waiting:(()=>void)[]=[];const controller=new AbortController();
 const context=await browser.newContext({viewport:websiteViewports.mobile,deviceScaleFactor:1,serviceWorkers:'block',acceptDownloads:false,reducedMotion:'reduce'});
 const deadline=setTimeout(()=>{controller.abort();void context.close().catch(()=>{});},Math.max(1,45000-(Date.now()-started)));
 try{
  await context.route('**/*',async route=>{
   const req=route.request(),kind=req.resourceType(),critical=['document','stylesheet','script'].includes(kind);
   if(req.method()!=='GET'||!['document','stylesheet','image','font','script'].includes(kind))return route.abort().catch(()=>{});
   try{
    if(Date.now()-started>45000)throw Error('capture_deadline');
    let result=cache.get(req.url());
    if(!result){
     if(requests>=50||bytes>=10000000)throw Error('capture_request_limit');requests++;
     result=(async()=>{if(active>=2)await new Promise<void>(resolve=>waiting.push(resolve));else active++;
      let allowance=0;
      try{controller.signal.throwIfAborted();const remaining=10000000-bytes-reservedBytes;if(remaining<=0)throw Error('capture_byte_limit');allowance=Math.min(1000000,remaining);reservedBytes+=allowance;const value=await safeRead(req.url(),allowance,controller.signal);bytes+=value.bytes.length;return value;}finally{reservedBytes-=allowance;const resume=waiting.shift();if(resume)resume();else active--;}
     })();cache.set(req.url(),result);
    }
    const r=await result;if(r.status>=400){resourceFailures++;if(critical)criticalFailures++;}
    await route.fulfill({status:r.status,contentType:r.contentType,body:r.bytes});
   }catch{resourceFailures++;if(critical)criticalFailures++;await route.abort().catch(()=>{});}
  });
  const page=await context.newPage();
  for(const viewport of ['mobile','desktop'] as const){
   await page.setViewportSize(websiteViewports[viewport]);await page.goto(sourceDocument.url,{waitUntil:'domcontentloaded',timeout:25000});
   await Promise.race([page.evaluate(()=>document.fonts.ready.then(()=>undefined)),new Promise(resolve=>setTimeout(resolve,1500))]);
   await page.evaluate(()=>{document.querySelectorAll('video,audio').forEach(e=>(e as HTMLMediaElement).pause());});
   await page.waitForTimeout(500);
   const first=await websiteProbe(page,viewport);const frame0=await page.screenshot({type:'png',animations:'disabled',caret:'hide',timeout:5000});
   await page.waitForTimeout(400);const last=await websiteProbe(page,viewport);const png=await page.screenshot({type:'png',animations:'disabled',caret:'hide',timeout:5000});
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
 limitations.push('One public page, two viewports; no form submissions, menu activation, private analytics, field-performance or search-engine inclusion verification.','Network was bounded and proxied for safe public-only retrieval. Reduced motion was requested; media paused and screenshots disabled animations.');
 if(resourceFailures)limitations.push(`${resourceFailures} resource requests failed or exceeded collection limits. Missing images or other resources may be capture artifacts, not website defects.`);
 if(criticalFailures)limitations.push(`${criticalFailures} critical resource requests failed or exceeded capture limits. Missing content or styling is not a verified site defect.`);
 if(!bodyUsable)limitations.push('The rendered content was too short or appeared to be an access challenge.');
 const bounded:WebsiteFact[]=[];let factBytes=0;
 for(const f of facts){const size=Buffer.byteLength(JSON.stringify(f));if(factBytes+size>14000||bounded.length>=80){limitations.push('Additional DOM observations were omitted at the capture context limit.');break;}bounded.push(f);factBytes+=size;}
 return {capture:WebsiteCapture.parse({id,url,finalUrl:sourceDocument.url,accountHost:expectedHost,observedAt:new Date().toISOString(),version:'web-1',mode:'live',complete:bodyUsable&&criticalFailures===0,facts:bounded,screenshots,limitations,requests,bytes,elapsedMs:Date.now()-started,renderStable:stable}),images};
}
