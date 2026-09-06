import {it,expect,vi} from 'vitest';
const transport=vi.hoisted(()=>({calls:[] as string[]}));
vi.mock('../src/capture/fetch',()=>({robotsAllows:()=>true,publicUrl:async()=>{},safeRead:async(url:string)=>{
 transport.calls.push(url);const robots=url.endsWith('/robots.txt'),missing=url.endsWith('/image.png');
 const text=robots?'User-agent: *\nAllow: /':missing?'missing':'<!doctype html><title>Capture fixture</title><style>body{margin:0;font:20px Arial}main{max-width:700px}</style><main><h1>Reporting for operations teams</h1><p>This synthetic page checks the complete browser capture path with a mocked public HTTP transport. It does not establish live site behavior or model quality.</p><img src="/image.png" width="120" height="80" alt="Synthetic image unavailable"></main>';
 return {url,status:missing?404:200,contentType:robots||missing?'text/plain':'text/html',text,bytes:Buffer.from(text),robotsHeader:null};
}}));
import {captureWebsiteEvidence} from '../src/capture/website';
it('captures both viewports through one cached transport and records unavailable images as collection limits',async()=>{
 const {capture,images}=await captureWebsiteEvidence('https://fixture.invalid/','fixture.invalid');
 expect(capture.complete).toBe(true);expect(capture.screenshots.map(s=>s.viewport)).toEqual(['mobile','desktop']);expect(images).toHaveLength(2);
 expect(transport.calls).toEqual(['https://fixture.invalid/robots.txt','https://fixture.invalid/','https://fixture.invalid/image.png']);
 expect(capture.requests).toBe(3);expect(capture.facts.some(f=>f.viewport==='desktop')).toBe(true);expect(capture.limitations.some(l=>l.includes('Missing images'))).toBe(true);
},15000);
