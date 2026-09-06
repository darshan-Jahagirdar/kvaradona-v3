import {readFile,writeFile,unlink} from 'node:fs/promises';
import {serviceClient} from '../src/persistence/client';
import {reviewFixture} from '../tests/fixtures/review-packet';
const c=serviceClient(),project=JSON.parse(await readFile('.local/project.json','utf8')),path='.local/quality-ui-fixture.json';
if(process.argv[2]==='create'){
 const packet=reviewFixture();packet.research!.company='Fixture · procurement quality review';packet.candidate={url:'https://example.invalid/notice',title:'Fixture procurement notice',description:'Synthetic UI verification',source:'contracts_finder',eventKey:'quality-ui-fixture',country:'GB',language:'en',discoveredAt:new Date().toISOString(),procurementNotice:{source:'contracts_finder',noticeId:'fixture-only',solicitationNumber:'fixture',buyer:'Fixture Council',buyerCode:'fixture',title:'Fixture CRM review',url:'https://example.invalid/notice',postedAt:new Date().toISOString(),observedAt:new Date().toISOString(),type:'Solicitation',baseType:'tender',active:'yes',deadlineRaw:'2027-01-01T00:00:00Z',deadlineUtc:'2027-01-01T00:00:00Z',archiveDate:null,setAside:null,naics:null,awarded:false,descriptionUrl:null,attachmentUrls:[],snapshotHash:'fixture'}};
 packet.draft!.procurement={requirements:[{requirement:'Fixture CRM outline',evidenceId:packet.evidence[0].id,quote:packet.evidence[0].text,response:'A proposed discovery approach for this synthetic UI case.',status:'proposed_approach'}],responseRoute:null,missingInputs:['Synthetic fixture. No real bidder details or submission.']};
 const camp=await c.from('campaigns').insert({organization_id:project.organizationId,name:'Fixture · quality UI',profile:{fixture:true},paused:true}).select('id').single();if(camp.error)throw Error('fixture_campaign_failed');
 const row=await c.from('opportunities').insert({organization_id:project.organizationId,campaign_id:camp.data.id,event_key:'quality-ui-fixture',packet,state:'review_ready'}).select('id').single();if(row.error)throw Error('fixture_opportunity_failed');await writeFile(path,JSON.stringify({campaignId:camp.data.id,opportunityId:row.data.id}),{mode:0o600,flag:'wx'});console.log('Paused synthetic review fixture created.');
}else if(process.argv[2]==='cleanup'){
 const f=JSON.parse(await readFile(path,'utf8'));const row=await c.from('opportunities').select('packet').eq('id',f.opportunityId).single();if(row.error||row.data.packet.mode!=='fixture')throw Error('fixture_scope_required');
 const labels=await c.from('quality_labels').select('labels,revision,packet_hash').eq('opportunity_id',f.opportunityId);if(labels.error||labels.data.length!==1)throw Error('one_fixture_quality_label_required');
 await writeFile('.local/quality-ui-outcome.json',JSON.stringify({labels:labels.data,synthetic:true,realHumanLabels:false}),{mode:0o600});
 const q=await c.from('quality_labels').delete().eq('opportunity_id',String(f.opportunityId));if(q.error)throw Error('fixture_cleanup_failed');
 const o=await c.from('opportunities').delete().eq('id',String(f.opportunityId));if(o.error)throw Error('fixture_cleanup_failed');
 const k=await c.from('campaigns').delete().eq('id',String(f.campaignId));if(k.error)throw Error('fixture_cleanup_failed');
 await unlink(path);console.log('Synthetic quality label verified and all fixture rows removed.');
}else throw Error('use_create_or_cleanup');
