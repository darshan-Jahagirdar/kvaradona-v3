import {it,expect,vi,beforeEach} from 'vitest';
const transport=vi.hoisted(()=>({calls:[] as string[],crowded:false,broken:false,active:0,maxActive:0}));
vi.mock('../src/capture/fetch',()=>({robotsAllows:()=>true,publicUrl:async()=>{},safeRead:async(url:string)=>{
 transport.calls.push(url);transport.active++;transport.maxActive=Math.max(transport.maxActive,transport.active);
 await new Promise(resolve=>setTimeout(resolve,20));transport.active--;
 const robots=url.endsWith('/robots.txt'),missing=url.endsWith('/image.png')||transport.broken&&url.endsWith('/critical.css');
 if(transport.crowded&&!robots){
  const script=url.endsWith('.js'),css=url.endsWith('.css'),asset=url.endsWith('.png')||url.endsWith('.woff2');
  const text=missing?'unavailable':script?'document.querySelector("h1").textContent="Critical script loaded";':css?'body{margin:0;font:20px Arial}'+Array.from({length:8},(_,i)=>`@font-face{font-family:f${i};src:url(/font${i}.woff2)}.f${i}{font-family:f${i}}`).join(''):asset?'fixture asset':`<!doctype html><title>Crowded capture</title><main><h1>Waiting for script</h1><p>This synthetic company page describes reporting for operations teams and checks that optional resources cannot crowd out scripts and styles needed to interpret the content.</p>${Array.from({length:60},(_,i)=>`<img src="/asset${i}.png" width="10" height="10" alt="">`).join('')}${Array.from({length:8},(_,i)=>`<span class="f${i}">Font sample ${i}</span>`).join('')}</main><link rel="stylesheet" href="/critical.css"><script defer src="/critical.js"></script>`;
  return {url,status:missing?404:200,contentType:missing?'text/plain':script?'text/javascript':css?'text/css':asset?'application/octet-stream':'text/html',text,bytes:Buffer.from(text),robotsHeader:null};
 }
 const text=robots?'User-agent: *\nAllow: /':missing?'missing':'<!doctype html><title>Capture fixture</title><style>body{margin:0;font:20px Arial}main{max-width:700px}</style><main><h1>Reporting for operations teams</h1><p>This synthetic page checks the complete browser capture path with a mocked public HTTP transport. It does not establish live site behavior or model quality.</p><img src="/image.png" width="120" height="80" alt="Synthetic image unavailable"></main>';
 return {url,status:missing?404:200,contentType:robots||missing?'text/plain':'text/html',text,bytes:Buffer.from(text),robotsHeader:null};
}}));
import {captureWebsiteEvidence} from '../src/capture/website';
beforeEach(()=>{transport.calls=[];transport.crowded=false;transport.broken=false;transport.active=0;transport.maxActive=0;});
it('captures both viewports through one cached transport and records unavailable images as collection limits',async()=>{
 const {capture,images}=await captureWebsiteEvidence('https://fixture.invalid/','fixture.invalid');
 expect(capture.complete).toBe(true);expect(capture.screenshots.map(s=>s.viewport)).toEqual(['mobile','desktop']);expect(images).toHaveLength(2);
 expect(transport.calls).toEqual(['https://fixture.invalid/robots.txt','https://fixture.invalid/','https://fixture.invalid/image.png']);
 expect(capture.requests).toBe(3);expect(capture.facts.some(f=>f.viewport==='desktop')).toBe(true);expect(capture.limitations.some(l=>l.includes('Missing images'))).toBe(true);
},15000);
it('preserves critical loading under an image/font flood and reuses both viewport responses',async()=>{
 transport.crowded=true;
 const {capture}=await captureWebsiteEvidence('https://fixture.invalid/','fixture.invalid');
 expect(capture.complete).toBe(true);
 for(const viewport of ['mobile','desktop'])expect(capture.facts.some(f=>f.viewport===viewport&&f.text.includes('Critical script loaded'))).toBe(true);
 expect(transport.calls.filter(u=>u.endsWith('/critical.css'))).toHaveLength(1);expect(transport.calls.filter(u=>u.endsWith('/critical.js'))).toHaveLength(1);
 expect(transport.calls.filter(u=>u.endsWith('.png'))).toHaveLength(4);expect(transport.calls.filter(u=>u.endsWith('.woff2'))).toHaveLength(4);
 expect(transport.calls.findIndex(u=>u.endsWith('/critical.js'))).toBeLessThan(transport.calls.findIndex(u=>u.endsWith('.png')));
 expect(transport.maxActive).toBeLessThanOrEqual(2);expect(capture.requests).toBe(transport.calls.length);expect(capture.requests).toBeLessThanOrEqual(50);expect(capture.bytes).toBeLessThanOrEqual(10000000);
 expect(capture.limitations.some(l=>l.includes('intentionally omitted'))).toBe(true);
},15000);
it('keeps failed critical styling incomplete even when optional resources are omitted',async()=>{
 transport.crowded=true;transport.broken=true;
 const {capture}=await captureWebsiteEvidence('https://fixture.invalid/','fixture.invalid');
 expect(capture.complete).toBe(false);expect(capture.limitations.some(l=>l.includes('critical resource'))).toBe(true);
},15000);
