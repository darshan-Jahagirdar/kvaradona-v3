import {it,expect} from 'vitest';
import type {PGlite} from '@electric-sql/pglite';
import {migratedDatabase,asUser,org,otherOrg,user,otherUser,campaign} from './database';

/** A company that already has checked research, a preserved draft and an unresolved contact: the
 *  v4c.ai shape after the first acceptance run. Re-running research for it would throw away work a
 *  reviewer already accepted. */
const RESEARCHED='40000000-0000-4000-8000-0000000000c1';
/** A reviewer-selected careers record whose company is unknown and whose question is posted. */
const UNIDENTIFIED='40000000-0000-4000-8000-0000000000c2';
const E='60000000-0000-4000-8000-0000000000e1';
const RUN='70000000-0000-4000-8000-000000000001';

const researchedPacket={mode:'live',state:'contact_pending',evidence:[{id:E}],
 research:{company:'Fixture Systems',accountHost:'fixture.invalid'},
 packetReview:{acceptable:true},
 contact:{state:'contact_pending'},
 draft:{subject:'s',body:'b',recipient:null,sender:null,claimIds:[]}};
const unidentifiedPacket={mode:'live',state:'source_pending',evidence:[],
 pendingResolution:{reason:'identity_unresolved',detail:'No structured employer identity.',attempts:2,
  nextAction:'ask_reviewer',question:'Which company does this listing belong to?',at:'2026-09-21T00:00:00Z'}};

async function seedRecovery(db:PGlite){
 await db.query(`insert into auth.users values($1,'reviewer@example.invalid'),($2,'other@example.invalid')`,[user,otherUser]);
 await db.query(`insert into public.organizations(id,name) values($1,'Fixture company'),($2,'Other tenant')`,[org,otherOrg]);
 await db.query(`insert into public.memberships values($1,$2,'admin'),($3,$4,'admin')`,[org,user,otherOrg,otherUser]);
 await db.query(`insert into public.campaigns(id,organization_id,name,profile,paused) values($1,$2,'Selected cohort','{}',false)`,[campaign,org]);
 await db.query(`insert into public.opportunities(id,organization_id,campaign_id,event_key,packet,state) values
  ($1,$2,$3,'researched',$5,'contact_pending'),($4,$2,$3,'unidentified',$6,'source_pending')`,
  [RESEARCHED,org,campaign,UNIDENTIFIED,JSON.stringify(researchedPacket),JSON.stringify(unidentifiedPacket)]);
 await db.query(`update public.budget set live_enabled=true,dollar_limits_enabled=false where id=1`);
 await db.query(`update public.provider_limits set verified_at=now(),probe_enabled=true where provider in('openai','brave')`);
}
/** An active selected run that both companies belong to. */
async function seedRun(db:PGlite,members:string[]=[RESEARCHED,UNIDENTIFIED]){
 await db.query(`insert into public.workflow_runs(id,organization_id,campaign_id,request_key,requested_by,mode,status,expires_at)
  values($1,$2,$3,gen_random_uuid(),$4,'selected','active',now()+interval '4 hours')`,[RUN,org,campaign,user]);
 for(const m of members)
  await db.query(`insert into public.workflow_run_members(run_id,organization_id,opportunity_id,entry_revision,entry_state,queued_stage)
   values($1,$2,$3,1,'contact_pending','S10')`,[RUN,org,m]);
}
const review=(db:PGlite,id:string,revision:number,key:string,action:string,note:string,input:unknown=null,draft:unknown=null)=>
 db.query<{value:any}>(
  `select public.review_opportunity(p_id=>$1,p_revision=>$2,p_request=>$3,p_action=>$4,p_note=>$5,p_draft=>$7::jsonb,p_input=>$6::jsonb) as value`,
  [id,revision,key,action,note,input===null?null:JSON.stringify(input),draft===null?null:JSON.stringify(draft)]);
const jobFor=(db:PGlite,id:string)=>db.query<{stage:string;run_id:string|null;payload:any}>(
 `select stage,run_id,payload from public.jobs where opportunity_id=$1 order by created_at desc limit 1`,[id]);

