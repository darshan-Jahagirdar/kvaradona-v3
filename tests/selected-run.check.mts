/** Focused checks for the consequential new behaviour only. Pure functions, sanitized fixtures,
 *  no database, no provider, no credentials. */
import {classifyFailure} from '../src/domain/failure-policy.ts';
import {selectedRunSummary,meetsUsefulFloor} from '../src/domain/selected-run.ts';
let fail=0;
const t=(name:string,got:unknown,want:unknown)=>{const ok=JSON.stringify(got)===JSON.stringify(want);if(!ok)fail++;
 console.log(ok?'  PASS':'  FAIL',name,'->',JSON.stringify(got),ok?'':'(want '+JSON.stringify(want)+')');};

console.log('failure classification — an uncertain paid dispatch is never retried');
t('ambiguous_provider_operation',classifyFailure('ambiguous_provider_operation'),'hold');
t('unknown_usage_requires_reconciliation',classifyFailure('unknown_usage_requires_reconciliation'),'hold');
t('ownership_lost',classifyFailure('ownership_lost'),'hold');
t('stale_version',classifyFailure('stale_version'),'hold');
console.log('  — transient infrastructure retries');
t('saved_search_read_failed',classifyFailure('saved_search_read_failed'),'retry');
t('company_evidence_lookup_failed',classifyFailure('company_evidence_lookup_failed'),'retry');
t('heartbeat_failed',classifyFailure('heartbeat_failed'),'retry');
console.log('  — a rejected COMPLETED output is not requeued: the same key replays the same response');
t('invalid_repaired_draft_identity_or_claims',classifyFailure('invalid_repaired_draft_identity_or_claims'),'stop');
t('invalid_draft_identity_or_claims',classifyFailure('invalid_draft_identity_or_claims'),'stop');
console.log('  — provider gates and unknown reasons stop');
t('budget_paused',classifyFailure('budget_paused'),'stop');
t('provider_unverified',classifyFailure('provider_unverified'),'stop');
t('stage_validation_or_provider_failure',classifyFailure('stage_validation_or_provider_failure'),'stop');

console.log('\nrun attribution — launch alone must not count as produced');
const base={mode:'live',state:'review_ready',evidence:[],notes:[],candidate:{},contact:{state:'resolved',name:'A',role:'R',email:'a@b.com'}};
// The launcher bumps revision immediately, so entry_revision is the POST-launch revision and
// result_revision stays null until a stage of this run completes.
const justLaunched=selectedRunSummary({run:{id:'r1'},jobs:[{id:'j',opportunityId:'o',stage:'S06',status:'queued',attempts:0,error:null}],
 members:[{opportunityId:'o',entryRevision:6,currentRevision:6,resultRevision:null,state:'research_requested',entryState:'review_ready',queuedStage:'S06',packet:base}]});
t('queued member is pending',justLaunched.members[0].outcome,'pending');
t('queued member not produced',justLaunched.members[0].producedInThisRun,false);
t('pending never meets the floor',meetsUsefulFloor(justLaunched.members[0]),false);
t('phase is running',justLaunched.phase,'running');

const completed=selectedRunSummary({run:{id:'r1'},jobs:[{id:'j',opportunityId:'o',stage:'S11',status:'done',attempts:1,error:null}],
 members:[{opportunityId:'o',entryRevision:6,currentRevision:7,resultRevision:7,state:'review_ready',entryState:'review_ready',queuedStage:'S06',packet:base}]});
t('completed member is updated',completed.members[0].outcome,'updated');
t('completed member produced',completed.members[0].producedInThisRun,true);

// A later run moving the packet past this run's recorded result must not be reported as ours.
const superseded=selectedRunSummary({run:{id:'r1'},jobs:[{id:'j',opportunityId:'o',stage:'S11',status:'done',attempts:1,error:null}],
 members:[{opportunityId:'o',entryRevision:6,currentRevision:9,resultRevision:7,state:'review_ready',entryState:'review_ready',queuedStage:'S06',packet:base}]});
t('later run supersedes this result',superseded.members[0].outcome,'superseded');
t('superseded is not produced here',superseded.members[0].producedInThisRun,false);
t('superseded cannot meet the floor',meetsUsefulFloor(superseded.members[0]),false);

const untouched=selectedRunSummary({run:{id:'r1'},jobs:[],
 members:[{opportunityId:'o',entryRevision:6,currentRevision:6,resultRevision:null,state:'review_ready',entryState:'review_ready',queuedStage:'S06',packet:base}]});
t('no completed stage is reused',untouched.members[0].outcome,'reused');
t('reused cannot meet the floor',meetsUsefulFloor(untouched.members[0]),false);
t('empty queue below target is not success',untouched.phase,'finished_below_target');

console.log('\ntechnical floor — every element is required');
const card={opportunityId:'x',name:'N',host:'h',state:'review_ready',stage:null,attempts:1,outcome:'new' as const,
 producedInThisRun:true,entryRevision:1,resultRevision:2,currentRevision:2,
 finding:'A specific supported fact.',offer:'A concrete offer.',
 contact:{name:'P',role:'R',email:'p@x.com',state:'resolved',boundToDraft:true},
 draft:{subject:'S',body:'B',checked:true,recipient:'p@x.com'},sources:[],readiness:null,blockedReason:null};
t('complete card passes',meetsUsefulFloor(card),true);
t('no finding fails',meetsUsefulFloor({...card,finding:null}),false);
t('no offer fails',meetsUsefulFloor({...card,offer:null}),false);
t('unresolved contact fails',meetsUsefulFloor({...card,contact:{...card.contact,state:'contact_pending'}}),false);
t('contact not bound to draft fails',meetsUsefulFloor({...card,contact:{...card.contact,boundToDraft:false}}),false);
t('unchecked draft fails',meetsUsefulFloor({...card,draft:{...card.draft,checked:false}}),false);
t('not produced in run fails',meetsUsefulFloor({...card,producedInThisRun:false}),false);
t('incomplete state fails',meetsUsefulFloor({...card,state:'researching'}),false);

console.log('\njob status drives outcome');
const blocked=selectedRunSummary({run:{id:'r'},members:[
 {opportunityId:'o1',entryRevision:1,currentRevision:1,resultRevision:null,state:'researching',entryState:'x',queuedStage:'S06',packet:base}],
 jobs:[{id:'j',opportunityId:'o1',stage:'S06',status:'blocked',attempts:3,error:'ambiguous_provider_operation'}]});
t('blocked member needs attention',blocked.members[0].outcome,'failed');
t('blocked reason surfaced',blocked.members[0].blockedReason,'ambiguous_provider_operation');
t('failures change the phase',blocked.phase,'finished_with_failures');

console.log('\n'+(fail?fail+' FAILED':'all passed'));
process.exit(fail?1:0);
