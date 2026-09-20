/** Offline only: read an explicit saved audit path; never create a client, load credentials or queue work. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {Packet} from '../src/contracts/pipeline';
import {hash,validateResearch,reviewProblems} from '../src/domain/policy';
import {companyIdentity,reviewPlacement} from '../src/domain/opportunity-review';
import {attachProviderObservations,type SavedOperation} from '../src/domain/provider-evidence';
import {resolveCompanyFacts} from '../src/domain/fact-resolution';
import {recoveryPlan} from '../src/domain/recovery';
import {companyMatches,roleScore,intentBuyerTitle,ApolloContacts} from '../src/providers/apollo';
import {collectCompanyContext} from '../src/stages/company-context';
import {extractEvidence} from '../src/capture/fetch';
import {attributeCompanyEvidence} from '../src/domain/evidence-attribution';
import {beginRepair,finishRepair} from '../src/domain/repair';
import {modelTextFormat} from '../src/ai/format';
import {Research,Review} from '../src/contracts/pipeline';
const path=process.argv[2];if(!path)throw Error('usage: tsx scripts/kvd101-recovery-dry-run.ts SAVED_AUDIT_PATH [OUTPUT_PATH]');
const raw=await readFile(path,'utf8'),snapshot=JSON.parse(raw) as {at:string;opportunities:{id:string;packet:unknown}[];provider_operations:SavedOperation[]};
const packets=snapshot.opportunities.map(row=>({id:row.id,p:Packet.parse(row.packet)}));
const rows=[];let searchCalls=0,fetchCalls=0;
for(const {id,p:original} of packets){
 const identity=companyIdentity(original);if(!identity)continue;
 const p=structuredClone(original),before=hash(original);attachProviderObservations(p,snapshot.provider_operations);
 const fact=p.candidate?.providerCompany?resolveCompanyFacts(p):null,plan=recoveryPlan(p);
 const apollo=snapshot.provider_operations.filter(o=>o.opportunity_id===id&&o.provider==='apollo'&&o.state==='succeeded').findLast(o=>Array.isArray((o.response as {body?:{people?:unknown[]}})?.body?.people));
 const people=(apollo?.response as {body?:{people?:{title?:string;organization?:{name?:string}}[]}})?.body?.people??[];
 const role=p.research?.buyerRole??'',company=p.research?.company??identity.name;
 const buyers=people.filter(v=>companyMatches(v.organization?.name??'',company,p)&&roleScore(v.title??'',role)>=20&&intentBuyerTitle(v.title??''));
 if(apollo&&p.research){
  // Any request or operation would fail this dry run. A saved search must be reused even with no buyer.
  const contact=await new ApolloContacts({run:async()=>{throw Error('unexpected_provider_operation');}},null,async()=>{throw Error('unexpected_network');},apollo.response).resolve(p.research.accountHost,role,company,p.candidate?.providerCompany?.provider==='explorium',p);
  assert.equal(contact.state,'contact_pending');
 }
 if(p.providerObservations?.length&&p.research){
  const o=p.providerObservations[0],claim={id:'offline_provider_report',text:o.statement,kind:'fact' as const,evidenceId:o.id,quote:'',material:true};
  assert(!validateResearch({...p.research,claims:[...p.research.claims,claim]},p).some(e=>e.endsWith(':offline_provider_report')));
  assert(validateResearch({...p.research,claims:[{...claim,text:'Maybe this company is buying a new CRM.'}]},p).some(e=>e==='Invalid provider assertion:offline_provider_report'));
 }
 if(p.candidate?.providerCompany&&p.evidence.length&&fact?.status==='match'&&!p.contextSearch){
  const replay=structuredClone(p),ids=p.evidence.map(e=>e.id);
  await collectCompanyContext(replay,{search:async()=>{searchCalls++;return [];},fetchEvidence:async()=>{fetchCalls++;throw Error('offline_source_unavailable');}});
  assert(ids.every(id=>replay.evidence.some(e=>e.id===id)));
  if(replay.contextSearch?.coverage==='general')assert(replay.contextSearch.queries.length>0);
 }
 assert.equal(hash(original),before);assert.equal(hash(p.draft??null),hash(original.draft??null));assert.equal(hash(p.contact??null),hash(original.contact??null));
 rows.push({company:identity.name,state:original.state,checked:reviewPlacement(original).checked,demand:original.research?.demand??null,decision:original.research?.decision??null,originals:original.evidence.filter(e=>e.origin==='original').length,providerObservations:p.providerObservations?.length??0,eligibility:fact?.status??'legacy source',recoveryStage:plan.stage,reused:plan.reused,missing:plan.missing,savedApolloPeople:people.length,eligibleBuyerCandidates:buyers.length,contact:original.contact?.state??'unassessed',incrementalCalls:0});
}
// Source contracts and convergence are checked offline, not represented as live evidence.
const company={name:'Example Company',domain:'example.invalid'};
const html='<html><title>Example announces a completed rollout</title><script type="application/ld+json">{"@type":"NewsArticle","author":{"@type":"Organization","name":"Example Company","url":"https://example.invalid"},"datePublished":"2025-01-01"}</script><main>Example Company announced that its website rollout has been completed. The completed work is historical context and does not establish a current request for new services.</main></html>';
const release=attributeCompanyEvidence(extractEvidence('https://wire.invalid/release','https://wire.invalid/release',html),company);
assert.equal(release.accountHost,company.domain);assert.equal(release.attribution?.publisherHost,'wire.invalid');assert.equal(release.publishedAt,'2025-01-01');
const mention=attributeCompanyEvidence(extractEvidence('https://wire.invalid/article','https://wire.invalid/article',html.replace(/<script[\s\S]*?<\/script>/,'')),company);assert.notEqual(mention.accountHost,company.domain);
const repairPacket=structuredClone(packets[0].p);assert(beginRepair(repairPacket,'offline',['Unsupported premise'],{claim:'unchanged'}));assert.equal(finishRepair(repairPacket,'offline',{claim:'unchanged'}),false);assert.equal(beginRepair(repairPacket,'offline',['Unsupported premise'],{claim:'unchanged'}),false);
modelTextFormat(Research,'research_kvd101');modelTextFormat(Review,'review_kvd101');
assert.equal(await readFile(path,'utf8'),raw);
const output={asOf:snapshot.at,scope:'Offline saved-packet/schema and recovery selection; no providers, database writes, model calls or human quality ratings',records:packets.length,identifiedCompanies:rows.length,checkedDrafts:rows.filter(r=>r.checked&&r.decision!=='disqualified').length,observedExplorationShare:rows.filter(r=>r.checked).length?rows.filter(r=>r.checked&&r.decision==='exploration').length/rows.filter(r=>r.checked).length:null,contextReplay:{savedPackets:true,stubSearchCalls:searchCalls,stubFetchCalls:fetchCalls},rows};
const outputPath=process.argv[3]??'.local/kvd101-recovery-dry-run.json';if(resolve(outputPath)===resolve(path))throw Error('output_must_not_overwrite_snapshot');await mkdir(resolve(outputPath,'..'),{recursive:true});await writeFile(outputPath,JSON.stringify(output,null,2),{mode:0o600});
console.log(JSON.stringify({records:output.records,identifiedCompanies:output.identifiedCompanies,checkedDrafts:output.checkedDrafts,output:outputPath,externalCalls:0}));