it('resumes a selected run at the stage the packet actually needs, not at research',async()=>{
 const db=await migratedDatabase();await seedRecovery(db);
 const entry=await db.query<{stage:string}>(`select private.selected_entry_stage($1::jsonb) as stage`,[JSON.stringify(researchedPacket)]);
 // Checked research and a preserved draft mean the affected step is the contact, not A2 again.
 expect(entry.rows[0].stage).toBe('S10');
 const bare=await db.query<{stage:string}>(`select private.selected_entry_stage($1::jsonb) as stage`,[JSON.stringify(unidentifiedPacket)]);
 expect(bare.rows[0].stage).toBe('S04');

 // The ordinary launch path uses it, so a normal selected recovery queues S10 for this company.
 const launched=await asUser(db,user,()=>db.query<{value:any}>(
  `select public.start_selected_workflow(p_organization=>$1,p_opportunities=>$2::uuid[],p_request=>$3) as value`,
  [org,[RESEARCHED],'50000000-0000-4000-8000-000000000021']));
 expect(launched.rows[0].value.queued).toBe(1);
 expect((await jobFor(db,RESEARCHED)).rows[0].stage).toBe('S10');
 // The saved research and draft travel into the job unchanged: nothing is re-derived.
 const payload=(await jobFor(db,RESEARCHED)).rows[0].payload;
 expect(payload.research.company).toBe('Fixture Systems');
 expect(payload.draft.subject).toBe('s');
 await db.close();
});

it('keeps selected-run membership and authority on an ordinary reviewer recovery',async()=>{
 const db=await migratedDatabase();await seedRecovery(db);await seedRun(db);
 const revision=(await db.query<{revision:number}>(`select revision from public.opportunities where id=$1`,[RESEARCHED])).rows[0].revision;
 await asUser(db,user,()=>review(db,RESEARCHED,revision,'50000000-0000-4000-8000-000000000031','research','What does their services path ask a visitor to do?',null,researchedPacket.draft));
 const job=(await jobFor(db,RESEARCHED)).rows[0];
 // The recovery job belongs to the run, so the run's membership, persona policy and finite contact
 // window apply instead of campaign defaults.
 expect(job.run_id).toBe(RUN);
 expect(job.payload.recovery.reason).toBe('selected_run');
 expect(job.payload.recovery.selectedRun).toBe(RUN);
 // The action that asked for it is preserved separately.
 expect(job.payload.recovery.origin).toBe('question');
 expect(job.payload.researchRequest.question).toContain('services path');
 await db.close();
});

it('does not attach a run to a company that is not a member of one',async()=>{
 const db=await migratedDatabase();await seedRecovery(db);await seedRun(db,[UNIDENTIFIED]);
 const revision=(await db.query<{revision:number}>(`select revision from public.opportunities where id=$1`,[RESEARCHED])).rows[0].revision;
 await asUser(db,user,()=>review(db,RESEARCHED,revision,'50000000-0000-4000-8000-000000000041','research','Check the services path once more, please.',null,researchedPacket.draft));
 const job=(await jobFor(db,RESEARCHED)).rows[0];
 expect(job.run_id).toBeNull();
 expect(job.payload.recovery.reason).toBe('question');
 expect(job.payload.recovery.selectedRun).toBeNull();
 await db.close();
});

it('records a reviewer identity answer as an unverified hint and resumes the affected stage',async()=>{
 const db=await migratedDatabase();await seedRecovery(db);await seedRun(db);
 const revision=(await db.query<{revision:number}>(`select revision from public.opportunities where id=$1`,[UNIDENTIFIED])).rows[0].revision;
 await asUser(db,user,()=>review(db,UNIDENTIFIED,revision,'50000000-0000-4000-8000-000000000051','identify_company',
  'This listing is the Example Employer careers board.',{name:'Example Employer',domain:'example-employer.test'}));
 const job=(await jobFor(db,UNIDENTIFIED)).rows[0];
 expect(job.stage).toBe('S04');
 expect(job.run_id).toBe(RUN);
 // The answer is stored as a hint to be VERIFIED, never as an established company.
 expect(job.payload.identityHint).toMatchObject({name:'Example Employer',domain:'example-employer.test',status:'unverified'});
 expect(job.payload.candidate?.providerCompany).toBeUndefined();
 // Answering supersedes the posted question rather than leaving it up.
 expect(job.payload.pendingResolution.question).toBeUndefined();
 expect(job.payload.pendingResolution.nextAction).toBe('retry_resolution');
 expect(job.payload.pendingResolution.attempts).toBe(0);
 // The reviewer's action is recorded as a review, with the structured input in its payload.
 const reviews=await db.query<{action:string;request_payload:any}>(`select action,request_payload from public.reviews where opportunity_id=$1`,[UNIDENTIFIED]);
 expect(reviews.rows[0].action).toBe('identify_company');
 expect(reviews.rows[0].request_payload.input.domain).toBe('example-employer.test');
 await db.close();
});

