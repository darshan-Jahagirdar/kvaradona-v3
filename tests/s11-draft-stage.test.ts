import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Packet,Job} from '../src/contracts/pipeline';
import {runStage,type StageTools} from '../src/stages/pipeline';
import {draftMaterial} from '../src/domain/draft-quality';
import {hash} from '../src/domain/policy';

/** Exercises S11 itself through runStage and its persisted successor, not a hand-driven gateway.
 *  Each step is a separate stage invocation consuming the previous packet, as the worker does. */

const host='fixture.invalid',recipient='buyer@fixture.invalid';
const evidenceId=randomUUID();

function packet(extra:Record<string,unknown>={}){
 const p=Packet.parse({mode:'fixture',state:'contact_pending',notes:[],contractVersion:'kvd101',
  evidence:[{id:evidenceId,url:`https://${host}/news`,finalUrl:`https://${host}/news`,accountHost:host,origin:'original',
   source:'original_web',title:'Initiative',contentHash:'h',retrievedAt:new Date().toISOString(),publishedAt:'2026-03-19T00:00:00Z',status:'unknown',
   text:'Fixture Systems announced a website replatform project in March 2026.'}],
  research:{company:'Fixture Systems',accountHost:host,identityBasis:'f',service:'Website journey assessment',
   demand:'plausible',whyNow:'f',offer:'A scoped website journey assessment.',buyerRole:'Owner',
   claims:[{id:'c1',kind:'fact',material:true,text:'Fixture Systems announced a website replatform project in March 2026.',
    quote:'Fixture Systems announced a website replatform project in March 2026.',evidenceId}],
   contrary:[],uncertainties:[],decision:'exploration',reason:'f',watchTrigger:null,specialist:'none',specialistReason:'f',followUp:null},
  packetReview:{acceptable:true,issues:[],verdicts:[{claimId:'c1',verdict:'supported',evidenceIds:[evidenceId],repair:''}],inputHash:'placeholder'},
  contact:{name:'Buyer',role:'Owner',email:recipient,state:'resolved',reason:'r',source:'apollo',candidates:[],
   observedAt:new Date().toISOString(),emailStatus:'provider_verified',employmentEvidence:'e'},
  ...extra});
 // The packet review is bound to the exact research text, as the stage requires.
 p.packetReview!.inputHash=hash(JSON.stringify(p.research));
 return p;
}

const goodDraft=(claimIds=['c1'])=>({subject:'A scoped website review',
 body:'Hello,\n\nFixture Systems announced a website replatform project in March 2026.\n\nWould a scoped review be useful?',
 recipient,sender:null,claimIds});

/** One S11 invocation. Returns the persisted packet and whether a successor job was queued. */
async function step(p:Packet,respond:(role:string,key:string)=>unknown,attempts=1){
 let output:Packet|undefined,next:any,calls:string[]=[];
 const tools={ai:{async generate(role:string,key:string,schema:any,_i:unknown,input:any){
   calls.push(`${role}:${key}`);
   const value=respond(role,key);
   return schema.parse(typeof value==='function'?(value as any)(input):value);
  }},fetchEvidence:async()=>{throw Error('unexpected_fetch');},search:async()=>{throw Error('unexpected_search');},
  contact:async()=>{throw Error('unexpected_contact');},relationship:async()=>'clear',
  specialist:async()=>{throw Error('unexpected_browser');}} as unknown as StageTools;
 const job=Job.parse({id:randomUUID(),organization_id:randomUUID(),campaign_id:randomUUID(),opportunity_id:randomUUID(),
  stage:'S11',business_key:'s11-fixture',input_hash:'h',input_version:1,schema_version:'1',prompt_version:'7',
  attempt_token:randomUUID(),attempts,payload:p});
 await runStage({async rpc(_n,args:any){output=Packet.parse(args.p_output);next=args.p_next;return true;}},job,tools);
 return {output:output!,next,calls};
}

const accept=(input:any)=>({acceptable:true,issues:[],inputHash:input.inputHash,verdicts:[{claimId:'c1',verdict:'supported',evidenceIds:[evidenceId],repair:''}],
 writing:{acceptable:true,issues:[],relevance:'clear',offerClarity:'clear',naturalWriting:'clear',nextStep:'clear'}});

