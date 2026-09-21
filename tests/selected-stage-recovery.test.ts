import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Packet,Job} from '../src/contracts/pipeline';
import {runStage,type StageTools} from '../src/stages/pipeline';
import {ApolloContacts,searchParams} from '../src/providers/apollo';
import {draftIsChecked} from '../src/domain/selected-run';
import {hash} from '../src/domain/policy';
import {host,company,ROLE,SERVICE,savedSearch,webManager,webManagerPerson} from './fixtures/contact-search';

const now=new Date().toISOString();
/** One stage invocation, exactly as the worker performs it: the packet in, the persisted packet and
 *  the queued successor out. */
async function step(stage:string,p:Packet,tools:Partial<StageTools>){
 let output:Packet|undefined,next:any;
 const job=Job.parse({id:randomUUID(),organization_id:randomUUID(),campaign_id:randomUUID(),opportunity_id:randomUUID(),
  stage,business_key:`selected-${stage}`,input_hash:'h',input_version:1,schema_version:'1',prompt_version:'7',
  attempt_token:randomUUID(),attempts:1,payload:p});
 await runStage({async rpc(_n,args:any){output=Packet.parse(args.p_output);next=args.p_next;return true;}},job,
  {ai:{generate:async()=>{throw Error('unexpected_model_call');}},
   fetchEvidence:async()=>{throw Error('unexpected_fetch');},search:async()=>[],
   relationship:async()=>'clear',contact:async()=>{throw Error('unexpected_contact');},...tools} as unknown as StageTools);
 return {output:output!,next};
}

// ---------------------------------------------------------------------------------------------
// A selected recovery resumes the step that is actually affected.
// ---------------------------------------------------------------------------------------------

const evidenceId=randomUUID();
const fact='v4c.ai published a Databricks migration services page in March 2026.';
function researched(extra:Record<string,unknown>={}){
 const p=Packet.parse({mode:'fixture',state:'contact_pending',notes:[],contractVersion:'kvd101',
  recovery:{version:'kvd101',reason:'selected_run',stage:'S10',requestedAt:now,retryUrls:[],
   selectedRun:'70000000-0000-4000-8000-000000000001'},
  evidence:[{id:evidenceId,url:`https://${host}/services`,finalUrl:`https://${host}/services`,accountHost:host,
   origin:'original',source:'original_web',title:'Services',contentHash:hash(fact),retrievedAt:now,
   publishedAt:'2026-03-19T00:00:00Z',status:'unknown',text:fact}],
  research:{company,accountHost:host,identityBasis:fact,service:SERVICE,demand:'plausible',whyNow:fact,
   offer:'A scoped conversion review of the services path.',buyerRole:ROLE,
   claims:[{id:'c1',kind:'fact',material:true,text:fact,quote:fact,evidenceId}],
   contrary:[],uncertainties:[],decision:'exploration',reason:'r',watchTrigger:null,specialist:'none',specialistReason:'r',followUp:null},
  ...extra});
 p.packetReview={acceptable:true,issues:[],inputHash:hash(JSON.stringify(p.research)),
  verdicts:[{claimId:'c1',verdict:'supported',evidenceIds:[evidenceId],repair:''}]};
 return p;
}

/** The real adapter, answering from the sanitized saved search plus canned alternative responses. */
function apollo(bodies:Record<string,unknown>){
 const calls:string[]=[];
 const ops={async run(key:string,_p:string,_r:unknown,_m:string,_u:number,schema:z.ZodType<any>){
  calls.push(key);return schema.parse({httpStatus:200,body:bodies[key]??{people:[]}});}};
 const history={operations:[{id:'op',provider:'apollo',state:'succeeded',actual_usd:'0',created_at:now,
  operation_key:'job:contact_search',response:savedSearch,
  request_hash:hash({endpoint:'mixed_people/api_search',params:searchParams(host,
   ['Head of Marketing','marketing','growth','digital'])})}]};
 const allowance={remaining:75,expiresAt:new Date(Date.now()+3600000).toISOString(),
  evidence:'Fixture: user-confirmed free quota only',verifiedFree:true};
 return {calls,contact:(h:string,role:string,c:string,packet?:Packet)=>
  new ApolloContacts(ops as any,allowance,fetch,history as any).resolve(h,role,c,false,packet,SERVICE)};
}