it('refuses an identity answer with no open question, a bad domain, a stale version or another tenant',async()=>{
 const db=await migratedDatabase();await seedRecovery(db);await seedRun(db);
 const answer={name:'Example Employer',domain:'example-employer.test'};
 const revision=(await db.query<{revision:number}>(`select revision from public.opportunities where id=$1`,[UNIDENTIFIED])).rows[0].revision;
 // The researched company has no identity question posted.
 const researchedRevision=(await db.query<{revision:number}>(`select revision from public.opportunities where id=$1`,[RESEARCHED])).rows[0].revision;
 await expect(asUser(db,user,()=>review(db,RESEARCHED,researchedRevision,'50000000-0000-4000-8000-000000000061','identify_company','Answering an unasked question.',answer,researchedPacket.draft)))
  .rejects.toThrow(/no_open_identity_question/);
 await expect(asUser(db,user,()=>review(db,UNIDENTIFIED,revision,'50000000-0000-4000-8000-000000000062','identify_company','A note.',{name:'Example Employer',domain:'not a domain'})))
  .rejects.toThrow(/identity_domain_invalid/);
 await expect(asUser(db,user,()=>review(db,UNIDENTIFIED,revision,'50000000-0000-4000-8000-000000000063','identify_company','A note.',{name:'',domain:'example-employer.test'})))
  .rejects.toThrow(/identity_answer_required/);
 await expect(asUser(db,user,()=>review(db,UNIDENTIFIED,revision+5,'50000000-0000-4000-8000-000000000064','identify_company','A note.',answer)))
  .rejects.toThrow(/stale_version/);
 await expect(asUser(db,otherUser,()=>review(db,UNIDENTIFIED,revision,'50000000-0000-4000-8000-000000000065','identify_company','A note.',answer)))
  .rejects.toThrow(/not_found/);
 // Nothing was queued by any refused attempt.
 expect((await db.query<{n:number}>(`select count(*)::int as n from public.jobs where opportunity_id=$1`,[UNIDENTIFIED])).rows[0].n).toBe(0);
 await db.close();
});

it('still holds an uncertain provider operation on the stage a recovery would resume',async()=>{
 const db=await migratedDatabase();await seedRecovery(db);await seedRun(db);
 const job=(await db.query<{id:string}>(`insert into public.jobs(organization_id,campaign_id,opportunity_id,business_key,stage,input_hash,input_version,schema_version,prompt_version,payload,status)
  values($1,$2,$3,'held','S04','h',1,'kvd101','kvd101','{}','failed') returning id`,[org,campaign,UNIDENTIFIED])).rows[0].id;
 await db.query(`insert into public.provider_operations(organization_id,campaign_id,job_id,opportunity_id,operation_key,provider,request_hash,state,reserved_usd,units)
  values($1,$4,$2,$3,'held:contact_search','apollo','h','ambiguous',0,0)`,[org,job,UNIDENTIFIED,campaign]);
 const revision=(await db.query<{revision:number}>(`select revision from public.opportunities where id=$1`,[UNIDENTIFIED])).rows[0].revision;
 await expect(asUser(db,user,()=>review(db,UNIDENTIFIED,revision,'50000000-0000-4000-8000-000000000071','identify_company','A note.',{name:'Example Employer',domain:'example-employer.test'})))
  .rejects.toThrow(/ambiguous_operation_hold/);
 await db.close();
});