it('recovers from an invalid first output through a persisted successor, with the rejection fed back',async()=>{
 // Attempt 1: A4 cites a claim that does not exist.
 const first=await step(packet(),role=>role==='A4'?goodDraft(['does_not_exist']):accept);
 expect(first.output.draft).toBeUndefined();
 expect(first.output.draftAttempt).toBe(1);
 expect(first.output.rejectedDraft?.reason).toBe('identity_or_claims');
 expect(first.output.rejectedDraft?.citableClaimIds).toContain('c1');
 // Progress is persisted and a successor S11 job is queued, so the worker continues on its own.
 expect(first.next?.stage).toBe('S11');
 expect(first.calls).toEqual(['A4:draft']);

 // Attempt 2 runs under a DIFFERENT operation key and receives the rejection as input.
 let sawFeedback:any=null;
 const second=await step(first.output,(role,key)=>{
  if(role==='A4'){return (input:any)=>{sawFeedback=input;return goodDraft();};}
  return accept;
 });
 expect(second.calls[0]).toBe('A4:draft_attempt_1');
 expect(sawFeedback.rejectedDraft.reason).toBe('identity_or_claims');
 expect(sawFeedback.citableClaimIds).toEqual(['c1']);
 expect(second.output.draft?.recipient).toBe(recipient);
 expect(second.output.draftReview?.acceptable).toBe(true);
 expect(second.output.state).toBe('review_ready');
 expect(second.next).toBeNull();
});

it('stops after the bound and queues no further attempt',async()=>{
 let p=packet(),lastNext:any;
 const keys:string[]=[];
 for(let i=0;i<4;i++){
  const r=await step(p,role=>role==='A4'?goodDraft(['does_not_exist']):accept);
  keys.push(...r.calls);p=r.output;lastNext=r.next;
  if(p.state==='draft_exception')break;
 }
 expect(p.state).toBe('draft_exception');
 // draft, draft_attempt_1, draft_attempt_2 — then no fourth automatic attempt.
 expect(keys.filter(k=>k.startsWith('A4:'))).toEqual(['A4:draft','A4:draft_attempt_1','A4:draft_attempt_2']);
 expect(lastNext).toBeNull();
 expect(p.draftAttempt).toBe(2);
});

it('recovers when the REPAIR is the invalid output, keeping the reviewed version',async()=>{
 // A4 writes an acceptable-looking draft; A5 rejects it; the repair then cites a missing claim.
 const reject=(input:any)=>({acceptable:false,issues:['Overstates the evidence.'],inputHash:input.inputHash,
  verdicts:[{claimId:'c1',verdict:'supported',evidenceIds:[evidenceId],repair:''}],
  writing:{acceptable:true,issues:[],relevance:'clear',offerClarity:'clear',naturalWriting:'clear',nextStep:'clear'}});
 const first=await step(packet(),(role,key)=>{
  if(role==='A4'&&key==='draft')return goodDraft();
  if(role==='A4'&&key==='draft_repair')return goodDraft(['does_not_exist']);
  return reject;
 });
 // The reviewed draft is kept, the invalid repair is recorded, and a successor is queued.
 expect(first.output.draft?.claimIds).toEqual(['c1']);
 expect(first.output.rejectedDraft?.reason).toBe('repair_identity_or_claims');
 expect(first.output.draftAttempt).toBe(1);
 expect(first.next?.stage).toBe('S11');
});

it('redrafts a legacy draft with no recorded basis once research materially changes',async()=>{
 // A preserved draft from before draftBasis existed.
 const legacy=packet({draft:goodDraft(),draftReview:{acceptable:true,issues:[],verdicts:[{claimId:'c1',verdict:'supported',evidenceIds:[evidenceId],repair:''}],inputHash:'stale'}});
 expect(legacy.draftBasis).toBeUndefined();

 // S11 alone must NOT retire it: without a basis there is nothing to compare, so the exact text is
 // reviewed as it stands.
 const reviewed=await step(legacy,()=>accept);
 expect(reviewed.output.draft?.body).toBe(legacy.draft!.body);
 expect(reviewed.calls.every(c=>!c.startsWith('A4:draft'))).toBe(true);

 // Once a basis has been recorded from the packet as found, a material research change retires it.
 const withBasis=packet({draft:goodDraft(),draftBasis:draftMaterial(legacy)});
 const changed=structuredClone(withBasis);
 changed.research!.offer='A different, materially improved offer after new findings.';
 changed.packetReview!.inputHash=hash(JSON.stringify(changed.research));
 const redrafted=await step(changed,role=>role==='A4'?goodDraft():accept);
 expect(redrafted.calls[0]).toBe('A4:draft');
 expect(redrafted.output.notes.join(' ')).toContain('changed materially');

 // An explicit human check-only request is never retired, even with a changed basis.
 const checkOnly=structuredClone(changed);
 checkOnly.draftCheckRequest={requestedAt:new Date().toISOString(),reviewerId:randomUUID()};
 checkOnly.packetReview!.inputHash=hash(JSON.stringify(checkOnly.research));
 const kept=await step(checkOnly,()=>accept);
 expect(kept.output.draft?.body).toBe(withBasis.draft!.body);
 expect(kept.calls.every(c=>!c.startsWith('A4:draft'))).toBe(true);
});
