import {serviceClient} from '../src/persistence/client';
import {readFile} from 'node:fs/promises';
import {campaignProfile,hash} from '../src/domain/policy';
const c=serviceClient(),p=JSON.parse(await readFile('.local/project.json','utf8'));
const primary=process.argv.includes('--primary-sources'),version=primary?3:2;
const query=primary?'"HubSpot" "Revenue Operations" (site:jobs.ashbyhq.com OR site:job-boards.greenhouse.io OR site:jobs.lever.co)':'"HubSpot" "implement" "revenue operations" hiring -site:hubspot.com -site:linkedin.com -site:indeed.com -template -guide';
const profile={...campaignProfile,version,groups:[{region:'US',country:'US',language:'en',query}]};
const name=`HubSpot initiatives · US query revision ${version}`;
const {data:existing,error:readError}=await c.from('campaigns').select('id').eq('organization_id',p.organizationId).eq('name',name).maybeSingle();if(readError)throw new Error('read_failed');
let id=existing?.id;
if(!id){const {data,error}=await c.from('campaigns').insert({organization_id:p.organizationId,version,name,profile,paused:false}).select('id').single();if(error)throw new Error('campaign_create_failed');id=data.id;}
const {error}=await c.from('jobs').upsert({organization_id:p.organizationId,campaign_id:id,business_key:`pilot-discovery:query-revision-${version}`,stage:'S02',input_hash:hash(profile),input_version:version,schema_version:'1',prompt_version:'1',payload:profile},{onConflict:'organization_id,business_key',ignoreDuplicates:true});if(error)throw new Error('enqueue_failed');
console.log('A new immutable query revision is queued; no manually chosen company.');