it('reverts proportionally: routing returns, recorded answers are kept',async()=>{
 const db=await migratedDatabase();await seedRecovery(db);await seedRun(db);
 const {readFile}=await import('node:fs/promises');
 const rollback=await readFile('supabase/recovery/023_selected_recovery_routing_rollback.sql','utf8');

 // With no recorded answer, the constraint narrows again and the routing returns exactly.
 await db.exec(rollback);
 const entry=await db.query<{stage:string}>(`select private.selected_entry_stage($1::jsonb) as stage`,[JSON.stringify(researchedPacket)]);
 expect(entry.rows[0].stage).toBe('S06');
 expect((await db.query(`select to_regprocedure('public.review_opportunity(uuid,integer,uuid,text,text,jsonb,jsonb)') as f`)).rows[0]).toEqual({f:null});
 // The ordinary six-argument command still works after the revert.
 const revision=(await db.query<{revision:number}>(`select revision from public.opportunities where id=$1`,[UNIDENTIFIED])).rows[0].revision;
 await asUser(db,user,()=>db.query(
  `select public.review_opportunity(p_id=>$1,p_revision=>$2,p_request=>$3,p_action=>'research',p_note=>$4,p_draft=>null)`,
  [UNIDENTIFIED,revision,'50000000-0000-4000-8000-000000000081','Who publishes this careers board?']));
 const job=(await jobFor(db,UNIDENTIFIED)).rows[0];
 expect(job.stage).toBe('S04');
 // Pre-migration behaviour: the recovery job carries no run.
 expect(job.run_id).toBeNull();
 await db.close();

 // With an answer already recorded, the constraint is kept rather than deleting that history.
 const db2=await migratedDatabase();await seedRecovery(db2);await seedRun(db2);
 const r2=(await db2.query<{revision:number}>(`select revision from public.opportunities where id=$1`,[UNIDENTIFIED])).rows[0].revision;
 await asUser(db2,user,()=>review(db2,UNIDENTIFIED,r2,'50000000-0000-4000-8000-000000000091','identify_company',
  'This listing is the Example Employer careers board.',{name:'Example Employer',domain:'example-employer.test'}));
 // The guard refuses while the run's work is still live, which is the point of it.
 await expect(db2.exec(rollback)).rejects.toThrow(/selected_run_still_active/);
 // The script runs as one transaction, so the refused attempt leaves nothing half-applied.
 await db2.exec('rollback');
 await db2.query(`update public.jobs set status='failed' where status in ('queued','running')`);
 await db2.exec(rollback);
 const kept=await db2.query<{n:number}>(`select count(*)::int as n from public.reviews where action='identify_company'`);
 expect(kept.rows[0].n).toBe(1);
 // The recorded packet keeps the hint and the run it belonged to; nothing was deleted to fit.
 const packet=(await db2.query<{packet:any}>(`select packet from public.opportunities where id=$1`,[UNIDENTIFIED])).rows[0].packet;
 expect(packet.identityHint.name).toBe('Example Employer');
 expect(packet.recovery.selectedRun).toBe(RUN);
 await db2.close();
});

// ---------------------------------------------------------------------------------------------
// A soft classification warning: from the saved state, through actual selected entry, into research.
// ---------------------------------------------------------------------------------------------

const CLASSIFY='40000000-0000-4000-8000-0000000000c3';
const now='2026-09-21T00:00:00Z';
/** The saved VentureBeat shape: assessment stopped with a historical description warning and no
 *  evidence at all, so nothing had been researched when the run ended. */
const classificationPacket={mode:'live',state:'company_assessment_pending',notes:[],evidence:[],
 eligibility:{basis:'user_accepted_cohort',cohort:'selected run',
  acceptedNote:'Chosen by a reviewer for this selected-company run.',employeeRange:{min:200},countries:['US']},
 candidate:{url:'https://venturebeat.com',title:'VentureBeat',description:'Technology news',source:'explorium',
  eventKey:'k',country:'US',language:'en',discoveredAt:now,
  providerCompany:{provider:'explorium',id:'v'.repeat(32),kind:'provider_reported',name:'VentureBeat',
   domain:'venturebeat.com',headquartersCountry:'united states',employees:null,employeeRange:'201-500',industry:'Media',
   observedAt:now,sourceUrl:'https://api.explorium.ai/v2/businesses',
   provenance:{name:'name',domain:'domain',headquartersCountry:'country_name',employees:'number_of_employees_range',industry:'naics_description'},
   icp:{status:'unknown',reasons:['Reported headquarters is in an approved country.'],
    unknowns:['Company description may conflict with the requested industry classification; human assessment required.'],searchCountry:'US'},
   intent:{status:'provider_reported',reason:'topic research',topics:[{topic:'media & advertising: pardot',score:73,sourceDate:null}]}}}};

