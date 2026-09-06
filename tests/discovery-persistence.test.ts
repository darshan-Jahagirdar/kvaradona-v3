import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {testDatabase,localStore,seed,org,otherOrg,user,otherUser,campaign} from './database';
import {Job} from '../src/contracts/pipeline';
import {complementaryProfile} from '../src/domain/discovery-profile';
import {hash,eventKey} from '../src/domain/policy';
const migration='supabase/migrations/20260906154157_complementary_discovery.sql';
async function setup(){const db=await testDatabase();await seed(db);await db.exec(await readFile(migration,'utf8'));await db.query('update public.campaigns set profile=$1 where id=$2',[JSON.stringify(complementaryProfile),campaign]);return {db,store:localStore(db)};}
function candidate(source='theirstack',id='101',title='Synthetic HubSpot initiative',url='https://fixture.example.invalid/jobs/1'){return {source,url,title,description:'Synthetic evidence, no live provider call.',eventKey:eventKey(url),country:'US',language:'en',discoveredAt:'2026-09-06T00:00:00Z',...(source==='theirstack'?{providerRecord:{id,observedAt:'2026-09-06T00:00:00Z'}}:{})};}
it('rotates all regional/source groups, coalesces pending ticks and keeps retry inputs stable',async()=>{
 const {db,store}=await setup();try{
  await db.query("insert into public.schedules(organization_id,campaign_id,next_due,interval_seconds,enabled) values($1,$2,now()-interval '2 days',300,true)",[org,campaign]);
  expect(await store.rpc('tick_schedules',{})).toBe(1);expect(await store.rpc('tick_schedules',{})).toBe(0);
  const visited:string[]=[];
  for(let i=0;i<8;i++){
   const q=await store.rpc('queue_discovery',{p_campaign:campaign}) as {jobId:string};const replay=await store.rpc('queue_discovery',{p_campaign:campaign}) as {jobId:string;created:boolean};expect(replay).toMatchObject({jobId:q.jobId,created:false});
   const job=Job.parse(await store.rpc('claim_job',{p_worker:'fixture'})),payload=job.payload as typeof complementaryProfile;expect(payload.groupIndex).toBe(i);const g=payload.groups[i%8];visited.push(g.region+':'+g.source);
   expect(await store.rpc('ingest_discovery',{p_job:job.id,p_token:job.attempt_token,p_candidates:[],p_report:{mode:'fixture',maxResearch:0}})).toBe(true);
  }
  expect(visited).toEqual(['US:theirstack','US:brave','Europe:theirstack','Europe:brave','Australia:theirstack','Australia:brave','Asia:theirstack','Asia:brave']);
  expect((await db.query<{discovery_cursor:number}>('select discovery_cursor from public.campaigns where id=$1',[campaign])).rows[0].discovery_cursor).toBe(8);
 }finally{await db.close();}
});
it('keeps one opportunity across sources and provider URL changes, retaining observations without replacing its packet',async()=>{
 const {db,store}=await setup();try{
  async function ingest(c:ReturnType<typeof candidate>){await store.rpc('queue_discovery',{p_campaign:campaign});const job=Job.parse(await store.rpc('claim_job',{p_worker:'fixture'}));const args={p_job:job.id,p_token:job.attempt_token,p_candidates:[c],p_report:{mode:'fixture',maxResearch:0}};expect(await store.rpc('ingest_discovery',args)).toBe(true);expect(await store.rpc('ingest_discovery',args)).toBe(true);return job;}
  await ingest(candidate());const first=(await db.query<{id:string;packet:unknown}>('select id,packet from public.opportunities where event_key=$1',[candidate().eventKey])).rows[0];
  await ingest(candidate('brave'));await ingest(candidate('theirstack','101','Updated provider wording','https://fixture.example.invalid/jobs/new-url'));
  const current=(await db.query<{packet:unknown}>('select packet from public.opportunities where id=$1',[first.id])).rows[0];expect(hash(current.packet)).toBe(hash(first.packet));
  expect((await db.query('select * from public.discovery_observations')).rows).toHaveLength(3);expect((await db.query('select * from public.discovery_observations where changed')).rows).toHaveLength(1);
  expect((await db.query('select * from public.opportunities where id<>$1',['40000000-0000-4000-8000-000000000001'])).rows).toHaveLength(1);
  const queued=await store.rpc('queue_discovery',{p_campaign:campaign}) as {jobId:string};const payload=(await db.query<{payload:{seenTheirStackIds:number[]}}>('select payload from public.jobs where id=$1',[queued.jobId])).rows[0].payload;expect(payload.seenTheirStackIds).toEqual([101]);
 }finally{await db.close();}
});
it('enforces tenant reads, denies browser queue/writes, and preserves history through function recovery',async()=>{
 const db=await testDatabase();try{
  await seed(db);const previous=(await db.query<{definition:string}>("select pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace and proname in('tick_schedules','ingest_discovery')")).rows.map(r=>r.definition);
  await db.exec(await readFile(migration,'utf8'));await db.query('update public.campaigns set profile=$1 where id=$2',[JSON.stringify(complementaryProfile),campaign]);const store=localStore(db);
  await store.rpc('queue_discovery',{p_campaign:campaign});const job=Job.parse(await store.rpc('claim_job',{p_worker:'fixture'}));await store.rpc('ingest_discovery',{p_job:job.id,p_token:job.attempt_token,p_candidates:[candidate()],p_report:{mode:'fixture',maxResearch:0}});
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${user}';`);expect((await db.query('select * from public.discovery_observations')).rows).toHaveLength(1);
  await expect(store.rpc('queue_discovery',{p_campaign:campaign})).rejects.toThrow('permission');await expect(db.exec('delete from public.discovery_observations')).rejects.toThrow('permission');
  await db.exec(`set request.jwt.claim.sub='${otherUser}';`);expect((await db.query('select * from public.discovery_observations')).rows).toHaveLength(0);await db.exec('reset role;');
  await expect(db.query("update public.discovery_observations set organization_id=$1",[otherOrg])).rejects.toThrow('foreign key');
  await db.exec(previous.join(';\n')+';');expect((await db.query('select * from public.discovery_observations')).rows).toHaveLength(1);
 }finally{await db.close();}
});
