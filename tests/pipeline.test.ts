import { expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testDatabase,localStore,org,campaign,seed } from './database';
import { Job,Packet,type Research } from '../src/contracts/pipeline';
import { runStage,type StageTools } from '../src/stages/pipeline';
import { campaignProfile,eventKey,hash } from '../src/domain/policy';
it('automatically ingests a fixture source through evidence, two claim checks, contact-pending and a draft',async()=>{
 const db=await testDatabase();try{
 await seed(db);const store=localStore(db),eid=randomUUID();let aiCalls=0;
 const text='Northstar Fixture Systems is migrating to HubSpot and redesigning lead routing in September 2026.';
 const research:Research={company:'Northstar Fixture Systems',accountHost:'northstar.example.invalid',identityBasis:text,service:'HubSpot',demand:'initiative',whyNow:'A dated migration initiative; current delivery status is unknown.',offer:'Offer a small lead-routing implementation outline.',buyerRole:'Revenue Operations lead',claims:[{id:'c1',text,quote:text,evidenceId:eid,kind:'fact',material:true}],contrary:['The team may be delivering internally.'],uncertainties:['Current status and outside support needs are unknown.'],decision:'priority',reason:'A specific relevant initiative.',watchTrigger:null,specialist:'none',specialistReason:'No website problem supports an audit.',followUp:null};
 const candidate={url:'https://northstar.example.invalid/news/hubspot',title:'HubSpot migration',description:text,source:'fixture_search',eventKey:eventKey('https://northstar.example.invalid/news/hubspot'),country:'US',language:'en',discoveredAt:new Date().toISOString()};
 const tools:StageTools={
  ai:{async generate(role,_key,schema,_instructions,input){aiCalls++;const i=input as {inputHash?:string};return schema.parse(role==='A2'?research:role==='A4'?{subject:'HubSpot lead-routing outline',body:'Your September announcement describes a HubSpot migration. Would a short lead-routing implementation outline be useful?',recipient:null,sender:null,claimIds:['c1']}:{writing:{acceptable:true,relevance:'clear',offerClarity:'clear',naturalWriting:'clear',nextStep:'clear',issues:[]},inputHash:i.inputHash,acceptable:true,issues:[],verdicts:[{claimId:'c1',verdict:'supported',evidenceIds:[eid],repair:''}]});}},
  search:async()=>[candidate,candidate],fetchEvidence:async()=>({id:eid,url:candidate.url,finalUrl:candidate.url,title:candidate.title,text,contentHash:hash(text),retrievedAt:new Date().toISOString(),publishedAt:null,source:'fixture',origin:'original',status:'unknown',accountHost:research.accountHost}),
  relationship:async()=> 'unknown',contact:async(_host,role)=>({name:null,role,email:null,emailStatus:'unknown',employmentEvidence:null,source:'fixture_unavailable',observedAt:new Date().toISOString(),state:'contact_pending',reason:'Free quota not verified.'}),
 };
 process.env.KVARA_FIXTURE='1';
 await db.query(`insert into public.jobs(organization_id,campaign_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload) values($1,$2,'discover','S02','fixture',1,'1','1',$3)`,[org,campaign,JSON.stringify(campaignProfile)]);
 for(let step=0;step<10;step++){const raw=await store.rpc('claim_job',{p_worker:'fixture-worker'});if(!raw)break;await runStage(store,Job.parse(raw),tools);}
 const rows=(await db.query<{packet:unknown}>('select packet from public.opportunities where event_key=$1',[candidate.eventKey])).rows;expect(rows).toHaveLength(1);
 const packet=Packet.parse(rows[0].packet);expect(packet.mode).toBe('fixture');expect(packet.state).toBe('contact_pending');expect(packet.draftReview?.acceptable).toBe(true);expect(packet.draft?.recipient).toBe(null);expect(aiCalls).toBe(4);
 expect((await db.query('select * from public.provider_operations')).rows).toHaveLength(0);
 expect((await db.query('select * from public.evidence')).rows).toHaveLength(1);
 }finally{delete process.env.KVARA_FIXTURE;await db.close();}
});
