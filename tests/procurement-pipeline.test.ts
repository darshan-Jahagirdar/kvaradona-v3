import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {testDatabase,seed,localStore,campaign,org,opportunity,user,otherUser} from './database';
import {Job,Packet,type Research} from '../src/contracts/pipeline';
import {ProcurementNotice} from '../src/contracts/procurement';
import {runStage,type StageTools} from '../src/stages/pipeline';
import {hash} from '../src/domain/policy';
import {procurementIdentity,procurementDraftProblems} from '../src/domain/procurement';
import {normalizeContractsFinder} from '../src/providers/contracts-finder';
import {collectProcurement} from '../src/capture/procurement';
const migration='supabase/migrations/20260906173152_pipeline_completion.sql';
const text='The Example Council requires a CRM implementation discovery and lead routing design. Responses must explain the proposed approach. Send the response through the nominated supplier portal.';
function notice(){return ProcurementNotice.parse({source:'contracts_finder',noticeId:'ocds-fixture-1',solicitationNumber:'CRM-1',buyer:'Example Council',buyerCode:'COUNCIL-1',title:'CRM implementation discovery',url:'https://example.invalid/notice/1',postedAt:new Date().toISOString(),observedAt:new Date().toISOString(),type:'Solicitation',baseType:'tender',active:'yes',deadlineRaw:'2027-01-01T00:00:00Z',deadlineUtc:'2027-01-01T00:00:00Z',archiveDate:null,setAside:null,naics:null,awarded:false,descriptionUrl:null,attachmentUrls:[],description:text,snapshotHash:hash(text)});}
async function setup(){const db=await testDatabase();await db.exec(await readFile('supabase/migrations/20260906154157_complementary_discovery.sql','utf8'));await db.exec(await readFile(migration,'utf8'));await seed(db);return db;}
it('takes automatic procurement discovery through source, packet check, response matrix and A5 without Apollo or website calls; resumes persisted jobs',async()=>{
 const db=await setup();try{const store=localStore(db),n=notice(),result=await collectProcurement(n);let calls:string[]=[];
 const e=result.evidence[1],research:Research={company:n.buyer!,accountHost:procurementIdentity(n),identityBasis:'Named buyer in original publication',service:'CRM',demand:'external_demand',whyNow:'Published procurement request',offer:'A conditional CRM discovery approach',buyerRole:'Procurement team',claims:[{id:'c1',text:'The notice requests CRM discovery.',kind:'fact',quote:'The Example Council requires a CRM implementation discovery and lead routing design.',evidenceId:e.id,material:true}],contrary:[],uncertainties:['Eligibility and legal bidder details unverified.'],decision:'priority',reason:'Original specific request',watchTrigger:null,specialist:'none',specialistReason:'No website audit required',followUp:null};
 const tools:StageTools={ai:{async generate(role,key,schema,_instructions,input){calls.push(role);const i=input as {inputHash:string};return schema.parse(role==='A2'?research:role==='A4'?{subject:'CRM discovery response outline',body:'We propose validating the CRM requirements before implementation. Bidder details and eligibility remain to be supplied.',recipient:null,sender:null,claimIds:['c1'],procurement:{requirements:[{requirement:'Explain the proposed approach',quote:'Responses must explain the proposed approach.',evidenceId:e.id,response:'Propose a requirements workshop, conditional on confirmed scope.',status:'proposed_approach'}],responseRoute:null,missingInputs:['Legal bidder details and eligibility require confirmation.']}}:{acceptable:true,issues:[],inputHash:i.inputHash,verdicts:[{claimId:'c1',verdict:'supported',evidenceIds:[e.id],repair:''}]});}},search:async()=>{throw Error('unexpected_search');},procurementSearch:async()=>[n,n],procurementEvidence:async()=>result,fetchEvidence:async()=>{throw Error('unexpected_web_fetch');},contact:async()=>{throw Error('unexpected_apollo');},relationship:async()=>{throw Error('unexpected_relationship');}};
 await db.query('update public.campaigns set profile=$1 where id=$2',[JSON.stringify({groups:[{source:'contracts_finder',country:'GB',language:'en',region:'Europe'}],maxResearch:1}),campaign]);
 process.env.KVARA_FIXTURE='1';await store.rpc('queue_discovery',{p_campaign:campaign});
 for(let i=0;i<2;i++){const job=Job.parse(await store.rpc('claim_job',{p_worker:'first-process'}));await runStage(store,job,tools);}
 expect((await db.query("select id from public.jobs where status='queued'")).rows).toHaveLength(1);
 // A new executor resumes persisted stage output, without another discovery or document collection.
 for(let i=0;i<8;i++){const raw=await store.rpc('claim_job',{p_worker:'restarted-process'});if(!raw)break;await runStage(store,Job.parse(raw),tools);}
 const packet=Packet.parse((await db.query<{packet:unknown}>("select packet from public.opportunities where event_key=$1",[hash([n.source,n.noticeId])])).rows[0].packet);
 expect(packet.state).toBe('procurement_review_ready');expect(packet.draft?.procurement?.requirements).toHaveLength(1);expect(packet.draftReview?.acceptable).toBe(true);expect(calls).toEqual(['A2','A5','A4','A5']);expect(procurementDraftProblems(packet)).toEqual([]);
 packet.draft!.procurement!.requirements[0].quote='Invented instructions';expect(procurementDraftProblems(packet).length).toBeGreaterThan(0);
 }finally{delete process.env.KVARA_FIXTURE;await db.close();}
});
it('updates an amended notice once, archives exact prior packet, fences stale work and retains tenant-protected history',async()=>{
 const db=await setup();try{const store=localStore(db),n=notice();const profile={groups:[{source:'contracts_finder',country:'GB',language:'en'}],maxResearch:0};await db.query('update public.campaigns set profile=$1 where id=$2',[JSON.stringify(profile),campaign]);
 const ingest=async(notice:ReturnType<typeof nCopy>)=>{await store.rpc('queue_discovery',{p_campaign:campaign});const j=Job.parse(await store.rpc('claim_job',{p_worker:'fixture'}));return store.rpc('ingest_discovery',{p_job:j.id,p_token:j.attempt_token,p_candidates:[{url:notice.url,title:notice.title,source:notice.source,eventKey:hash([notice.source,notice.noticeId]),procurementNotice:notice}],p_report:{mode:'fixture',maxResearch:0}});};function nCopy(){return n;}
 await ingest(n);await ingest({...n,observedAt:new Date().toISOString()});expect((await db.query('select * from public.opportunity_source_versions')).rows).toHaveLength(0);
 await ingest({...n,title:'Changed requirement',snapshotHash:hash('amendment')});const versions=(await db.query<{snapshot:Packet}>('select * from public.opportunity_source_versions')).rows;expect(versions).toHaveLength(1);expect(versions[0].snapshot.candidate?.procurementNotice?.title).toBe(n.title);
 await ingest({...n,postedAt:'2020-01-01T00:00:00Z'});await ingest({...n,title:'Changed requirement',snapshotHash:hash('amendment')});expect((await db.query('select * from public.opportunity_source_versions')).rows).toHaveLength(1);
 expect((await db.query<{revision:number}>('select revision from public.opportunities where event_key=$1',[hash([n.source,n.noticeId])])).rows[0].revision).toBe(2);
 await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${otherUser}',false);`);expect((await db.query('select * from public.opportunity_source_versions')).rows).toHaveLength(0);await db.exec('reset role');await db.exec(await readFile('supabase/recovery/008_pipeline_completion.sql','utf8'));expect((await db.query('select * from public.opportunity_source_versions')).rows).toHaveLength(1);
 }finally{await db.close();}
});
it('binds human labels to exact snapshot, rejects stale and cross-tenant writes, and replays only identical requests',async()=>{
 const db=await setup();try{const store=localStore(db),row=(await db.query<{packet_hash:string}>('select packet_hash from public.opportunities where id=$1',[opportunity])).rows[0];await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${user}',false);`);
 const args={p_id:opportunity,p_revision:1,p_hash:row.packet_hash,p_request:randomUUID(),p_labels:{serviceRelevance:'unclear',factualSupport:'unknown',offerUsefulness:'unknown',buyerFit:'unknown',editsRequired:'no_draft',note:'Synthetic test, not a marketing quality judgment.',reviewSeconds:20}};
 const first=await store.rpc('label_opportunity',args);expect(await store.rpc('label_opportunity',args)).toBe(first);
 await expect(store.rpc('label_opportunity',{...args,p_labels:{...args.p_labels,note:'Different'}})).rejects.toThrow('request_key_conflict');
 await expect(store.rpc('label_opportunity',{...args,p_request:randomUUID(),p_hash:'stale'})).rejects.toThrow('stale_version');
 await db.exec(`select set_config('request.jwt.claim.sub','${otherUser}',false);`);await expect(store.rpc('label_opportunity',{...args,p_request:randomUUID()})).rejects.toThrow('not_found');expect((await db.query('select * from public.quality_labels')).rows).toHaveLength(0);
 }finally{await db.close();}
});
it('normalizes latest OCDS notices and holds scanned/unsupported or missing source attachments honestly',async()=>{
 const n=normalizeContractsFinder({releases:[{ocid:'test',id:'release1',date:'2026-09-01T00:00:00Z',buyer:{id:'buyer',name:'Example Council'},tender:{title:'CRM implementation',description:text,status:'active',tenderPeriod:{endDate:'2026-10-01T12:00:00+01:00'},documents:[]}}]},new Date().toISOString())[0];expect(n.deadlineUtc).toBe('2026-10-01T11:00:00.000Z');expect(n.buyerCode).toBe('buyer');
 const collected=await collectProcurement({...n,attachmentUrls:['https://example.invalid/requirements.docx']},async(url)=>({url,status:200,text:'',bytes:Buffer.from('unsupported'),contentType:'application/octet-stream',robotsHeader:''}));expect(collected.documents.missing).toHaveLength(1);expect(collected.evidence).toHaveLength(2);
});
it('holds an out-of-catalogue procurement requirement before further model spend',async()=>{
 const n={...notice(),title:'PR agent for a Digital Transformation Fund event',description:'The council requires a public relations agency and event management for its Digital Transformation Fund celebration.'};
 let output:unknown;const store={async rpc(_name:string,args:Record<string,unknown>){output=args.p_output;return true;}};
 const packet=Packet.parse({candidate:{url:n.url,title:n.title,description:n.description,source:n.source,eventKey:'mismatch',country:'GB',language:'en',discoveredAt:n.observedAt,procurementNotice:n},evidence:[],state:'discovered',mode:'fixture'});
 await runStage(store,{id:randomUUID(),organization_id:org,campaign_id:campaign,opportunity_id:opportunity,stage:'S04',business_key:'mismatch',input_hash:'fixture',input_version:1,schema_version:'1',prompt_version:'10',attempt_token:randomUUID(),attempts:1,payload:packet},{ai:{async generate(){throw Error('unexpected_model');}},search:async()=>[],fetchEvidence:async()=>{throw Error('unexpected_source');},relationship:async()=> 'unknown',contact:async()=>{throw Error('unexpected_contact');}});
 expect(Packet.parse(output).state).toBe('service_mismatch');
});
