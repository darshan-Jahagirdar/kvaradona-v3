import {serviceClient} from '../src/persistence/client';
import {readFile} from 'node:fs/promises';
const c=serviceClient(),p=JSON.parse(await readFile('.local/project.json','utf8'));
const {error:budgetError}=await c.from('budget').update({live_enabled:false}).eq('id',1);if(budgetError)throw new Error('budget_pause_failed');
const {error:campaignError}=await c.from('campaigns').update({paused:true}).eq('organization_id',p.organizationId);if(campaignError)throw new Error('campaign_pause_failed');
const {error:limitError}=await c.from('provider_limits').update({probe_enabled:false}).in('provider',['openai','brave']);if(limitError)throw new Error('probe_pause_failed');
console.log('Pilot paused. Saved work and usage preserved; new billable calls disabled.');
