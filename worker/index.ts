import { randomUUID } from 'node:crypto';
import {appendFile,mkdir} from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { hostedStore,serviceClient } from '../src/persistence/client';
import { Job } from '../src/contracts/pipeline';
import { OperationGateway } from '../src/usage/operations';
import { OpenAIGateway } from '../src/ai/gateway';
import { searchBrave } from '../src/providers/brave';
import { fetchEvidence } from '../src/capture/fetch';
import { captureWebsite } from '../src/capture/specialists';
import { contactPending } from '../src/domain/policy';
import { runStage } from '../src/stages/pipeline';
const store=hostedStore(),client=serviceClient(),workerId=`laptop-${randomUUID()}`;let stop=false;
process.on('SIGINT',()=>{stop=true;});process.on('SIGTERM',()=>{stop=true;});
const once=process.argv.includes('--once');
async function heartbeat(status:string){const {error}=await client.from('worker_heartbeats').upsert({id:workerId,seen_at:new Date().toISOString(),status});if(error)throw new Error('heartbeat_failed');}
do{
 try{
  await heartbeat('running');await store.rpc('tick_schedules',{});
  const raw=await store.rpc('claim_job',{p_worker:workerId});if(!raw){if(once||process.argv.includes('--drain'))break;await delay(5000);continue;}
  const job=Job.parse(raw),operations=new OperationGateway(store,job,async entry=>{await mkdir('.local',{recursive:true});await appendFile('.local/provider-failures.jsonl',JSON.stringify(entry)+'\n',{mode:0o600});});
  console.log(JSON.stringify({job:job.id,stage:job.stage,status:'started'}));
  const lease=setInterval(()=>{void store.rpc('renew_job',{p_job:job.id,p_token:job.attempt_token}).catch(()=>{stop=true;});},20000);
  try{
   await runStage(store,job,{ai:new OpenAIGateway(operations),fetchEvidence,search:(key,q,c,l)=>searchBrave(operations,key,q,c,l),specialist:captureWebsite,
    relationship:async host=>{const {data,error}=await client.from('relationships').select('status').eq('organization_id',job.organization_id).eq('account_host',host).maybeSingle();if(error)throw new Error('relationship_lookup_failed');if(!data)return 'unknown';if(data.status==='clear')return 'clear';return ['opt_out','bounce','replied'].includes(data.status)?'suppressed':'handoff';},
    contact:async(_host,role)=>contactPending(role,'Apollo free quota and endpoint usability are not verified; no paid contact request made.'),
   });console.log(JSON.stringify({job:job.id,stage:job.stage,status:'completed'}));
  }catch(error){
   // Sanitized reason only. Never log raw provider errors, request headers or secrets.
   const reason=error instanceof Error&&/^[a-z0-9_: -]{1,100}$/i.test(error.message)?error.message:'stage_validation_or_provider_failure';
   const saved=await store.rpc('fail_job',{p_job:job.id,p_token:job.attempt_token,p_reason:reason,p_retry:false});
   console.log(JSON.stringify({job:job.id,stage:job.stage,status:saved?'blocked':'ownership_lost',reason}));
  }finally{clearInterval(lease);}
 }catch{console.error('worker_paused_database_or_configuration_unavailable');stop=true;process.exitCode=1;}
}while(!once&&!stop);
await heartbeat('stopped').catch(()=>{});
