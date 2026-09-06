import {readFile} from 'node:fs/promises';
import {serviceClient} from '../src/persistence/client';
import {hash,discoveryPriority} from '../src/domain/policy';
// Advance one saved result after a source failure; never substitute a manually seeded account.
const c=serviceClient(),project=JSON.parse(await readFile('.local/project.json','utf8'));
const {data:rows,error}=await c.from('opportunities').select('id,campaign_id,revision,packet,created_at').eq('organization_id',project.organizationId).eq('state','discovered').order('created_at');
if(error)throw new Error('candidate_read_failed');
const {data:jobs,error:jobError}=await c.from('jobs').select('opportunity_id').eq('organization_id',project.organizationId).eq('stage','S04');
if(jobError)throw new Error('job_read_failed');
const attempted=new Set(jobs?.map(j=>j.opportunity_id));
const candidate=rows?.filter(r=>!attempted.has(r.id)&&r.packet.candidate&&discoveryPriority(r.packet.candidate)>0).sort((a,b)=>discoveryPriority(b.packet.candidate)-discoveryPriority(a.packet.candidate))[0];
if(!candidate){console.log('No unattempted candidate in the saved discovery pool.');process.exit(0);}
const {error:insertError}=await c.from('jobs').upsert({organization_id:project.organizationId,campaign_id:candidate.campaign_id,opportunity_id:candidate.id,business_key:`${candidate.id}:S04:${candidate.revision}`,stage:'S04',input_hash:hash(candidate.packet),input_version:candidate.revision,schema_version:'1',prompt_version:'8',payload:candidate.packet},{onConflict:'organization_id,business_key',ignoreDuplicates:true});
if(insertError)throw new Error('enqueue_failed');
console.log(JSON.stringify({opportunity:candidate.id,url:candidate.packet.candidate.url,action:'advance_one_saved_candidate'}));