it('resumes at the contact step, resolves through an alternative search and rebinds the draft',async()=>{
 const api=apollo({contact_search_alt_1:{people:[webManager]},contact_enrichment:{person:webManagerPerson}});
 // A draft written before the contact existed, with no recipient bound.
 const p=researched({draft:{subject:'A scoped conversion review',
  body:`Hello,\n\n${fact}\n\nWould a scoped review of that path be useful?`,recipient:null,sender:null,claimIds:['c1']}});
 p.draftReview={acceptable:true,issues:[],inputHash:hash(JSON.stringify(p.draft)),
  verdicts:[{claimId:'c1',verdict:'supported',evidenceIds:[evidenceId],repair:''}]};

 const contactStep=await step('S10',p,{contact:api.contact});
 // A2 was never called: the saved research and its check are reused as they stand.
 expect(contactStep.output.research).toEqual(p.research);
 expect(contactStep.output.contact?.state).toBe('resolved');
 expect(contactStep.output.contact?.email).toBe('robin@v4c.ai');
 // The saved unreachable people are preserved beside the resolved one.
 expect(contactStep.output.contact?.candidates?.length).toBeGreaterThanOrEqual(3);
 // The draft is rebound to the new recipient and its stale check is dropped rather than carried.
 expect(contactStep.output.draft?.recipient).toBe('robin@v4c.ai');
 expect(contactStep.output.draftReview).toBeUndefined();
 expect(contactStep.next).toMatchObject({stage:'S11'});
 expect(api.calls).toEqual(['contact_search_alt_1','contact_enrichment']);

 // S11 checks the rebound draft, which completes the package.
 const accept=(input:any)=>({acceptable:true,issues:[],inputHash:input.inputHash,
  verdicts:[{claimId:'c1',verdict:'supported',evidenceIds:[evidenceId],repair:''}],
  writing:{acceptable:true,issues:[],relevance:'clear',offerClarity:'clear',naturalWriting:'clear',nextStep:'clear'}});
 const draftStep=await step('S11',contactStep.output,{ai:{async generate(role:string,_k:string,schema:any,_i:unknown,input:any){
  return schema.parse(role==='A4'
   ?{subject:'A scoped conversion review',body:`Hello,\n\n${fact}\n\nWould a scoped review of that path be useful?`,
     recipient:'robin@v4c.ai',sender:null,claimIds:['c1']}
   :accept(input));}}});
 expect(draftStep.output.state).toBe('review_ready');
 expect(draftStep.output.draft?.recipient).toBe('robin@v4c.ai');
 expect(draftIsChecked(draftStep.output)).toBe(true);
});

it('does not buy a contact again when one is already resolved',async()=>{
 const api=apollo({});
 const p=researched({contact:{name:'Robin Kelley',role:'Web Manager',email:'robin@v4c.ai',
  emailStatus:'provider_verified',employmentEvidence:'e',source:'apollo',observedAt:now,
  state:'resolved',reason:'r',candidates:[]}});
 const out=await step('S10',p,{contact:api.contact});
 expect(api.calls).toHaveLength(0);
 expect(out.output.contact?.email).toBe('robin@v4c.ai');
});

// ---------------------------------------------------------------------------------------------
// A selected careers record: automatic identification, then a reviewer's answer.
// ---------------------------------------------------------------------------------------------

function jsonLd(url:string,json:object){
 const rawJson=JSON.stringify(json);
 return {id:'jd',rawJson,sourceUrl:url,scriptIndex:0,contentHash:hash(rawJson)};
}
function atsPacket(extra:Record<string,unknown>={}){
 return Packet.parse({mode:'fixture',state:'discovered',notes:[],contractVersion:'kvd101',
  recovery:{version:'kvd101',reason:'selected_run',stage:'S04',requestedAt:now,retryUrls:[]},
  eligibility:{basis:'user_accepted_cohort',cohort:'selected run',
   acceptedNote:'Chosen by a reviewer for this selected-company run.',employeeRange:{min:200},countries:['US']},
  // A general careers index: the discovery-quality stop that ended Harvey at source_pending.
  candidate:{url:'https://jobs.ashbyhq.com/example',title:'Example Employer Jobs',description:'Open roles',
   source:'brave',eventKey:'k',country:'US',language:'en',discoveredAt:now},
  evidence:[],...extra});
}
const employerPage=(host:string,name:string)=>({id:randomUUID(),url:`https://${host}/`,finalUrl:`https://${host}/`,
 accountHost:null,title:name,text:'x'.repeat(200),contentHash:'h',retrievedAt:now,publishedAt:null,
 source:'original_web',origin:'original',status:'unknown',
 companyFacts:[{id:randomUUID(),field:'name',value:name,
  statement:`Company-published structured data reports name: ${name}.`,sourceRef:{sourceId:'jd',pointers:['/name']}}],
 structuredSources:[jsonLd(`https://${host}/`,{'@context':'https://schema.org','@type':'Organization',name,url:`https://${host}/`})]});

