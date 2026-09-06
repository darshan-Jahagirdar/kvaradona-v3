import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Packet,Job,CrmReview,type Review} from '../src/contracts/pipeline';
import {hash} from '../src/domain/policy';
import {crmInputHash,crmReviewTarget,crmReviewProblems,crmContext,draftResearch,repairCrmCitations} from '../src/domain/crm-specialist';
import {runStage,type StageTools} from '../src/stages/pipeline';
function fixture(){
 const eid=randomUUID(),fact='The May 2026 posting describes HubSpot reporting responsibilities.';
 const p=Packet.parse({mode:'fixture',state:'review_ready',evidence:[{id:eid,url:'https://fixture.invalid/jobs',finalUrl:'https://fixture.invalid/jobs',title:'Operations role',text:fact,contentHash:hash(fact),retrievedAt:new Date().toISOString(),publishedAt:'2026-05-01',source:'fixture',origin:'original',status:'unknown',accountHost:'fixture.invalid'}],research:{company:'Fixture Systems',accountHost:'fixture.invalid',identityBasis:fact,service:'CRM',demand:'plausible',whyNow:fact,offer:'Explore reporting requirements.',buyerRole:'Operations lead',claims:[{id:'c1',text:fact,quote:fact,evidenceId:eid,kind:'fact',material:true}],contrary:['The employer may deliver internally.'],uncertainties:['Current status unknown.'],decision:'exploration',reason:'Relevant work.',watchTrigger:null,specialist:'crm',specialistReason:'What bounded reporting help could be useful?',followUp:null},draft:{subject:'Reporting requirements',body:'Would an outline help if outside capacity is useful?',recipient:'alex@fixture.invalid',sender:null,claimIds:['c1']},contact:{name:'Alex Tester',role:'Operations lead',email:'alex@fixture.invalid',emailStatus:'provider_verified',employmentEvidence:'Fixture',source:'fixture',observedAt:new Date().toISOString(),state:'resolved',reason:'Fixture'}});
 const review:Review={acceptable:true,issues:[],inputHash:'',verdicts:[{claimId:'c1',verdict:'supported',evidenceIds:[eid],repair:''}]};
 p.packetReview={...review,inputHash:hash(JSON.stringify(p.research))};p.draftReview={...review,inputHash:hash(JSON.stringify(p.draft))};
 const analysis={findings:[{id:'crm1',observation:fact,quote:fact,evidenceId:eid,hypothesis:'If reporting capacity is constrained, outside help may be useful.',question:'Is reporting already covered internally?',deliverable:'If useful, a scoped reporting requirements outline.'}],limitations:['No current external buying intent established.']};
 return {p,analysis,eid};
}
async function execute(p:Packet,analysis:ReturnType<typeof fixture>['analysis'],acceptable=true){
 let output:Packet|undefined,next:unknown;const roles:string[]=[];
 const tools:StageTools={ai:{async generate(role,_key,schema,_prompt,input){roles.push(role);return schema.parse(role==='A3'?analysis:{acceptable,issues:acceptable?[]:['Unsupported buying intent'],inputHash:(input as {inputHash:string}).inputHash,verdicts:analysis.findings.map(f=>({claimId:f.id,verdict:'supported',evidenceIds:[f.evidenceId],repair:''}))});}},fetchEvidence:async()=>{throw Error('unexpected_fetch');},search:async()=>{throw Error('unexpected_search');},contact:async()=>{throw Error('unexpected_contact');},relationship:async()=>{throw Error('unexpected_relationship');},specialist:async()=>{throw Error('unexpected_browser');}};
 const job=Job.parse({id:randomUUID(),organization_id:randomUUID(),campaign_id:randomUUID(),opportunity_id:randomUUID(),stage:'S08',business_key:'crm-test',input_hash:hash(p),input_version:1,schema_version:'1',prompt_version:'7',attempt_token:randomUUID(),attempts:1,payload:p});
 await runStage({async rpc(_name,args){output=Packet.parse(args.p_output);next=args.p_next;return true;}},job,tools);
 return {output:output!,next,roles};
}
it('checks CRM facts and proposed scope while preserving the exact checked draft and contact',async()=>{
 const {p,analysis}=fixture(),result=await execute(p,analysis);
 expect(result.roles).toEqual(['A3','A5']);expect(result.output.state).toBe('review_ready');expect(result.next).toBeNull();
 expect(result.output.draft).toEqual(p.draft);expect(result.output.draftReview).toEqual(p.draftReview);expect(result.output.contact).toEqual(p.contact);expect(crmReviewProblems(result.output)).toEqual([]);
 const context=crmContext(p);expect(JSON.stringify(context)).not.toContain('alex@');
 const changed=structuredClone(result.output);changed.crmSupplement!.analysis.findings[0].deliverable='Guaranteed results';expect(crmReviewProblems(changed)).toContain('Review does not match exact input');
 changed.crmSupplement=result.output.crmSupplement;changed.evidence[0].status='closed';expect(crmReviewProblems(changed)).toContain('CRM analysis does not match current research and evidence');
});
it('accepts zero findings, and sends a new opportunity onward only after review',async()=>{
 const {p,analysis}=fixture();analysis.findings=[];delete p.draft;delete p.draftReview;
 const result=await execute(p,analysis);expect(result.roles).toEqual(['A3','A5']);expect(result.output.crmSupplement?.analysis.findings).toEqual([]);expect(crmReviewProblems(result.output)).toEqual([]);expect(result.next).toMatchObject({stage:'S09'});
});
it('repairs quote wrappers on saved analysis without repeating A3 and exposes only cited specialist claims to draft review',async()=>{
 const {p,analysis}=fixture();analysis.findings[0].quote='“'+analysis.findings[0].quote+'”';
 p.crmSupplement={inputHash:crmInputHash(p),analysis};
 const result=await execute(p,analysis);expect(result.roles).toEqual(['A5']);expect(crmReviewProblems(result.output)).toEqual([]);
 expect(result.output.crmSupplement!.analysis.findings[0].quote).toBe(p.research!.claims[0].quote);
 expect(draftResearch(result.output).claims.map(c=>c.id)).toEqual(['c1']);expect(draftResearch(result.output,true).claims.map(c=>c.id)).toEqual(['c1','crm1']);
 result.output.draft!.claimIds.push('crm1');expect(draftResearch(result.output).claims.map(c=>c.id)).toEqual(['c1','crm1']);
});
it('reuses an exact saved review, including rejection, without another model call',async()=>{
 for(const acceptable of [true,false]){
  const {p,analysis}=fixture(),first=await execute(p,analysis,acceptable),replayed=await execute(first.output,analysis);
  expect(replayed.roles).toEqual([]);expect(replayed.output.state).toBe(acceptable?'review_ready':'specialist_exception');
 }
});
it('makes scope conditional without inventing facts and keeps observation verdicts distinct from hypotheses',()=>{
 const {p,analysis,eid}=fixture(),originalScope=analysis.findings[0].deliverable;p.crmSupplement={inputHash:crmInputHash(p),analysis};
 repairCrmCitations(p);const once=structuredClone(p.crmSupplement);repairCrmCitations(p);expect(p.crmSupplement).toEqual(once);
 expect(p.crmSupplement.analysis.findings[0].deliverable).toBe('If the buyer confirms a need for outside support: '+originalScope);
 expect(CrmReview.safeParse({acceptable:true,issues:[],inputHash:'fixture',verdicts:[{claimId:'crm1',verdict:'inference',evidenceIds:[eid],repair:''}]}).success).toBe(false);
});
it('marks a supplement stale safely while a requested re-research has removed the earlier research',async()=>{
 const {p,analysis}=fixture(),result=await execute(p,analysis);delete result.output.research;
 expect(crmReviewProblems(result.output)).toEqual(['CRM research missing']);
});
it('rejects invented quotations before paying for review and preserves the earlier draft',async()=>{
 const {p,analysis}=fixture();analysis.findings[0].quote='The company requests a paid migration.';
 const result=await execute(p,analysis);expect(result.roles).toEqual(['A3']);expect(result.output.state).toBe('specialist_exception');expect(result.next).toBeNull();expect(result.output.draft).toEqual(p.draft);
});
it('keeps a rejected supplement out of downstream drafting and detects evidence or review tampering',async()=>{
 const {p,analysis}=fixture(),result=await execute(p,analysis,false);
 expect(result.output.state).toBe('specialist_exception');expect(result.next).toBeNull();expect(crmReviewProblems(result.output)).toContain('Unsupported buying intent');
 const amended=structuredClone(result.output);amended.crmSupplement!.review!.acceptable=true;amended.crmSupplement!.review!.issues=[];
 amended.evidence[0].origin='provider_reported';amended.crmSupplement!.inputHash=crmInputHash(amended);amended.crmSupplement!.review!.inputHash=hash(crmReviewTarget(amended));
 expect(crmReviewProblems(amended)).toContain('CRM source attribution:crm1');
 const job=Job.parse({id:randomUUID(),organization_id:randomUUID(),campaign_id:randomUUID(),opportunity_id:randomUUID(),stage:'S11',business_key:'stale',input_hash:hash(result.output),input_version:1,schema_version:'1',prompt_version:'7',attempt_token:randomUUID(),attempts:1,payload:result.output});
 await expect(runStage({async rpc(){throw Error('unexpected_save');}},job,{} as StageTools)).rejects.toThrow('crm_review_required');
});
