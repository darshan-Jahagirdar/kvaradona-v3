import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Packet} from '../src/contracts/pipeline';
import {WebsiteCapture,type WebsiteAnalysis} from '../src/contracts/website';
import {websiteSpecialistStep,type WebsiteTools} from '../src/stages/website-specialist';
import {captureEvidence,websiteInputHash,websiteReviewProblems,websiteDraftClaims} from '../src/domain/website-specialist';
import {hash} from '../src/domain/policy';
function fixture(){
 const capture=WebsiteCapture.parse({id:randomUUID(),url:'https://fixture.invalid/',finalUrl:'https://fixture.invalid/',accountHost:'fixture.invalid',observedAt:new Date().toISOString(),version:'web-1',mode:'fixture',complete:true,facts:[{id:'mobile_field_0',category:'form',viewport:'mobile',selector:'#email',text:'An email input has no detected accessible name.'},{id:'page_title',category:'content',viewport:'page',selector:null,text:'Make things better.'}],screenshots:[],limitations:['Synthetic evidence.'],requests:0,bytes:0,elapsedMs:0,renderStable:true});
 const p=Packet.parse({mode:'fixture',state:'researched',evidence:[],research:{company:'Fixture Systems',accountHost:'fixture.invalid',identityBasis:'Fixture only.',service:'Website',demand:'plausible',whyNow:'Synthetic verification.',offer:'A conditional website review.',buyerRole:'Owner',claims:[],contrary:[],uncertainties:[],decision:'exploration',reason:'Fixture only.',watchTrigger:null,specialist:'cro',specialistReason:'Assess the lead form and offer clarity.',followUp:null},websiteRequest:{profiles:['cro','aeo'],url:'https://fixture.invalid/',question:'Assess the lead form and offer clarity.',requestedAt:new Date().toISOString(),verificationOnly:true},draft:{subject:'Preserved',body:'Do not rewrite this fixture.',recipient:null,sender:null,claimIds:[]}});
 const analysis:WebsiteAnalysis={coverage:[{profile:'cro',result:'findings',reason:'Form clarity.'},{profile:'aeo',result:'findings',reason:'Offer clarity.'}],findings:[{id:'web_form',profile:'cro',observationIds:['mobile_field_0'],hypothesis:'An explicit label may help visitors understand the field.',validationQuestion:'Is the label supplied in another state?',proposedChange:'Add a visible field label.'},{id:'web_content',profile:'aeo',observationIds:['page_title'],hypothesis:'The title may not explain the service to a new visitor.',validationQuestion:'What does the intended audience need to know?',proposedChange:'Name the service and audience clearly.'}],limitations:['No measured outcomes.']};
 return {p,capture,analysis};
}
function harness(capture:WebsiteCapture,analysis:WebsiteAnalysis){
 const calls:string[]=[];let captures=0;
 const tools:WebsiteTools={websiteCapture:async()=>{captures++;return capture;},websiteImages:async()=>[],ai:{async generate(role,_key,schema,_instructions,input){calls.push(role);return schema.parse(role==='A3'?analysis:{inputHash:(input as {inputHash:string}).inputHash,acceptable:true,issues:[],verdicts:analysis.findings.map(f=>({findingId:f.id,observationIds:f.observationIds,verdict:'supported_hypothesis',reason:''}))});}}};
 return {tools,calls,captures:()=>captures};
}
it('checkpoints shared capture, analysis and review separately and reuses exact saved results',async()=>{
 const {p,capture,analysis}=fixture(),h=harness(capture,analysis),draft=structuredClone(p.draft);
 expect(await websiteSpecialistStep(p,h.tools)).toBe('S08');expect(h.calls).toEqual([]);expect(p.websiteSupplement?.analysis).toBeUndefined();
 const resumed=Packet.parse(JSON.parse(JSON.stringify(p)));expect(await websiteSpecialistStep(resumed,h.tools)).toBe('S08');expect(h.calls).toEqual(['A3']);
 expect(await websiteSpecialistStep(resumed,h.tools)).toBeNull();expect(resumed.state).toBe('verification_review_ready');expect(h.calls).toEqual(['A3','A5']);expect(websiteReviewProblems(resumed)).toEqual([]);
 await websiteSpecialistStep(resumed,h.tools);expect(h.calls).toEqual(['A3','A5']);expect(h.captures()).toBe(1);expect(resumed.draft).toEqual(draft);
 expect(websiteDraftClaims(resumed)).toEqual([]);expect(websiteDraftClaims(resumed,true)).toHaveLength(2);
 resumed.draft!.claimIds=['web_mobile_field_0'];expect(websiteDraftClaims(resumed)).toHaveLength(1);
 resumed.research!.service='Changed input';expect(websiteReviewProblems(resumed)).toContain('Website analysis is stale');
});
it('accepts zero findings for both profiles and never treats an incomplete capture as a clean audit',async()=>{
 const {p,capture,analysis}=fixture();analysis.findings=[];analysis.coverage=analysis.coverage.map(c=>({...c,result:'no_supported_findings'}));const h=harness(capture,analysis);
 for(let step=0;step<3;step++)await websiteSpecialistStep(p,h.tools);expect(websiteReviewProblems(p)).toEqual([]);
 const incomplete=fixture();incomplete.capture.complete=false;const limited=harness(incomplete.capture,incomplete.analysis);
 expect(await websiteSpecialistStep(incomplete.p,limited.tools)).toBeNull();expect(incomplete.p.state).toBe('website_pending');expect(limited.calls).toEqual([]);
});
it('rejects invented observations and unstable visual claims before paying for evidence review',async()=>{
 for(const failure of ['invented','unstable'] as const){const {p,capture,analysis}=fixture();if(failure==='invented')analysis.findings[0].observationIds=['not_measured'];else capture.renderStable=false;
  const h=harness(capture,analysis);await websiteSpecialistStep(p,h.tools);expect(await websiteSpecialistStep(p,h.tools)).toBeNull();expect(p.state).toBe('specialist_exception');expect(h.calls).toEqual(['A3']);
 }
});
it('binds reviews to exact measurements and finding coverage rather than an acceptable flag',async()=>{
 const {p,capture,analysis}=fixture(),h=harness(capture,analysis);for(let i=0;i<3;i++)await websiteSpecialistStep(p,h.tools);
 p.websiteSupplement!.review!.verdicts[0].observationIds=['page_title'];expect(websiteReviewProblems(p)).toContain('Website review coverage:web_form');
 p.websiteSupplement!.capture.facts[0].text='Fabricated metric';expect(websiteReviewProblems(p)).toContain('Website measurements do not match stored evidence');
 delete p.research;expect(websiteReviewProblems(p)).toContain('Website attribution mismatch');
});