it('identifies a selected careers record from its own raw structured data and continues normally',async()=>{
 const fetched:string[]=[];
 const board={id:randomUUID(),url:'https://jobs.ashbyhq.com/example',finalUrl:'https://jobs.ashbyhq.com/example',
  accountHost:null,title:'Example Employer careers',text:'Open roles',contentHash:'h',retrievedAt:now,publishedAt:null,
  source:'job_posting_web',origin:'original',status:'unknown',
  structuredSources:[jsonLd('https://jobs.ashbyhq.com/example',{'@context':'https://schema.org','@type':'JobPosting',
   hiringOrganization:{'@type':'Organization',name:'Example Employer',url:'https://example-employer.test/'}})],
  attribution:{publisherHost:'jobs.ashbyhq.com',issuerName:'Example Employer',issuerHost:'example-employer.test',
   basis:'structured_employer',sourceType:'job',quote:'',sourceRef:{sourceId:'jd',pointers:['/hiringOrganization/name','/hiringOrganization/url']}}};
 const out=await step('S04',atsPacket(),{
  fetchEvidence:async(url:string)=>{fetched.push(url);
   if(url==='https://jobs.ashbyhq.com/example')return board as any;
   return employerPage('example-employer.test','Example Employer') as any;},
  search:async()=>[]});
 expect(out.output.candidate?.providerCompany?.domain).toBe('example-employer.test');
 // Nothing is invented for the identified company.
 expect(out.output.candidate?.providerCompany?.employees).toBeNull();
 // The listing is read ONCE: the identified company continues along the ordinary company path,
 // which reads the company's own pages rather than the same board again.
 expect(fetched.filter(u=>u==='https://jobs.ashbyhq.com/example')).toHaveLength(1);
 expect(out.output.contextSearch).toBeDefined();
 expect(out.output.pendingResolution).toBeUndefined();
});

it('asks the reviewer only after automatic identification is exhausted',async()=>{
 const out=await step('S04',atsPacket(),{
  fetchEvidence:async()=>({id:randomUUID(),url:'https://jobs.ashbyhq.com/example',finalUrl:'https://jobs.ashbyhq.com/example',
   accountHost:null,title:'Careers',text:'JavaScript is required to view this page.',contentHash:'h',
   retrievedAt:now,publishedAt:null,source:'job_posting_web',origin:'original',status:'unknown'} as any)});
 expect(out.output.state).toBe('source_pending');
 expect(out.output.candidate?.providerCompany).toBeUndefined();
 expect(out.output.pendingResolution?.nextAction).toBe('ask_reviewer');
 expect(out.output.pendingResolution?.question).toContain('Which company');
 expect(out.next).toBeNull();
});

it('verifies a reviewer answer against the named company\'s own page before using it',async()=>{
 const answered=atsPacket({identityHint:{name:'Example Employer',domain:'example-employer.test',
  note:'This is the Example Employer board.',reviewerId:randomUUID(),at:now,status:'unverified'},
  pendingResolution:{reason:'identity_unresolved',detail:'answered',attempts:0,nextAction:'retry_resolution',at:now}});
 const out=await step('S04',answered,{
  fetchEvidence:async(url:string)=>{
   if(url==='https://example-employer.test')return employerPage('example-employer.test','Example Employer') as any;
   throw Error('unexpected_fetch');},
  search:async()=>[]});
 expect(out.output.identityHint?.status).toBe('verified');
 expect(out.output.candidate?.providerCompany?.name).toBe('Example Employer');
 expect(out.output.notes.join(' ')).toContain('not accepted on trust');

 // An answer the named company's own page does not support is refused and recorded as refuted.
 const wrong=atsPacket({identityHint:{name:'Some Other Company',domain:'example-employer.test',
  note:'A guess.',reviewerId:randomUUID(),at:now,status:'unverified'},
  pendingResolution:{reason:'identity_unresolved',detail:'answered',attempts:0,nextAction:'retry_resolution',at:now}});
 const refused=await step('S04',wrong,{
  fetchEvidence:async(url:string)=>{
   if(url==='https://example-employer.test')return employerPage('example-employer.test','Example Employer') as any;
   throw Error('source_unavailable');}});
 expect(refused.output.identityHint?.status).toBe('refuted');
 expect(refused.output.candidate?.providerCompany).toBeUndefined();
 expect(refused.output.state).toBe('source_pending');
 expect(refused.output.pendingResolution?.nextAction).toBe('ask_reviewer');
});

it('stops a verified identity that the campaign excludes, instead of researching it',async()=>{
 const answered=atsPacket({identityHint:{name:'Forbes',domain:'forbes.com',
  note:'This board belongs to Forbes.',reviewerId:randomUUID(),at:now,status:'unverified'},
  pendingResolution:{reason:'identity_unresolved',detail:'answered',attempts:0,nextAction:'retry_resolution',at:now}});
 const out=await step('S04',answered,{
  fetchEvidence:async(url:string)=>{
   if(url==='https://forbes.com')return employerPage('forbes.com','Forbes') as any;
   throw Error('source_unavailable');},
  search:async()=>{throw Error('no_search_for_an_excluded_company');}});
 // Identification succeeded; the ordinary eligibility path then excluded it. A reviewer's answer
 // identifies a company, it does not admit one.
 expect(out.output.identityHint?.status).toBe('verified');
 expect(out.output.state).toBe('icp_mismatch');
 expect(out.next).toBeNull();
});
