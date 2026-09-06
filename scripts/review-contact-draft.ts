import {z} from 'zod';
import {readFile} from 'node:fs/promises';
import {serviceClient} from '../src/persistence/client';
import {Packet} from '../src/contracts/pipeline';
import {hash,reviewProblems} from '../src/domain/policy';
const id=z.string().uuid().parse(process.argv[2]),client=serviceClient(),project=JSON.parse(await readFile('.local/project.json','utf8'));
const {data:row,error}=await client.from('opportunities').select('organization_id,campaign_id,revision,packet').eq('id',id).eq('organization_id',project.organizationId).single();if(error)throw new Error('opportunity_read_failed');
const p=Packet.parse(row.packet);
if(!p.research||!p.packetReview||reviewProblems(p.packetReview,p.research,p,JSON.stringify(p.research)).length||!p.draft||p.contact?.state!=='resolved'||p.draft.recipient!==p.contact.email)throw new Error('current_contact_draft_required');
if(p.draftReview&&!reviewProblems(p.draftReview,p.research,p,JSON.stringify(p.draft)).length){console.log('Exact recipient-bound draft is already checked.');process.exit(0);}
const {error:queued}=await client.from('jobs').upsert({organization_id:row.organization_id,campaign_id:row.campaign_id,opportunity_id:id,business_key:`${id}:S11:${row.revision}:${hash(p)}`,stage:'S11',input_hash:hash(p),input_version:row.revision,schema_version:'1',prompt_version:'6',payload:p},{onConflict:'organization_id,business_key',ignoreDuplicates:true});if(queued)throw new Error('draft_review_enqueue_failed');
console.log('Queued one exact recipient-bound draft review; no contact or writer replay.');
