import {z} from 'zod';
import {serviceClient,hostedStore} from '../src/persistence/client';
// This is a deliberate local operator action, never part of automatic worker retry.
const [operationId,reason]=process.argv.slice(2);
z.string().uuid().parse(operationId);z.string().min(20).max(1000).parse(reason);
const client=serviceClient();
const {data:budget,error:b}=await client.from('budget').select('limit_usd').eq('id',1).single();
if(b||Number(budget.limit_usd)!==2)throw new Error('two_dollar_migration_required');
const jobId=z.string().uuid().parse(await hostedStore().rpc('replace_ambiguous_draft',{p_operation:operationId,p_reason:reason}));
const {data:job,error:j}=await client.from('jobs').select('campaign_id,status').eq('id',jobId).single();if(j)throw new Error('replacement_read_failed');
if(job.status!=='queued'){console.log(JSON.stringify({jobId,status:job.status}));process.exit(0);}
const {error:l}=await client.from('provider_limits').update({probe_enabled:true,verified_at:new Date().toISOString(),expires_at:new Date(Date.now()+3600000).toISOString(),evidence:'User authorized $2 cumulative OpenAI/Brave verification; bounded replacement retains the original unknown charge.'}).eq('provider','openai');if(l)throw new Error('provider_enable_failed');
const {error:enabled}=await client.from('budget').update({live_enabled:true}).eq('id',1);if(enabled)throw new Error('budget_enable_failed');
const {error:c}=await client.from('campaigns').update({paused:false}).eq('id',job.campaign_id);if(c)throw new Error('campaign_enable_failed');
console.log(JSON.stringify({jobId,status:'queued',model:'gpt-5.6-terra',originalReservation:'retained',capUsd:2}));
