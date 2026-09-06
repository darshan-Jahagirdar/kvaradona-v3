import {readFile,writeFile,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {serviceClient} from '../src/persistence/client';
import {reviewFixture} from '../tests/fixtures/review-packet';
import {hash} from '../src/domain/policy';
const c=serviceClient(),action=process.argv[2],path='.local/draft-review-fixture.json';
if(action==='create'){
 const project=JSON.parse(await readFile('.local/project.json','utf8')),campaignId=randomUUID(),opportunityId=randomUUID(),packet=reviewFixture();
 packet.research!.company='Fixture · draft review workflow';
 packet.packetReview!.inputHash=hash(JSON.stringify(packet.research));
 await writeFile(path,JSON.stringify({campaignId,opportunityId,packet}),{mode:0o600,flag:'wx'});
 const {error:a}=await c.from('campaigns').insert({id:campaignId,organization_id:project.organizationId,name:'Fixture · draft review workflow',profile:{mode:'fixture'},paused:true});if(a)throw Error('fixture_campaign_failed');
 const {error:b}=await c.from('opportunities').insert({id:opportunityId,organization_id:project.organizationId,campaign_id:campaignId,event_key:hash(opportunityId),state:packet.state,packet});if(b)throw Error('fixture_opportunity_failed');
 console.log('Created a synthetic draft in a paused campaign.');
}else{
 const fixture=JSON.parse(await readFile(path,'utf8'));
 const [{data:row,error},{data:jobs,error:je},{data:reviews,error:re},{data:campaign,error:ce}]=await Promise.all([c.from('opportunities').select('revision,state,packet').eq('id',fixture.opportunityId).single(),c.from('jobs').select('id,stage,status,input_version,payload').eq('campaign_id',fixture.campaignId),c.from('reviews').select('revision,action,snapshot').eq('opportunity_id',fixture.opportunityId).order('revision'),c.from('campaigns').select('paused').eq('id',fixture.campaignId).single()]);
 if(error||je||re||ce||!campaign.paused)throw Error('fixture_read_or_pause_failed');
 if(action==='check'){
  await writeFile('.local/draft-review-fixture-outcome.json',JSON.stringify({row,jobs,reviews},null,2),{mode:0o600});
  console.log(JSON.stringify({revision:row.revision,state:row.state,subject:row.packet.draft?.subject,draftReviewPresent:Boolean(row.packet.draftReview),actions:reviews.map(r=>r.action),jobs:jobs.map(j=>({stage:j.stage,status:j.status,version:j.input_version})),originalDraftPreserved:isDeepStrictEqual(reviews[0]?.snapshot.draft,fixture.packet.draft)}));
 }else if(action==='cleanup'){
  if(row.packet.mode!=='fixture'||reviews.length!==5||row.revision!==6||row.state!=='research_requested'||jobs.filter(j=>j.status==='queued').length!==1||jobs.find(j=>j.status==='queued')?.stage!=='S06')throw Error('fixture_acceptance_incomplete');
  for(const table of ['reviews','jobs','opportunities'] as const){const {error:e}=await c.from(table).delete().eq(table==='reviews'?'opportunity_id':table==='jobs'?'campaign_id':'id',table==='jobs'?fixture.campaignId:fixture.opportunityId);if(e)throw Error('fixture_cleanup_failed');}
  const {error:e}=await c.from('campaigns').delete().eq('id',fixture.campaignId);if(e)throw Error('fixture_cleanup_failed');await unlink(path);console.log('Verified and removed only the paused fixture and its jobs/reviews.');
 }else throw Error('use_create_check_or_cleanup');
}
