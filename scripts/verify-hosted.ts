import { readFile,writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { serviceClient } from '../src/persistence/client';
import { required } from '../src/config/env';
const admin=serviceClient();
const {count,error:jobsError}=await admin.from('jobs').select('id',{count:'exact',head:true});if(jobsError||count!==0)throw new Error('probe_requires_idle_unstarted_queue');
const budget=(await admin.from('budget').select('*').single()).data;
const limit=(await admin.from('provider_limits').select('*').eq('provider','openai').single()).data;if(!budget||!limit)throw new Error('configuration_snapshot_failed');
const org=randomUUID(),campaign=randomUUID(),opp=randomUUID();
const web=createClient(required('NEXT_PUBLIC_SUPABASE_URL'),required('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'),{auth:{persistSession:false}});
const credentials=JSON.parse(await readFile('.local/review-login.json','utf8'));
const {error:loginError}=await web.auth.signInWithPassword(credentials);if(loginError)throw new Error('login_failed');
const check=(condition:unknown,message:string)=>{if(!condition)throw new Error(message);};
async function insert(table:string,row:Record<string,unknown>){const r=await admin.from(table).insert(row);if(r.error)throw new Error(`probe_${table}_insert_failed`);}
try{
 await insert('organizations',{id:org,name:'Temporary V3 isolation probe'});
 await insert('campaigns',{id:campaign,organization_id:org,name:'Temporary V3 execution probe',profile:{mode:'fixture'},paused:false});
 await insert('opportunities',{id:opp,organization_id:org,campaign_id:campaign,event_key:'temporary-probe',packet:{state:'fixture',mode:'fixture',evidence:[]}});
 const hidden=await web.from('organizations').select('id').eq('id',org);check(!hidden.error&&hidden.data.length===0,'cross_org_read_leak');
 const inaccessible=await web.rpc('review_opportunity',{p_id:opp,p_revision:1,p_request:randomUUID(),p_action:'defer',p_note:'fixture',p_draft:null});check(inaccessible.error,'cross_org_command_leak');
 const forbidden=await web.rpc('claim_job',{p_worker:'browser-probe'});check(forbidden.error,'browser_queue_leak');
 await insert('jobs',{organization_id:org,campaign_id:campaign,opportunity_id:opp,business_key:'temporary',stage:'S06',input_hash:'fixture',input_version:1,schema_version:'1',prompt_version:'1',payload:{}});
 const claimed=(await admin.rpc('claim_job',{p_worker:'temporary-hosted-probe'})).data;check(claimed?.organization_id===org,'wrong_claim');
 const lease=await admin.rpc('complete_job',{p_job:claimed.id,p_token:randomUUID(),p_output:{},p_next:null});check(lease.data===false,'stale_token_accepted');
 await admin.from('budget').update({limit_usd:'0.015',live_enabled:true}).eq('id',1);
 await admin.from('provider_limits').update({probe_enabled:true,verified_at:new Date().toISOString(),expires_at:new Date(Date.now()+60000).toISOString()}).eq('provider','openai');
 const reservations=await Promise.all(['a','b'].map(key=>admin.rpc('reserve_operation',{p_job:claimed.id,p_token:claimed.attempt_token,p_key:`hosted-probe-${key}`,p_provider:'openai',p_hash:key,p_max:'0.01',p_units:0})));
 check(reservations.filter(r=>!r.error).length===1&&reservations.filter(r=>r.error?.message==='budget_paused').length===1,'concurrent_budget_failed');
 const report={evidence:'hosted_postgres_probe',namedLogin:true,crossOrganizationReadBlocked:true,crossOrganizationCommandBlocked:true,browserQueueBlocked:true,staleAttemptBlocked:true,concurrentBudgetReservations:true,externalProviderCalls:0,at:new Date().toISOString()};
 await writeFile('.local/hosted-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{
 for(const table of ['provider_operations','stage_runs','jobs','evidence','opportunities','campaigns','memberships']){const r=await admin.from(table).delete().eq('organization_id',org);if(r.error)throw new Error(`probe_cleanup_${table}_failed`);}
 await admin.from('organizations').delete().eq('id',org);
 const {error:b}=await admin.from('budget').update(budget).eq('id',1);
 const {error:l}=await admin.from('provider_limits').update(limit).eq('provider','openai');if(b||l)throw new Error('probe_configuration_restore_failed');
 await web.auth.signOut();
}
