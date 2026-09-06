import {readFile,writeFile} from 'node:fs/promises';
import {serviceClient} from '../src/persistence/client';
import {Packet} from '../src/contracts/pipeline';
import {hash,reviewProblems} from '../src/domain/policy';
import {z} from 'zod';
const id=z.string().uuid().parse(process.argv[2]);
const client=serviceClient(),project=JSON.parse(await readFile('.local/project.json','utf8'));
const {data:row,error}=await client.from('opportunities').select('id,organization_id,campaign_id,revision,packet').eq('id',id).eq('organization_id',project.organizationId).single();if(error)throw new Error('opportunity_read_failed');
const p=Packet.parse(row.packet);
if(!p.research||!p.packetReview||reviewProblems(p.packetReview,p.research,p,JSON.stringify(p.research)).length||p.state!=='contact_pending')throw new Error('current_checked_packet_required');
const {data:limit,error:l}=await client.from('provider_limits').select('*').eq('provider','apollo').single();if(l)throw new Error('limit_read_failed');
// Backup precedes the operator configuration change. The allowance is the user's confirmed snapshot,
// not an API balance measurement, and all recorded units continue to count against it.
await writeFile('.local/backups/contact-resolution-preflight.json',JSON.stringify({opportunity:row,apolloLimit:limit},null,2),{mode:0o600});
const {error:enable}=await client.from('provider_limits').update({limit_usd:0,free_units:75,authenticated:true,usable:false,probe_enabled:true,verified_at:new Date().toISOString(),expires_at:new Date(Date.now()+3600000).toISOString(),evidence:JSON.stringify({kind:'user_confirmed_free_allowance',source:'User confirmed 75 available Apollo credits on 2026-09-06 and instructed not to recheck the balance. Existing recorded units remain counted.',maxEmailCreditsPerLookup:1,phone:false,waterfall:false})}).eq('provider','apollo');if(enable)throw new Error('apollo_enable_failed');
const {error:queued}=await client.from('jobs').upsert({organization_id:row.organization_id,campaign_id:row.campaign_id,opportunity_id:id,business_key:`${id}:contact-resolution:${row.revision}:1`,stage:'S10',input_hash:hash(p),input_version:row.revision,schema_version:'1',prompt_version:'5',payload:p},{onConflict:'organization_id,business_key',ignoreDuplicates:true});if(queued)throw new Error('contact_enqueue_failed');
console.log(JSON.stringify({opportunity:id,action:'queued_bounded_contact_resolution',apolloAllowance:75,maxEnrichments:1,sendingEnabled:false}));
