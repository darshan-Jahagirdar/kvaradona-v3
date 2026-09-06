import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {testDatabase,seed,enqueue,localStore} from './database';
import {Job,Packet} from '../src/contracts/pipeline';
import {runStage,type StageTools} from '../src/stages/pipeline';
import {contactPending,hash} from '../src/domain/policy';
import {draftReviewContext} from '../src/domain/review-context';
it('reuses the exact checked draft when contact is unchanged and invalidates its review for a new recipient',async()=>{
 const eid=randomUUID(),fact='Fixture Systems announced a CRM migration.';
 const p=Packet.parse({mode:'fixture',state:'contact_pending',evidence:[{id:eid,url:'https://fixture.invalid/news',finalUrl:'https://fixture.invalid/news',title:'Migration',text:fact,contentHash:hash(fact),retrievedAt:new Date().toISOString(),publishedAt:null,source:'fixture',origin:'original',status:'unknown',accountHost:'fixture.invalid'}],research:{company:'Fixture Systems',accountHost:'fixture.invalid',identityBasis:fact,service:'CRM',demand:'initiative',whyNow:fact,offer:'Offer an implementation outline.',buyerRole:'Revenue Operations lead',claims:[{id:'c1',text:fact,quote:fact,evidenceId:eid,kind:'fact',material:true}],contrary:[],uncertainties:['Delivery status unknown.'],decision:'exploration',reason:'Relevant initiative.',watchTrigger:null,specialist:'none',specialistReason:'No specialist question.',followUp:null},draft:{subject:'CRM outline',body:'Would a short implementation outline help?',recipient:null,sender:null,claimIds:['c1']},contact:contactPending('Revenue Operations lead','Fixture')});
 const review={acceptable:true,issues:[],verdicts:[{claimId:'c1',verdict:'supported',evidenceIds:[eid],repair:''}]};
 p.packetReview={...review,inputHash:hash(JSON.stringify(p.research))} as Packet['packetReview'];p.draftReview={...review,inputHash:hash(JSON.stringify(p.draft))} as Packet['draftReview'];
 const extended=structuredClone(p);extended.evidence[0].text='x'.repeat(6000)+fact;
 const compact=draftReviewContext(extended);expect(compact.evidence[0].text).toContain(fact);expect(compact.evidence[0].text.length).toBeLessThan(extended.evidence[0].text.length);expect(extended.evidence[0].text).toBe('x'.repeat(6000)+fact);
 for(const resolved of [false,true]){
  let output:Packet|undefined,next:unknown;const store={async rpc(_name:string,args:Record<string,unknown>){output=Packet.parse(args.p_output);next=args.p_next;return true;}};
  const tools:StageTools={ai:{async generate(){throw Error('unexpected_model_call');}},fetchEvidence:async()=>{throw Error('unexpected_fetch');},search:async()=>[],relationship:async()=>'unknown',contact:async()=>resolved?{...p.contact!,email:'alex@fixture.invalid',name:'Alex Tester',emailStatus:'provider_verified',state:'resolved'}:p.contact!};
  const job=Job.parse({id:randomUUID(),organization_id:randomUUID(),campaign_id:randomUUID(),opportunity_id:randomUUID(),stage:'S10',business_key:'contact-refresh',input_hash:hash(p),input_version:1,schema_version:'1',prompt_version:'5',attempt_token:randomUUID(),attempts:1,payload:structuredClone(p)});
  await runStage(store,job,tools);expect(output!.draft?.body).toBe(p.draft!.body);
  if(resolved){expect(output!.draft?.recipient).toBe('alex@fixture.invalid');expect(output!.draftReview).toBeUndefined();expect(next).toMatchObject({stage:'S11',business_key:`${job.opportunity_id}:S11:1:${hash(output)}`});}else{expect(output!.draftReview).toEqual(p.draftReview);expect(next).toBeNull();}
 }
});
it('counts held free credits against the allowance while zero-credit search remains usable',async()=>{
 const db=await testDatabase();try{
  await seed(db);await enqueue(db);const store=localStore(db),job=Job.parse(await store.rpc('claim_job',{p_worker:'fixture'}));
  await db.exec(`update public.budget set live_enabled=true;update public.provider_limits set free_units=1,authenticated=true,usable=true,verified_at=now(),expires_at=now()+interval '1 hour' where provider='apollo';`);
  const reserve=(key:string,units:number)=>store.rpc('reserve_operation',{p_job:job.id,p_token:job.attempt_token,p_key:key,p_provider:'apollo',p_hash:key,p_max:'0',p_units:units});
  const op=await reserve('email',1) as {id:string};await store.rpc('dispatch_operation',{p_operation:op.id,p_job:job.id,p_token:job.attempt_token});
  await expect(reserve('another-email',1)).rejects.toThrow('free_quota');await reserve('search',0);
  expect((await db.query<{sum:string}>('select sum(units)::text from public.provider_operations')).rows[0].sum).toBe('1');
 }finally{await db.close();}
});
