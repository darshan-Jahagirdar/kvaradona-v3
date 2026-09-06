import {readFile} from 'node:fs/promises';
import {serviceClient} from '../src/persistence/client';
import {hash,discoveryPriority} from '../src/domain/policy';
const c=serviceClient(),project=JSON.parse(await readFile('.local/project.json','utf8'));
const {data,error}=await c.from('opportunities').select('id,campaign_id,revision,packet').eq('organization_id',project.organizationId).eq('state','evidence_exception');if(error)throw new Error('read_failed');
const row=data?.filter(r=>r.packet.candidate&&r.packet.research).sort((a,b)=>discoveryPriority(b.packet.candidate)-discoveryPriority(a.packet.candidate))[0];if(!row)throw new Error('saved_research_missing');
const {error:queued}=await c.from('jobs').upsert({organization_id:project.organizationId,campaign_id:row.campaign_id,opportunity_id:row.id,business_key:`${row.id}:citation-recovery:${row.revision}`,stage:'S07',input_hash:hash(row.packet),input_version:row.revision,schema_version:'1',prompt_version:'2',payload:row.packet},{onConflict:'organization_id,business_key',ignoreDuplicates:true});if(queued)throw new Error('enqueue_failed');
console.log('Queued one source/citation recovery from saved research; no A2 replay.');
