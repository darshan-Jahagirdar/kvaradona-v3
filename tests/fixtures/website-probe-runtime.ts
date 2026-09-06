import assert from 'node:assert/strict';
import {launchResearchBrowser} from '../../src/capture/specialists';
import {websiteProbe} from '../../src/capture/website-probe';
 const browser=await launchResearchBrowser();try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.setContent('<!doctype html><style>body{margin:0}</style><title>Workflow reporting</title><meta name="robots" content="noindex"><nav><a href="/pricing">Pricing</a></nav><main style="width:700px"><h1>Reporting for operations teams</h1><p>We help operations teams organize their weekly reporting workflows.</p><label id="label">Work email</label><input id="email" aria-labelledby="label" value="private-entered-value"><input id="unlabeled" aria-labelledby="missing"><button>Request a demo</button></main>');
  const mobile=await websiteProbe(page,'mobile');assert.ok(mobile.facts.find(f=>f.id==='mobile_layout')?.text.includes('700'));assert.ok(mobile.facts.find(f=>f.id==='mobile_forms')?.text.includes('1 have no detected'));assert.deepEqual(mobile.robots,['robots: noindex']);assert.ok(!JSON.stringify(mobile.facts).includes('private-entered-value'));assert.ok(mobile.facts.some(f=>f.text.includes('Reporting for operations teams')));
  await page.setViewportSize({width:1440,height:900});const desktop=await websiteProbe(page,'desktop');assert.ok(desktop.facts[0].text.includes('1440 × 900'));assert.ok(desktop.facts.some(f=>f.category==='navigation'));
 }finally{await browser.close();}
