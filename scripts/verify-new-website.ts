import{readFile,writeFile}from'node:fs/promises';
import{serviceClient}from'../src/persistence/client';
import{Packet}from'../src/contracts/pipeline';
import{WebsiteCapture}from'../src/contracts/website';
import{storeWebsiteCapture}from'../src/persistence/website-artifacts';
import{captureEvidence,websiteInputHash}from'../src/domain/website-specialist';
import{hash,validateResearch}from'../src/domain/policy';
const c=serviceClient(),run=JSON.parse(await readFile('.local/completion-run.json','utf8')),path='.local/completion-website-attempt.json';
if(process.argv[2]==='capture'){
 const rows=await c.from('opportunities').select('*').eq('campaign_id',run.campaignId).order('created_at');if(rows.error)throw Error('candidate_read_failed');
 const row=rows.data.find(row=>{const r=Packet.safeParse(row.packet);return r.success&&r.data.mode==='live'&&!r.data.candidate?.procurementNotice&&!r.data.websiteSupplement&&r.data.research&&!validateResearch(r.data.research,r.data).length;});if(!row)throw Error('new_attributed_candidate_required');
 const host=row.packet.research.accountHost,question='Explore the clarity of the public offer, next-step CTAs, mobile navigation and answer structure. Do not infer website defects or buying intent; zero findings is valid.';
 await writeFile(path,JSON.stringify({opportunityId:row.id,host,question,at:new Date().toISOString(),attemptCeiling:1,state:'dispatched'}),{mode:0o600,flag:'wx'});
 await writeFile('.local/backups/completion-website-preflight.json',JSON.stringify(row),{mode:0o600});
 try{const capture=await storeWebsiteCapture(`https://${host}/`,host,row.organization_id,`${row.id}:bounded-website-completion`);await writeFile('.local/completion-website-capture.json',JSON.stringify(capture),{mode:0o600});console.log(JSON.stringify({complete:capture.complete,stable:capture.renderStable,requests:capture.requests,facts:capture.facts.length,bytes:capture.bytes,elapsedMs:capture.elapsedMs}));}catch{await writeFile('.local/completion-website-failure.json',JSON.stringify({at:new Date().toISOString(),reason:'capture_unavailable',attempts:1,modelCalls:0}),{mode:0o600});console.log('Capture unavailable; saved failure, no retry or model call.');}
}else if(process.argv[2]==='attach'){
 const attempt=JSON.parse(await readFile(path,'utf8'));let capture;try{capture=WebsiteCapture.parse(JSON.parse(await readFile('.local/completion-website-capture.json','utf8')));}catch(e){if(!(e instanceof Error&&'code' in e&&e.code==='ENOENT'))throw e;}
 const failure=capture?null:JSON.parse(await readFile('.local/completion-website-failure.json','utf8'));const [row,jobs]=await Promise.all([c.from('opportunities').select('*').eq('id',attempt.opportunityId).single(),c.from('jobs').select('id').eq('opportunity_id',attempt.opportunityId).in('status',['queued','running'])]);if(row.error||jobs.error||jobs.data.length)throw Error('wait_for_existing_opportunity_work');
 const p=Packet.parse(row.data.packet);if(p.research?.accountHost!==attempt.host||p.websiteSupplement)throw Error('capture_attachment_precondition');
 p.websiteRequest={profiles:['cro','aeo'],url:`https://${attempt.host}/`,question:attempt.question,requestedAt:attempt.at,verificationOnly:true};if(capture){p.websiteSupplement={inputHash:websiteInputHash(p),profiles:['cro','aeo'],question:attempt.question,capture};p.evidence.push(captureEvidence(capture));}else{p.websiteFailure={inputHash:websiteInputHash(p),reason:failure.reason,at:failure.at};p.notes.push('The one bounded website capture failed; no findings or website model call were produced.');}
 await writeFile('.local/backups/completion-website-attach.json',JSON.stringify(row.data),{mode:0o600});
 const q=await c.from('jobs').upsert({organization_id:row.data.organization_id,campaign_id:row.data.campaign_id,opportunity_id:row.data.id,business_key:`${row.data.id}:website:${capture?.id??'recorded-failure'}`,stage:'S08',input_hash:hash(p),input_version:row.data.revision,schema_version:'1',prompt_version:'11',payload:p},{onConflict:'organization_id,business_key',ignoreDuplicates:true});if(q.error)throw Error('capture_queue_failed');console.log(JSON.stringify({queued:true,complete:capture?.complete??false,priorDraftPreserved:true}));
}else throw Error('use_capture_or_attach');
