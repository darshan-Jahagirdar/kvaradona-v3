import {expect,it} from 'vitest';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {testDatabase,seed,localStore,user,otherUser,opportunity} from './database';
import {reviewFixture} from './fixtures/review-packet';
import {Job,Packet} from '../src/contracts/pipeline';
import {runStage,type StageTools} from '../src/stages/pipeline';
import {hash} from '../src/domain/policy';
import {crmInputHash} from '../src/domain/crm-specialist';
const migration='supabase/migrations/20260906165649_draft_review_workflow.sql';
it('keeps a CRM check current when a separate website capture is appended, but detects source changes',()=>{
 const p=reviewFixture(),before=crmInputHash(p);
 p.evidence.push({...p.evidence[0],id:randomUUID(),source:'website_capture'});
 expect(crmInputHash(p)).toBe(before);p.evidence[0].text+=' Changed original source.';expect(crmInputHash(p)).not.toBe(before);
});
it('atomically saves exact edits/rechecks, preserves history, fences old work and keeps tenant/retry boundaries',async()=>{
 const db=await testDatabase();try{
  for(const path of ['supabase/migrations/20260906121200_review_request_identity.sql','supabase/migrations/20260906123513_review_research_queue.sql',migration])await db.exec(await readFile(path,'utf8'));
  await seed(db);const p=reviewFixture(),store=localStore(db),draft={...p.draft!,body:'Human-edited wording. Would an outline be useful?'};
  await db.query('update public.opportunities set packet=$1 where id=$2',[JSON.stringify(p),opportunity]);
  await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${user}',false);`);
  const args={p_id:opportunity,p_revision:1,p_request:randomUUID(),p_action:'edit',p_note:'Keep my exact wording',p_draft:draft};
  await store.rpc('review_opportunity',args);await store.rpc('review_opportunity',args);
  await expect(store.rpc('review_opportunity',{...args,p_note:'Changed note'})).rejects.toThrow('request_key_conflict');
  const row=(await db.query<{packet:Packet;revision:number}>('select packet,revision from public.opportunities')).rows[0];
  expect(row.revision).toBe(2);expect(row.packet.draft).toEqual(draft);expect(row.packet.draftReview).toBeUndefined();
  expect((await db.query<{snapshot:Packet}>('select snapshot from public.reviews')).rows[0].snapshot.draft).toEqual(p.draft);
  expect((await db.query<{stage:string;input_version:number}>('select stage,input_version from public.jobs')).rows).toEqual([{stage:'S11',input_version:2}]);
  await expect(store.rpc('review_opportunity',{...args,p_request:randomUUID(),p_revision:2,p_draft:{...draft,recipient:'changed@fixture.invalid'}})).rejects.toThrow('draft_identity_or_claims_changed');
  await expect(store.rpc('review_opportunity',{...args,p_request:randomUUID(),p_revision:2,p_draft:{...draft,body:123}})).rejects.toThrow('invalid_draft');
  await db.exec(`select set_config('request.jwt.claim.sub','${otherUser}',false);`);
  await expect(store.rpc('review_opportunity',{...args,p_request:randomUUID(),p_revision:2})).rejects.toThrow('not_found');
  await db.exec(`select set_config('request.jwt.claim.sub','${user}',false);`);
  await store.rpc('review_opportunity',{...args,p_action:'recheck',p_revision:2,p_request:randomUUID()});
  expect((await db.query<{status:string}>('select status from public.jobs order by input_version')).rows).toEqual([{status:'blocked'},{status:'queued'}]);
  await store.rpc('review_opportunity',{...args,p_action:'defer',p_revision:3,p_request:randomUUID()});
  expect((await db.query("select id from public.jobs where status='queued'")).rows).toHaveLength(0);
  await store.rpc('review_opportunity',{...args,p_action:'reject',p_revision:4,p_request:randomUUID()});
  expect((await db.query<{packet:Packet}>('select packet from public.opportunities')).rows[0].packet.draft).toEqual(draft);
  await db.exec('reset role');await db.exec(await readFile('supabase/recovery/007_draft_review_workflow.sql','utf8'));
  expect((await db.query('select id from public.reviews')).rows).toHaveLength(4);await db.exec(await readFile(migration,'utf8'));
 }finally{await db.close();}
});
it('checks human wording once and returns unsupported claims without invoking a writer or recapturing an unrelated audit',async()=>{
 for(const acceptable of [true,false]){
  const p=reviewFixture();p.draftCheckRequest={requestedAt:new Date().toISOString(),reviewerId:user};
  p.websiteRequest={profiles:['cro'],url:'https://fixture.invalid',question:'Separate exploratory audit',requestedAt:new Date().toISOString(),verificationOnly:true};
  p.websiteSupplement={inputHash:'pending',profiles:['cro'],question:'Separate audit',capture:{id:randomUUID(),url:'https://fixture.invalid',finalUrl:'https://fixture.invalid',accountHost:'fixture.invalid',observedAt:new Date().toISOString(),version:'web-1',mode:'fixture',complete:false,facts:[],screenshots:[],limitations:[],requests:0,bytes:0,elapsedMs:0,renderStable:false}};
  const calls:string[]=[],tools:StageTools={ai:{async generate(role,_key,schema,_rules,input){calls.push(role);return schema.parse({...p.draftReview,inputHash:(input as {inputHash:string}).inputHash,acceptable,issues:acceptable?[]:['Correct the unsupported wording.']});}},search:async()=>{throw Error('unexpected_search');},fetchEvidence:async()=>{throw Error('unexpected_fetch');},contact:async()=>{throw Error('unexpected_contact');},relationship:async()=>'unknown'};
  const job=Job.parse({id:randomUUID(),organization_id:randomUUID(),campaign_id:randomUUID(),opportunity_id:randomUUID(),stage:'S11',business_key:'human-check',input_hash:hash(p),input_version:2,schema_version:'1',prompt_version:'9',attempt_token:randomUUID(),attempts:1,payload:p});
  let output:Packet|undefined;await runStage({async rpc(_name,args){output=Packet.parse(args.p_output);return true;}},job,tools);
  expect(calls).toEqual(['A5']);expect(output!.draft).toEqual(p.draft);expect(output!.state).toBe(acceptable?'contact_pending':'draft_exception');
 }
});
