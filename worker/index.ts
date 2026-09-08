import { randomUUID } from 'node:crypto';
import {appendFile,mkdir} from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { hostedStore,serviceClient } from '../src/persistence/client';
import { Job,Packet } from '../src/contracts/pipeline';
import { OperationGateway } from '../src/usage/operations';
import { OpenAIGateway } from '../src/ai/gateway';
import {searchExploriumCompanies} from '../src/providers/explorium';
import {searchApolloCompanies} from '../src/providers/apollo-companies';
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
  const lease=setInterval(()=>{void heartbeat('running').catch(()=>{stop=true;});void store.rpc('renew_job',{p_job:job.id,p_token:job.attempt_token}).catch(()=>{stop=true;});},20000);
  try{
   const draftModel=job.stage==='S11'?Packet.parse(job.payload).draftReplacement?.model:undefined;
   await runStage(store,job,{companySearch:(key,group)=>group.source==='explorium'?searchExploriumCompanies(operations,key,group,fetch,async candidates=>{
     if(!candidates.length)return new Set<string>();
     const ids=candidates.map(c=>c.providerCompany!.id).join(','),domains=candidates.map(c=>c.providerCompany!.domain).filter(Boolean).join(',');
     const r=await client.from('opportunities').select('packet').eq('organization_id',job.organization_id).eq('packet->>mode','live').or(`packet->candidate->providerCompany->>id.in.(${ids}),packet->candidate->providerCompany->>domain.in.(${domains}),packet->research->>accountHost.in.(${domains})`).limit(100);
     if(r.error||r.data.length===100)throw Error('known_company_lookup_unavailable');
     const packets=r.data.flatMap(row=>{const p=Packet.safeParse(row.packet);return p.success?[p.data]:[];});
     return new Set(candidates.filter(c=>packets.some(p=>{const prior=p.candidate?.providerCompany,current=c.providerCompany!;return prior?.provider==='explorium'&&prior.id===current.id||(prior?.domain??p.research?.accountHost)===current.domain&&(prior?.name??p.research?.company)?.toLowerCase()===current.name.toLowerCase();})).map(c=>c.eventKey));
    }):searchApolloCompanies(operations,key,group),companyEvidence:async host=>{
    const r=await client.from('opportunities').select('packet').eq('organization_id',job.organization_id).neq('id',job.opportunity_id??'00000000-0000-0000-0000-000000000000').eq('packet->research->>accountHost',host).gte('updated_at',new Date(Date.now()-7*86400000).toISOString()).limit(10);if(r.error)throw Error('company_evidence_lookup_failed');
    return r.data.flatMap(row=>{const p=Packet.safeParse(row.packet);return p.success&&p.data.mode==='live'?p.data.evidence:[];});
   },knownEvidenceEvents:async()=>{const r=await client.from('opportunities').select('event_key').eq('organization_id',job.organization_id).neq('state','discovered').neq('packet->>mode','fixture').gte('updated_at',new Date(Date.now()-7*86400000).toISOString());if(r.error)throw Error('known_source_lookup_failed');return r.data.map(x=>x.event_key);},ai:new OpenAIGateway(operations,draftModel),fetchEvidence,search:(key,q,c,l)=>searchBrave(operations,key,q,c,l),jobSearch:(key,group,seen)=>searchTheirStack(operations,key,group,seen),procurementSearch:(key,g)=>{if(!g.asOf)throw Error('frozen_search_date_required');return g.source==='sam'?searchSam(operations,key,samQuery(g.query||'CRM',g.postedWithinDays,new Date(g.asOf))):searchContractsFinder(operations,key,contractsQuery(new Date(g.asOf)));},procurementEvidence:n=>procurementEvidence(operations,n),specialist:captureWebsite,websiteCapture:(url,host)=>storeWebsiteCapture(url,host,job.organization_id,job.business_key),websiteImages:capture=>loadWebsiteImages(capture,job.organization_id),
    relationship:async host=>{const {data,error}=await client.from('relationships').select('status').eq('organization_id',job.organization_id).eq('account_host',host).maybeSingle();if(error)throw new Error('relationship_lookup_failed');if(!data)return 'unknown';if(data.status==='clear')return 'clear';return ['opt_out','bounce','replied'].includes(data.status)?'suppressed':'handoff';},
    contact:async(host,role,company)=>{
     const {data:limit,error}=await client.from('provider_limits').select('free_units,expires_at,evidence').eq('provider','apollo').single();if(error)throw new Error('contact_limit_read_failed');
     const campaign=await client.from('campaigns').select('profile').eq('id',job.campaign_id).eq('organization_id',job.organization_id).single();if(campaign.error)throw Error('contact_campaign_read_failed');
     const campaignExpiry=campaign.data.profile?.contactExecutionExpiresAt;
     let allowance:FreeContactAllowance|null=null;
     try{const proof=JSON.parse(limit.evidence??'{}'),grant=proof.contactExecutionGrant;
      const scoped=job.stage==='S10'&&Array.isArray(grant?.opportunityIds)&&grant.opportunityIds.includes(job.opportunity_id)&&Date.parse(grant.expiresAt)>Date.now();
      if(['verified_free_plan','user_confirmed_free_allowance'].includes(proof.kind))allowance={remaining:limit.free_units,expiresAt:scoped?grant.expiresAt:job.stage==='S10'&&Date.parse(campaignExpiry)>Date.now()?campaignExpiry:limit.expires_at??'',evidence:proof.source,verifiedFree:true};
     }catch{}
     const prior=await client.from('provider_operations').select('response').eq('organization_id',job.organization_id).eq('opportunity_id',job.opportunity_id!).eq('provider','apollo').eq('state','succeeded').like('operation_key','%:contact_search').gte('created_at',new Date(Date.now()-7*86400000).toISOString()).order('created_at',{ascending:false}).limit(1);
     if(prior.error)throw Error('contact_saved_search_read_failed');
     return new ApolloContacts(operations,allowance,fetch,prior.data[0]?.response).resolve(host,role,company,Packet.safeParse(job.payload).data?.candidate?.providerCompany?.provider==='explorium');
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
