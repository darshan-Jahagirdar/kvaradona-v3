import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {serviceClient} from '../src/persistence/client';
import {complementaryProfile} from '../src/domain/discovery-profile';
import {TheirStackCredits,unusedFreeCredits} from '../src/providers/theirstack';
import {hash} from '../src/domain/policy';
const c=serviceClient(),project=JSON.parse(await readFile('.local/project.json','utf8'));
const report=JSON.parse(await readFile('.local/theirstack-credit-probe.json','utf8')),credits=TheirStackCredits.parse(report.data);
if(report.status!==200||Date.now()-Date.parse(report.at)>3600000||Date.parse(report.at)>Date.now()||unusedFreeCredits(credits)<3||!credits.earliest_expiration||Date.parse(credits.earliest_expiration)<=Date.now())throw Error('recent_free_credit_evidence_required');
const [{data:budget,error:be},{data:limit,error:le},{data:ops,error:oe}]=await Promise.all([c.from('budget').select('limit_usd,live_enabled').eq('id',1).single(),c.from('provider_limits').select('*').eq('provider','theirstack').single(),c.from('provider_operations').select('units').eq('provider','theirstack')]);
if(be||le||oe||Number(budget.limit_usd)!==2||!budget.live_enabled)throw Error('pilot_configuration_unavailable');
if(ops.length)throw Error('existing_theirstack_operations_preserved_use_queue_discovery');
await mkdir('.local/backups',{recursive:true});await writeFile('.local/backups/theirstack-limit.json',JSON.stringify(limit,null,2),{mode:0o600,flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
// First probe permits only three returned records, without changing USD or other provider limits.
const {error:enabled}=await c.from('provider_limits').update({free_units:3,verified_at:report.at,expires_at:new Date(Math.min(Date.now()+3600000,Date.parse(credits.earliest_expiration))).toISOString(),probe_enabled:true,authenticated:true,usable:false,evidence:JSON.stringify({kind:'verified_free_allowance',source:'https://theirstack.com/en/docs/pricing/plans',metering:'https://theirstack.com/en/docs/pricing/credits',available:credits.api_credits,usedThisCycle:credits.used_api_credits,freeAllowance:unusedFreeCredits(credits),initialMaxRecords:3,observedAt:report.at})}).eq('provider','theirstack');if(enabled)throw Error('provider_enable_failed');
const {data:prior,error:pe}=await c.from('campaigns').select('id,profile').eq('organization_id',project.organizationId).eq('name',complementaryProfile.name).maybeSingle();if(pe)throw Error('campaign_read_failed');
if(prior&&hash(prior.profile)!==hash(complementaryProfile))throw Error('campaign_profile_conflict');
let campaignId=prior?.id;if(!campaignId){const {data,error}=await c.from('campaigns').insert({organization_id:project.organizationId,version:complementaryProfile.version,name:complementaryProfile.name,profile:complementaryProfile,paused:false}).select('id').single();if(error)throw Error('campaign_create_failed');campaignId=data.id;}
await writeFile('.local/complementary-campaign.json',JSON.stringify({campaignId,organizationId:project.organizationId,profileHash:hash(complementaryProfile)}),{mode:0o600});
const {data,error}=await c.rpc('queue_discovery',{p_campaign:campaignId});if(error)throw Error(error.message);console.log(JSON.stringify({campaignId,...data,maxTheirStackCredits:3,schedulesEnabled:false}));