it('carries the saved classification state through selected entry into bounded research',async()=>{
 const db=await migratedDatabase();await seedRecovery(db);
 const {runStage}=await import('../src/stages/pipeline');
 const {Packet,Job}=await import('../src/contracts/pipeline');
 const {randomUUID}=await import('node:crypto');

 // The real entry function selects the assessment stage for this saved packet.
 const entry=await db.query<{stage:string}>(`select private.selected_entry_stage($1::jsonb) as stage`,[JSON.stringify(classificationPacket)]);
 expect(entry.rows[0].stage).toBe('S05');

 const about={id:randomUUID(),url:'https://venturebeat.com/about',finalUrl:'https://venturebeat.com/about',
  accountHost:'venturebeat.com',title:'About VentureBeat',contentHash:'h',retrievedAt:new Date().toISOString(),
  publishedAt:null,source:'original_web',origin:'original',status:'unknown',
  // A substantive page that carries NO structured industry field, which is the ordinary case.
  text:'VentureBeat covers transformative technology for business decision makers and runs events for that audience. '.repeat(4)};
 const candidate={url:'https://venturebeat.com/about',title:'About VentureBeat',description:'About',
  source:'brave',eventKey:'about',country:'US',language:'en',discoveredAt:now};
 const run=async(stage:string,packet:any)=>{
  let output:any,next:any;
  const job=Job.parse({id:randomUUID(),organization_id:randomUUID(),campaign_id:randomUUID(),opportunity_id:randomUUID(),
   stage,business_key:`classify-${stage}`,input_hash:'h',input_version:1,schema_version:'1',prompt_version:'7',
   attempt_token:randomUUID(),attempts:1,payload:packet});
  await runStage({async rpc(_n:string,args:any){output=Packet.parse(args.p_output);next=args.p_next;return true;}},job,
   {ai:{generate:async()=>{throw Error('unexpected_model_call');}},
    fetchEvidence:async()=>structuredClone(about) as any,
    search:async()=>[candidate as any],
    relationship:async()=>'clear',contact:async()=>{throw Error('unexpected_contact');}} as any);
  return {output,next};
 };

 // S05: evidence is retained, the warning stays open and answerable, and the company PROCEEDS.
 const assessment=await run('S05',Packet.parse(classificationPacket));
 expect(assessment.output.factResolution.evidenceCanResolve).toBe(true);
 expect(assessment.output.factResolution.classificationStatus).toBe('provisional');
 expect(assessment.output.evidence.length).toBeGreaterThan(0);
 expect(assessment.output.state).toBe('facts_provisional');
 expect(assessment.next).toMatchObject({stage:'S04'});
 // Nothing was certified: the provider's warning is still recorded as an open question.
 expect(assessment.output.factResolution.questions.join(' ')).toContain('may conflict');

 // A recovery of THAT state resumes at company context, not back at the assessment it completed.
 const resume=await db.query<{stage:string}>(`select private.selected_entry_stage($1::jsonb) as stage`,[JSON.stringify(assessment.output)]);
 expect(resume.rows[0].stage).toBe('S04');

 // S04: bounded company context runs and the company reaches research.
 const context=await run('S04',assessment.output);
 expect(context.output.contextSearch).toBeDefined();
 expect(context.output.state).toBe('evidence_collected');
 expect(context.next).toMatchObject({stage:'S06'});
 await db.close();
});

