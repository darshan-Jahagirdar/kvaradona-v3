import {readFile,writeFile,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {serviceClient} from '../src/persistence/client';
import {eventKey} from '../src/domain/policy';
const c=serviceClient(),action=process.argv[2],path='.local/review-fixture.json';
if(action==='create'){
 const p=JSON.parse(await readFile('.local/project.json','utf8')),campaignId=randomUUID(),opportunityId=randomUUID(),url='https://review-fixture.example.invalid/source';
 await writeFile(path,JSON.stringify({campaignId,opportunityId}),{flag:'wx',mode:0o600});
 const {error:a}=await c.from('campaigns').insert({id:campaignId,organization_id:p.organizationId,name:'Fixture · review research verification',profile:{mode:'fixture'},paused:true});if(a)throw new Error('fixture_campaign_failed');
 const {error:b}=await c.from('opportunities').insert({id:opportunityId,campaign_id:campaignId,organization_id:p.organizationId,event_key:eventKey(url),packet:{mode:'fixture',state:'discovered',evidence:[],candidate:{url,title:'Fixture · review research verification',description:'Synthetic UI/API verification. No provider calls.',source:'fixture',eventKey:eventKey(url),country:'US',language:'en',discoveredAt:new Date().toISOString()}}});if(b)throw new Error('fixture_opportunity_failed');
 console.log('Created a labeled fixture in a paused campaign; worker execution is disabled for it.');
}else{
 const p=JSON.parse(await readFile(path,'utf8'));
 if(action==='check'){
  const [o,j,campaign]=await Promise.all([c.from('opportunities').select('revision,state').eq('id',p.opportunityId).single(),c.from('jobs').select('id,stage,status,input_version,payload').eq('campaign_id',p.campaignId),c.from('campaigns').select('paused').eq('id',p.campaignId).single()]);
  if(o.error||j.error||campaign.error||!campaign.data.paused||o.data.revision!==2||j.data.length!==1||j.data[0].status!=='queued'||!j.data[0].payload.researchRequest)throw new Error('review_workflow_verification_failed');
  console.log(JSON.stringify({evidence:'hosted_browser_API_database_fixture',revision:o.data.revision,state:o.data.state,queuedJobs:j.data.length,stage:j.data[0].stage,paidCalls:0}));
 }else if(action==='cleanup'){
  for(const table of ['reviews','jobs','opportunities'] as const){const {error}=await c.from(table).delete().eq(table==='reviews'?'opportunity_id':table==='jobs'?'campaign_id':'id',table==='jobs'?p.campaignId:p.opportunityId);if(error)throw new Error('fixture_cleanup_failed');}
  const {error}=await c.from('campaigns').delete().eq('id',p.campaignId);if(error)throw new Error('fixture_campaign_cleanup_failed');await unlink(path);console.log('Removed only the verification fixture and its queued work.');
 }else throw new Error('use_create_check_or_cleanup');
}
