import {expect,it} from 'vitest';
import {readFile} from 'node:fs/promises';
import {testDatabase,seed,localStore,user,opportunity,enqueue} from './database';
it('atomically queues one next-version research request, preserves the old draft and fences old work',async()=>{
 const db=await testDatabase();try{
  await db.exec(await readFile('supabase/migrations/20260906121200_review_request_identity.sql','utf8'));
  await db.exec(await readFile('supabase/migrations/20260906123513_review_research_queue.sql','utf8'));
  await seed(db);const store=localStore(db);await enqueue(db);
  const old=await store.rpc('claim_job',{p_worker:'old'}) as {id:string;attempt_token:string};
  await db.query(`update public.opportunities set packet=packet||$1::jsonb where id=$2`,[JSON.stringify({evidence:[{id:'fixture'}],draft:{subject:'Old subject',body:'Prior text'},draftReview:{acceptable:true}}),opportunity]);
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${user}',false);`);
  const args={p_id:opportunity,p_revision:1,p_request:'50000000-0000-4000-8000-000000000099',p_action:'research',p_note:'Check whether the migration is still in progress.',p_draft:null};
  await store.rpc('review_opportunity',args);await store.rpc('review_opportunity',args);
  await db.exec('reset role');
  const jobs=(await db.query<{payload:Record<string,unknown>;input_version:number;stage:string}>("select payload,input_version,stage from public.jobs where business_key like '%:research-request:%'")).rows;
  expect(jobs).toHaveLength(1);expect(jobs[0].stage).toBe('S06');expect(jobs[0].input_version).toBe(2);
  expect(jobs[0].payload.draft).toBeUndefined();expect(jobs[0].payload.draftReview).toBeUndefined();
  expect(jobs[0].payload.researchRequest).toMatchObject({question:args.p_note,reviewerId:user});
  expect((await db.query<{snapshot:{draft:{body:string}}}>('select snapshot from public.reviews')).rows[0].snapshot.draft.body).toBe('Prior text');
  expect(await store.rpc('renew_job',{p_job:old.id,p_token:old.attempt_token})).toBe(false);
 }finally{await db.close();}
});