it('stops when the company\'s own published industry contradicts the configured one',async()=>{
 const {resolveCompanyFacts}=await import('../src/domain/fact-resolution');
 const {Packet}=await import('../src/contracts/pipeline');
 const {hash}=await import('../src/domain/policy');
 const {randomUUID}=await import('node:crypto');
 const raw=JSON.stringify({'@context':'https://schema.org','@type':'Organization',name:'VentureBeat',
  url:'https://venturebeat.com/',industry:'Online media and technology news'});
 const page={id:randomUUID(),url:'https://venturebeat.com/about',finalUrl:'https://venturebeat.com/about',
  accountHost:'venturebeat.com',title:'About',text:'x'.repeat(200),contentHash:'h',
  retrievedAt:new Date().toISOString(),publishedAt:null,source:'original_web',origin:'original',status:'unknown',
  companyFacts:[{id:randomUUID(),field:'industry',value:'Online media and technology news',
   statement:'Company-published structured data reports industry: Online media and technology news.',
   sourceRef:{sourceId:'a',pointers:['/industry']}}],
  structuredSources:[{id:'a',rawJson:raw,sourceUrl:'https://venturebeat.com/about',scriptIndex:0,contentHash:hash(raw)}]};
 const withIndustries=(industries?:string[])=>Packet.parse({...classificationPacket,evidence:[page],
  eligibility:{...classificationPacket.eligibility,...(industries?{industries}:{})}});

 // No industry restriction is configured, so knowing the industry cannot settle the warning.
 const unconfigured=resolveCompanyFacts(withIndustries());
 expect(unconfigured.classificationStatus).toBe('provisional');
 expect(unconfigured.status).toBe('unresolved');
 expect(unconfigured.evidenceCanResolve).toBe(true);
 expect(unconfigured.reused.join(' ')).toContain('configures no industry restriction');

 // Configured and matching: the warning is settled against actual policy.
 const inside=resolveCompanyFacts(withIndustries(['Media']));
 expect(inside.classificationStatus).toBe('addressed_by_evidence');
 expect(inside.status).toBe('match');

 // Configured and contradicted: a conflict, which evidence cannot settle and research does not pass.
 const outside=resolveCompanyFacts(withIndustries(['Financial services']));
 expect(outside.conflicts.join(' ')).toContain('outside this campaign');
 expect(outside.status).toBe('unresolved');
 expect(outside.evidenceCanResolve).toBe(false);
});

it('answers a classification question through the real review action, without overriding eligibility',async()=>{
 const db=await migratedDatabase();await seedRecovery(db);await seedRun(db);
 const asked={...classificationPacket,
  pendingResolution:{reason:'classification_conflict',detail:'Saved attributes leave an unresolved conflict.',
   attempts:1,nextAction:'ask_reviewer',at:now,
   question:'Does this company belong in this campaign?'}};
 await db.query(`update public.opportunities set packet=$1,state='company_assessment_pending' where id=$2`,
  [JSON.stringify(asked),UNIDENTIFIED]);
 const revision=(await db.query<{revision:number}>(`select revision from public.opportunities where id=$1`,[UNIDENTIFIED])).rows[0].revision;

 // The identity form's action is refused here: this is not an identity question.
 await expect(asUser(db,user,()=>review(db,UNIDENTIFIED,revision,'50000000-0000-4000-8000-0000000000a1','identify_company',
  'Guessing at a company.',{name:'VentureBeat',domain:'venturebeat.com'})))
  .rejects.toThrow(/no_open_identity_question/);

 // The relevant answer is the question research must settle, recorded and resumed.
 await asUser(db,user,()=>review(db,UNIDENTIFIED,revision,'50000000-0000-4000-8000-0000000000a2','research',
  'Establish from their own site whether they sell advertising and events to business buyers.'));
 const job=(await jobFor(db,UNIDENTIFIED)).rows[0];
 expect(job.stage).toBe('S04');
 // The run's membership and finite authority are preserved.
 expect(job.run_id).toBe(RUN);
 expect(job.payload.recovery.reason).toBe('selected_run');
 // The answer is consumed as the research question, not filed as an ignored note.
 expect(job.payload.researchRequest.question).toContain('advertising and events');
 // Eligibility is untouched: nothing was certified and the profile was not widened.
 expect(job.payload.eligibility).toEqual(classificationPacket.eligibility);
 expect(job.payload.candidate.providerCompany.icp.unknowns.join(' ')).toContain('may conflict');

 // The same request key is idempotent and a stale revision is refused.
 const repeat=await asUser(db,user,()=>review(db,UNIDENTIFIED,revision,'50000000-0000-4000-8000-0000000000a2','research',
  'Establish from their own site whether they sell advertising and events to business buyers.'));
 expect(repeat.rows[0].value.action).toBe('research');
 expect((await db.query<{n:number}>(`select count(*)::int as n from public.jobs where opportunity_id=$1`,[UNIDENTIFIED])).rows[0].n).toBe(1);
 await expect(asUser(db,user,()=>review(db,UNIDENTIFIED,revision,'50000000-0000-4000-8000-0000000000a3','research','Another question entirely.')))
  .rejects.toThrow(/stale_version|recovery_in_progress/);
 await db.close();
});
