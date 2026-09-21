import {companyProviderOperations,companyContactOperations} from '../src/persistence/saved-provider-operations';
import { randomUUID } from 'node:crypto';
import {appendFile,mkdir} from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { hostedStore,serviceClient } from '../src/persistence/client';
import { Job,Packet } from '../src/contracts/pipeline';
import { OperationGateway } from '../src/usage/operations';
import { OpenAIGateway } from '../src/ai/gateway';
import {searchExploriumCompanies} from '../src/providers/explorium';
import {searchApolloCompanies} from '../src/providers/apollo-companies';
import {hash} from '../src/domain/policy';
import { searchBrave,braveRequest } from '../src/providers/brave';
import {searchTheirStack} from '../src/providers/theirstack';
import {searchSam,samQuery} from '../src/providers/sam';
import {searchContractsFinder,contractsQuery} from '../src/providers/contracts-finder';
import {procurementEvidence} from '../src/capture/procurement';
import {ApolloContacts,type FreeContactAllowance} from '../src/providers/apollo';
import { fetchEvidence } from '../src/capture/fetch';
import {storeWebsiteCapture,loadWebsiteImages} from '../src/persistence/website-artifacts';
import { captureWebsite } from '../src/capture/specialists';
import { runStage } from '../src/stages/pipeline';
import {classifyFailure} from '../src/domain/failure-policy';
const store=hostedStore(),client=serviceClient(),workerId=`laptop-${randomUUID()}`;let stop=false;
process.on('SIGINT',()=>{stop=true;});process.on('SIGTERM',()=>{stop=true;});
const once=process.argv.includes('--once');
const maxArg=process.argv.find(x=>x.startsWith('--max-jobs='));const maxJobs=maxArg?Number(maxArg.split('=')[1]):Infinity;
if(!(maxJobs>0)||maxJobs!==Infinity&&(!Number.isInteger(maxJobs)||maxJobs>100))throw Error('invalid_job_limit');let completed=0;
async function heartbeat(status:string){const {error}=await client.from('worker_heartbeats').upsert({id:workerId,seen_at:new Date().toISOString(),status});if(error)throw new Error('heartbeat_failed');}
// Lease and heartbeat writes are tracked and awaited, so a late write cannot resurrect a stopped
// worker or renew a job this process has already finished with.
const pending=new Set<Promise<unknown>>();
const track=<T,>(p:Promise<T>)=>{pending.add(p);void p.catch(()=>{}).finally(()=>pending.delete(p));return p;};
const settle=async()=>{while(pending.size)await Promise.allSettled([...pending]);};
do{
 try{
  await heartbeat('running');await store.rpc('tick_schedules',{});
  const raw=await store.rpc('claim_job',{p_worker:workerId});if(!raw){if(once||process.argv.includes('--drain'))break;await delay(5000);continue;}
  const job=Job.parse(raw),operations=new OperationGateway(store,job,async entry=>{await mkdir('.local',{recursive:true});await appendFile('.local/provider-failures.jsonl',JSON.stringify(entry)+'\n',{mode:0o600});});
  console.log(JSON.stringify({job:job.id,stage:job.stage,status:'started'}));
  const lease=setInterval(()=>{track(heartbeat('running').catch(()=>{stop=true;}));track(store.rpc('renew_job',{p_job:job.id,p_token:job.attempt_token}).then(ok=>{if(ok!==true)stop=true;}).catch(()=>{stop=true;}));},20000);
  try{
   const draftModel=job.stage==='S11'?Packet.parse(job.payload).draftReplacement?.model:undefined;
   await runStage(store,job,{
    savedProviderOperations:async()=>{const company=Packet.parse(job.payload).candidate?.providerCompany;return company&&job.opportunity_id?companyProviderOperations(client,job.organization_id,company,job.opportunity_id):[];},
    relatedProcurement:async()=>{const r=await client.from('opportunities').select('packet').eq('organization_id',job.organization_id).not('packet->candidate->procurementNotice','is',null).limit(100);if(r.error||r.data.length===100)throw Error('procurement_context_lookup_incomplete');return r.data.flatMap(x=>{const p=Packet.safeParse(x.packet);return p.success&&p.data.mode==='live'?[p.data]:[];});},
    companySearch:(key,group)=>group.source==='explorium'?searchExploriumCompanies(operations,key,group,fetch,async candidates=>{
     if(!candidates.length)return new Set<string>();
     const ids=candidates.map(c=>c.providerCompany!.id).join(','),domains=candidates.map(c=>c.providerCompany!.domain).filter(Boolean).join(',');
     const r=await client.from('opportunities').select('packet').eq('organization_id',job.organization_id).eq('packet->>mode','live').or(`packet->candidate->providerCompany->>id.in.(${ids}),packet->candidate->providerCompany->>domain.in.(${domains}),packet->research->>accountHost.in.(${domains})`).limit(100);
     if(r.error||r.data.length===100)throw Error('known_company_lookup_unavailable');
     const packets=r.data.flatMap(row=>{const p=Packet.safeParse(row.packet);return p.success?[p.data]:[];});
     return new Set(candidates.filter(c=>packets.some(p=>{const prior=p.candidate?.providerCompany,current=c.providerCompany!;return prior?.provider==='explorium'&&prior.id===current.id||(prior?.domain??p.research?.accountHost)===current.domain&&(prior?.name??p.research?.company)?.toLowerCase()===current.name.toLowerCase();})).map(c=>c.eventKey));
    }):searchApolloCompanies(operations,key,group),companyEvidence:async host=>{
    const r=await client.from('opportunities').select('packet').eq('organization_id',job.organization_id).neq('id',job.opportunity_id??'00000000-0000-0000-0000-000000000000').eq('packet->research->>accountHost',host).limit(10);if(r.error)throw Error('company_evidence_lookup_failed');
    return r.data.flatMap(row=>{const p=Packet.safeParse(row.packet);return p.success&&p.data.mode==='live'?p.data.evidence:[];});
   },knownEvidenceEvents:async()=>{const r=await client.from('opportunities').select('event_key').eq('organization_id',job.organization_id).neq('state','discovered').neq('packet->>mode','fixture').gte('updated_at',new Date(Date.now()-7*86400000).toISOString());if(r.error)throw Error('known_source_lookup_failed');return r.data.map(x=>x.event_key);},ai:new OpenAIGateway(operations,draftModel),fetchEvidence,search:async(key,q,c,l)=>{
    const prior=job.opportunity_id?await client.from('provider_operations').select('response').eq('organization_id',job.organization_id).eq('opportunity_id',job.opportunity_id).eq('provider','brave').eq('state','succeeded').eq('request_hash',hash(braveRequest(key,q,c,l))).gte('created_at',new Date(Date.now()-7*86400000).toISOString()).order('created_at',{ascending:false}).limit(1):null;
    if(prior?.error)throw Error('saved_search_read_failed');return searchBrave(operations,key,q,c,l,prior?.data?.[0]?.response);
   },jobSearch:(key,group,seen)=>searchTheirStack(operations,key,group,seen),procurementSearch:(key,g)=>{if(!g.asOf)throw Error('frozen_search_date_required');return g.source==='sam'?searchSam(operations,key,samQuery(g.query||'CRM',g.postedWithinDays,new Date(g.asOf))):searchContractsFinder(operations,key,contractsQuery(new Date(g.asOf)));},procurementEvidence:n=>procurementEvidence(operations,n),specialist:captureWebsite,websiteCapture:(url,host)=>storeWebsiteCapture(url,host,job.organization_id,job.business_key),websiteImages:capture=>loadWebsiteImages(capture,job.organization_id),
    relationship:async host=>{const {data,error}=await client.from('relationships').select('status').eq('organization_id',job.organization_id).eq('account_host',host).maybeSingle();if(error)throw new Error('relationship_lookup_failed');if(!data)return 'unknown';if(data.status==='clear')return 'clear';return ['opt_out','bounce','replied'].includes(data.status)?'suppressed':'handoff';},
    contact:async(host,role,company,packet)=>{
     const {data:limit,error}=await client.from('provider_limits').select('free_units,expires_at,evidence').eq('provider','apollo').single();if(error)throw new Error('contact_limit_read_failed');
     // A selected job draws its contact authority from its OWN run window; a discovery job keeps the
     // campaign window. The two never lend each other time, matching reserve_operation.
     let runExpiry:string|null=null,selectedRun=false;
     if(job.run_id){
      const run=await client.from('workflow_runs').select('mode,status,expires_at').eq('id',job.run_id).eq('organization_id',job.organization_id).single();
      if(run.error)throw Error('contact_run_read_failed');
      selectedRun=run.data.mode==='selected';
      if(selectedRun&&run.data.status==='active')runExpiry=run.data.expires_at;
     }
     const campaign=await client.from('campaigns').select('profile').eq('id',job.campaign_id).eq('organization_id',job.organization_id).single();if(campaign.error)throw Error('contact_campaign_read_failed');
     const campaignExpiry=job.run_id?null:campaign.data.profile?.contactExecutionExpiresAt;
     let allowance:FreeContactAllowance|null=null;
     try{const proof=JSON.parse(limit.evidence??'{}'),grant=proof.contactExecutionGrant;
      const scoped=job.stage==='S10'&&Array.isArray(grant?.opportunityIds)&&grant.opportunityIds.includes(job.opportunity_id)&&Date.parse(grant.expiresAt)>Date.now();
      const windowExpiry=job.stage==='S10'
       ?(runExpiry&&Date.parse(runExpiry)>Date.now()?runExpiry
         :campaignExpiry&&Date.parse(campaignExpiry)>Date.now()?campaignExpiry:null)
       :null;
      if(['verified_free_plan','user_confirmed_free_allowance'].includes(proof.kind))allowance={remaining:limit.free_units,expiresAt:scoped?grant.expiresAt:windowExpiry??limit.expires_at??'',evidence:proof.source,verifiedFree:true};
     }catch{}
     // The whole recorded history is handed to the adapter, which matches a saved response to the
     // EXACT request it answered. Handing it "the newest contact search" let a response to different
     // criteria stand in for the question actually being asked.
     //
     // The history is COMPANY scoped, not opportunity scoped: the reveal ceiling is a promise about
     // a company, so a duplicate record for the same company must not create a second authorization.
     const parsedForHistory=Packet.safeParse(job.payload).data;
     const contactHosts=[host,parsedForHistory?.research?.accountHost,
      parsedForHistory?.candidate?.providerCompany?.domain,parsedForHistory?.identityResolution?.to]
      .filter((h):h is string=>Boolean(h));
     const history=await companyContactOperations(client,job.organization_id,contactHosts,job.opportunity_id!);
     // Personas come from the campaign and A2's researched service. The intent-ICP buyer list is a
     // DISCOVERY constraint; applying it to a chosen company filtered out its own marketing director.
     const parsedPayload=parsedForHistory;
     const selectedJob=selectedRun||Boolean(parsedPayload?.recovery?.selectedRun);
     const intentIcpOnly=!selectedJob&&parsedPayload?.candidate?.providerCompany?.provider==='explorium';
     const service=packet?.research?.service??parsedPayload?.research?.service??'';
     return new ApolloContacts(operations,allowance,fetch,{operations:history})
      .resolve(host,role,company,intentIcpOnly,packet,service);
    },
   });console.log(JSON.stringify({job:job.id,stage:job.stage,status:'completed'}));
  }catch(error){
   // Sanitized reason only. Never log raw provider errors, request headers or secrets.
   const reason=error instanceof Error&&/^[a-z0-9_: -]{1,100}$/i.test(error.message)?error.message:'stage_validation_or_provider_failure';
   // An uncertain paid dispatch is never retried; it stays held and visible. Transient and
   // rejected-model-output failures get a bounded retry inside the existing attempts<3 limit.
   const outcome=classifyFailure(reason),retry=outcome==='retry'&&job.attempts<3;
   const saved=await store.rpc('fail_job',{p_job:job.id,p_token:job.attempt_token,p_reason:reason,p_retry:retry});
   console.log(JSON.stringify({job:job.id,stage:job.stage,status:saved?(retry?'retrying':'blocked'):'ownership_lost',
    reason,outcome,attempts:job.attempts,...(retry?{requeued:true}:{})}));
  }finally{clearInterval(lease);await settle();}
 }catch{console.error('worker_paused_database_or_configuration_unavailable');stop=true;process.exitCode=1;}
}while(!once&&!stop&&++completed<maxJobs);
await settle();
await heartbeat('stopped').catch(()=>{});
