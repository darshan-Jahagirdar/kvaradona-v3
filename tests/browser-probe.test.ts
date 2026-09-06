import {expect,it} from 'vitest';
import {findings,probe,launchResearchBrowser} from '../src/capture/specialists';
it('measures a real Chromium fixture for CRO/AEO and accepts a zero-finding page',async()=>{
 const started=Date.now(),browser=await launchResearchBrowser();
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.setContent('<!doctype html><html><head><meta name="robots" content="noindex"></head><body><main style="width:800px"><input name="email"><h2>Contact</h2></main></body></html>');
  const measured=await probe(page);
  expect(measured.unlabeledFields).toBe(1);expect(measured.documentWidth).toBeGreaterThan(390);
  expect(findings(measured,'cro').map(f=>f.metric)).toEqual(['unlabeledFields','documentWidth']);
  expect(findings(measured,'aeo').map(f=>f.metric)).toEqual(['robots','h1']);
  await page.setContent('<!doctype html><main><h1>Contact us</h1><label for="email">Email</label><input id="email" name="email"></main>');
  const clean=await probe(page);expect(findings(clean,'cro')).toEqual([]);expect(findings(clean,'aeo')).toEqual([]);
  console.log(JSON.stringify({evidence:'local_chromium_synthetic_fixture',elapsedMs:Date.now()-started,externalCalls:0}));
 }finally{await browser.close();}
},20000);
