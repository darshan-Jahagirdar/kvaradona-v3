import type { Page } from 'playwright';
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { safeRead,publicUrl } from './fetch';
export function launchResearchBrowser(){return chromium.launch({headless:true,...(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?{channel:'chrome'}:{})});}
export async function probe(page:Page){
 return page.evaluate(()=>{
  const visible=(e:Element)=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};
  const fields=[...document.querySelectorAll<HTMLInputElement>('input:not([type=hidden]),select,textarea')].filter(visible);
  const unlabeled=fields.filter(e=>!e.labels?.length&&!e.getAttribute('aria-label')&&!e.getAttribute('aria-labelledby')&&!e.getAttribute('title'));
  const links=[...document.querySelectorAll('a,button')].filter(visible);
  return {title:document.title,viewportWidth:innerWidth,documentWidth:document.documentElement.scrollWidth,
   fields:fields.length,unlabeledFields:unlabeled.length,smallTargets:links.filter(e=>{const r=e.getBoundingClientRect();return r.width<24||r.height<24;}).length,
   h1:document.querySelectorAll('h1').length,h2:document.querySelectorAll('h2').length,
   description:document.querySelector('meta[name=description]')?.getAttribute('content')??null,
   robots:document.querySelector('meta[name=robots]')?.getAttribute('content')??null,
   canonical:document.querySelector('link[rel=canonical]')?.getAttribute('href')??null,
   mainText:document.querySelector('main')?.textContent?.trim().slice(0,2000)??null};
 });
}
export type Measurements=Awaited<ReturnType<typeof probe>>;
export function findings(m:Measurements,profile:'cro'|'aeo'){
 const results:{profile:'cro'|'aeo';metric:string;observation:string;hypothesis:string}[]=[];
 if(profile==='cro'){
  if(m.unlabeledFields>0)results.push({profile,metric:'unlabeledFields',observation:`${m.unlabeledFields} visible form controls have no detected label.`,hypothesis:'These controls may be harder to understand; verify their purpose and accessible name.'});
  if(m.documentWidth>m.viewportWidth+4)results.push({profile,metric:'documentWidth',observation:`Document width ${m.documentWidth}px exceeds viewport ${m.viewportWidth}px.`,hypothesis:'Horizontal overflow may obstruct the mobile journey; inspect the affected content.'});
 }else{
  if(/noindex/i.test(m.robots??''))results.push({profile,metric:'robots',observation:`The page declares ${m.robots}.`,hypothesis:'If search discovery is intended, confirm whether excluding this page is deliberate.'});
  if(m.h1===0)results.push({profile,metric:'h1',observation:'No H1 element was detected.',hypothesis:'Review whether the main topic is clear in the page content. An H1 alone does not determine AI visibility.'});
 }
 return results;
}
export async function captureWebsite(url:string){
 await publicUrl(url);const started=Date.now();const browser=await launchResearchBrowser();
 try{
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block',acceptDownloads:false});let requests=0;
  await context.route('**/*',async route=>{if(++requests>25||Date.now()-started>25000||!['document','stylesheet','image','font','script'].includes(route.request().resourceType()))return route.abort();
   try{const r=await safeRead(route.request().url(),1000000);await route.fulfill({status:r.status,contentType:r.contentType,body:r.bytes});}catch{await route.abort();}});
  const page=await context.newPage();await page.goto(url,{waitUntil:'domcontentloaded',timeout:25000});await page.waitForTimeout(500);
  const measurements=await probe(page);return {measurements,elapsedMs:Date.now()-started,requests,url:page.url()};
 }finally{await browser.close();}
}
