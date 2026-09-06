import {z} from 'zod';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {serviceClient} from '../src/persistence/client';
import {Packet} from '../src/contracts/pipeline';
import {hash,reviewProblems} from '../src/domain/policy';
import {crmInputHash,crmReviewProblems} from '../src/domain/crm-specialist';
const id=z.string().uuid().parse(process.argv[2]),client=serviceClient(),project=JSON.parse(await readFile('.local/project.json','utf8'));
const {data:row,error}=await client.from('opportunities').select('organization_id,campaign_id,revision,packet').eq('id',id).eq('organization_id',project.organizationId).single();if(error)throw Error('opportunity_read_failed');
const p=Packet.parse(row.packet);
if(!p.research||p.research.specialist!=='crm'||!p.packetReview||reviewProblems(p.packetReview,p.research,p,JSON.stringify(p.research)).length)throw Error('checked_crm_research_required');
if(p.crmSupplement&&!crmReviewProblems(p).length){console.log('Current CRM supplement is already checked.');process.exit(0);}
await mkdir('.local/backups',{recursive:true});
const backup=`.local/backups/crm-${id}-${row.revision}-${crmInputHash(p)}.json`;
await writeFile(backup,JSON.stringify({opportunityId:id,...row},null,2),{mode:0o600,flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
// Idempotent enqueue; no provider-limit changes or provider calls in this command.
const {error:queued}=await client.from('jobs').upsert({organization_id:row.organization_id,campaign_id:row.campaign_id,opportunity_id:id,business_key:`${id}:crm:${row.revision}:${crmInputHash(p)}:${p.crmSupplement?hash(p.crmSupplement):'initial'}`,stage:'S08',input_hash:hash(p),input_version:row.revision,schema_version:'1',prompt_version:'7',payload:p},{onConflict:'organization_id,business_key',ignoreDuplicates:true});if(queued)throw Error('crm_enqueue_failed');
console.log('Queued bounded CRM analysis and evidence review; saved packet backed up.');
