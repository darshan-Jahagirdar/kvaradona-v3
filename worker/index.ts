import { randomUUID } from 'node:crypto';
import {appendFile,mkdir} from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { hostedStore,serviceClient } from '../src/persistence/client';
import { Job,Packet } from '../src/contracts/pipeline';
import { OperationGateway } from '../src/usage/operations';
import { OpenAIGateway } from '../src/ai/gateway';
import { searchBrave } from '../src/providers/brave';
import {searchTheirStack} from '../src/providers/theirstack';
import {searchSam,samQuery} from '../src/providers/sam';
import {searchContractsFinder,contractsQuery} from '../src/providers/contracts-finder';
import {procurementEvidence} from '../src/capture/procurement';
import {ApolloContacts,type FreeContactAllowance} from '../src/providers/apollo';
import { fetchEvidence } from '../src/capture/fetch';
import {storeWebsiteCapture,loadWebsiteImages} from '../src/persistence/website-artifacts';
import { captureWebsite } from '../src/capture/specialists';
import { runStage } from '../src/stages/pipeline';
const store=hostedStore(),client=serviceClient(),workerId=`laptop-${randomUUID()}`;let stop=false;
process.on('SIGINT',()=>{stop=true;});process.on('SIGTERM',()=>{stop=true;});
const once=process.argv.includes('--once');
const maxArg=process.argv.find(x=>x.startsWith('--max-jobs='));const maxJobs=maxArg?Number(maxArg.split('=')[1]):Infinity;
if(!(maxJobs>0)||maxJobs!==Infinity&&(!Number.isInteger(maxJobs)||maxJobs>100))throw Error('invalid_job_limit');let completed=0;
async function heartbeat(status:string){const {error}=await client.from('worker_heartbeats').upsert({id:workerId,seen_at:new Date().toISOString(),status});if(error)throw new Error('heartbeat_failed');}
do{
 try{
  await heartbeat('running');await store.rpc('tick_schedules',{});
  const raw=await store.rpc('claim_job',{p_worker:workerId});if(!raw){if(once||process.argv.includes('--drain'))break;await delay(5000);continue;}
  const job=Job.parse(raw),operations=new OperationGateway(store,job,async entry=>{await mkdir('.local',{recursive:true});await appendFile('.local/provider-failures.jsonl',JSON.stringify(entry)+'\n',{mode:0o600});});
  console.log(JSON.stringify({job:job.id,stage:job.stage,status:'started'}));
  const lease=setInterval(()=>{void store.rpc('renew_job',{p_job:job.id,p_token:job.attempt_token}).catch(()=>{stop=true;});},20000);
  try{
   const draftModel=job.stage==='S11'?Packet.parse(job.payload).draftReplacement?.model:undefined;
   await runStage(store,job,{knownEvidenceEvents:async()=>{const r=await client.from('opportunities').select('event_key').eq('organization_id',job.organization_id).neq('state','discovered').neq('packet->>mode','fixture').gte('updated_at',new Date(Date.now()-7*86400000).toISOString());if(r.error)throw Error('known_source_lookup_failed');return r.data.map(x=>x.event_key);},ai:new OpenAIGateway(operations,draftModel),fetchEvidence,search:(key,q,c,l)=>searchBrave(operations,key,q,c,l),jobSearch:(key,group,seen)=>searchTheirStack(operations,key,group,seen),procurementSearch:(key,g)=>{if(!g.asOf)throw Error('frozen_search_date_required');return g.source==='sam'?searchSam(operations,key,samQuery(g.query||'CRM',g.postedWithinDays,new Date(g.asOf))):searchContractsFinder(operations,key,contractsQuery(new Date(g.asOf)));},procurementEvidence:n=>procurementEvidence(operations,n),specialist:captureWebsite,websiteCapture:(url,host)=>storeWebsiteCapture(url,host,job.organization_id,job.business_key),websiteImages:capture=>loadWebsiteImages(capture,job.organization_id),
    relationship:async host=>{const {data,error}=await client.from('relationships').select('status').eq('organization_id',job.organization_id).eq('account_host',host).maybeSingle();if(error)throw new Error('relationship_lookup_failed');if(!data)return 'unknown';if(data.status==='clear')return 'clear';return ['opt_out','bounce','replied'].includes(data.status)?'suppressed':'handoff';},
    contact:async(host,role,company)=>{
     const {data:limit,error}=await client.from('provider_limits').select('free_units,expires_at,evidence').eq('provider','apollo').single();if(error)throw new Error('contact_limit_read_failed');
     let allowance:FreeContactAllowance|null=null;
     try{const proof=JSON.parse(limit.evidence??'{}');if(['verified_free_plan','user_confirmed_free_allowance'].includes(proof.kind))allowance={remaining:limit.free_units,expiresAt:limit.expires_at??'',evidence:proof.source,verifiedFree:true};}catch{}
     return new ApolloContacts(operations,allowance).resolve(host,role,company);
    },
   });console.log(JSON.stringify({job:job.id,stage:job.stage,status:'completed'}));
  }catch(error){
   // Sanitized reason only. Never log raw provider errors, request headers or secrets.
   const reason=error instanceof Error&&/^[a-z0-9_: -]{1,100}$/i.test(error.message)?error.message:'stage_validation_or_provider_failure';
   const saved=await store.rpc('fail_job',{p_job:job.id,p_token:job.attempt_token,p_reason:reason,p_retry:false});
   console.log(JSON.stringify({job:job.id,stage:job.stage,status:saved?'blocked':'ownership_lost',reason}));
  }finally{clearInterval(lease);}
 }catch{console.error('worker_paused_database_or_configuration_unavailable');stop=true;process.exitCode=1;}
}while(!once&&!stop&&++completed<maxJobs);
await heartbeat('stopped').catch(()=>{});
