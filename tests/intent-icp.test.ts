import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {intentIcp,intentWorkflowProfile,requireIntentDiscovery} from '../src/domain/intent-icp';
import {testDatabase,seed,localStore,org,user,otherOrg} from './database';
it('keeps the exact corrected ICP and holds discovery instead of inventing topic or industry IDs',()=>{
 expect(intentIcp.employeeRange).toEqual({min:501,max:10000});expect(intentIcp.countries.map(c=>c.code)).toEqual(['IN','US','GB','AU','NZ','AE','SG']);expect(intentIcp.industries).toHaveLength(12);expect(intentIcp.buyerTitles).toHaveLength(7);expect(intentIcp.intentTopics).toEqual(['HubSpot','Monday.com','SEO','Website','CRM','Marketing Automation']);expect(()=>requireIntentDiscovery()).toThrow('apollo_intent_access_unverified');
});
it('holds authenticated new launches before mutating runs, jobs, provider windows or budgets, preserves existing requests and tests recovery',async()=>{
 const db=await testDatabase();try{
 await seed(db);await db.exec('alter table public.campaigns add column discovery_cursor integer not null default 0');await db.exec(await readFile('supabase/migrations/20260907133534_review_workflow.sql','utf8'));
 const previous=(await db.query<{definition:string}>("select pg_get_functiondef('private.start_workflow(uuid,uuid)'::regprocedure) definition")).rows[0].definition;
 const profileBefore=(await db.query<{profile:unknown}>('select profile from public.workflow_profiles')).rows[0].profile;
 await db.exec(await readFile('supabase/migrations/20260907150818_intent_icp_gate.sql','utf8'));
 expect((await db.query<{profile:unknown}>('select profile from public.workflow_profiles')).rows[0].profile).toMatchObject({version:8,discoverySetup:{ready:false}});
 const limitsBefore=(await db.query('select * from public.provider_limits order by provider')).rows,budgetBefore=(await db.query('select * from public.budget')).rows;
 const store=localStore(db),args={p_organization:org,p_request:randomUUID()};
 await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${user}',false)`);
 await expect(store.rpc('start_workflow',args)).rejects.toThrow('apollo_intent_access_unverified');await expect(store.rpc('start_workflow',{...args,p_organization:otherOrg})).rejects.toThrow('membership_required');
 await db.exec('reset role');for(const table of ['jobs','workflow_runs','provider_operations'])expect((await db.query('select * from public.'+table)).rows).toHaveLength(0);
 expect((await db.query('select * from public.provider_limits order by provider')).rows).toEqual(limitsBefore);expect((await db.query('select * from public.budget')).rows).toEqual(budgetBefore);
 const cid=randomUUID();await db.query("insert into public.campaigns(id,organization_id,name,profile) values($1,$2,'Existing','{}')",[cid,org]);await db.query('insert into public.workflow_runs(organization_id,campaign_id,request_key,requested_by) values($1,$2,$3,$4)',[org,cid,args.p_request,user]);
 await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${user}',false)`);expect(await store.rpc('start_workflow',args)).toMatchObject({campaign_id:cid,created:false});
 await db.exec('reset role');await db.exec(await readFile('supabase/recovery/012_intent_icp_gate.sql','utf8'));await db.exec('set role authenticated');await expect(store.rpc('start_workflow',args)).rejects.toThrow('permission');
 await db.exec('reset role');await db.exec(previous);await db.query('update public.workflow_profiles set profile=$1',[JSON.stringify(profileBefore)]);expect((await db.query<{profile:unknown}>('select profile from public.workflow_profiles')).rows[0].profile).toEqual(profileBefore);expect((await db.query('select * from public.workflow_runs')).rows).toHaveLength(1);
 }finally{await db.close();}
});
