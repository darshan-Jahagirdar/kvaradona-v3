import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Packet,Job} from '../src/contracts/pipeline';
import {runStage,type StageTools} from '../src/stages/pipeline';
import {websiteSpecialistStep} from '../src/stages/website-specialist';
import {redirectAliasEvidence,companyAttributionValid,usableCompanyEvidence,attributeCompanyEvidence} from '../src/domain/evidence-attribution';
import {companyFromSelectedSource,companyFromVerifiedHint,resolutionExhausted,companyIdentity} from '../src/domain/identity-resolution';
import {resolveCompanyFacts} from '../src/domain/fact-resolution';
import {hash} from '../src/domain/policy';

const now=new Date().toISOString();
/** Mirrors Bizmetric: every bizmetric.com page redirected to bizmetric.ai, and attribution rejected
 *  each one because the final host no longer matched the recorded account domain. */
function source(id:string,url:string,json:object){
 const rawJson=JSON.stringify(json);
 return {id,rawJson,sourceUrl:url,scriptIndex:0,contentHash:hash(rawJson)};
}
function redirected(over:Partial<any>={}){
 return {id:randomUUID(),url:'https://www.bizmetric.com/contact-us/',finalUrl:'https://www.bizmetric.ai/contact-us',
  accountHost:'bizmetric.ai',title:'Contact',text:'x'.repeat(200),contentHash:'h',retrievedAt:now,publishedAt:null,
  source:'original_web',origin:'original' as const,status:'unknown' as const,
  // A real structured fact: the destination's own JSON-LD Organization, with its url on that host.
  companyFacts:[{id:randomUUID(),field:'name' as const,value:'Bizmetric',
   statement:'Company-published structured data reports name: Bizmetric.',
   sourceRef:{sourceId:'s',pointers:['/name']}}],
  structuredSources:[source('s','https://www.bizmetric.ai/contact-us',
   {'@context':'https://schema.org','@type':'Organization',name:'Bizmetric',url:'https://www.bizmetric.ai/'})],...over};
}
const bizmetric={domain:'bizmetric.com',name:'Bizmetric'};

it('accepts a moved domain only when the redirect AND the destination identity both support it',()=>{
 const e=redirected();
 const alias=redirectAliasEvidence(e as any,bizmetric);
 expect(alias).toMatchObject({from:'bizmetric.com',to:'bizmetric.ai',basis:'first_party_redirect_with_structured_identity'});
 expect(companyAttributionValid(e as any,bizmetric)).toBe(true);
 // The stage attributes before judging usability, which rebinds the record to the company.
 const attributed=attributeCompanyEvidence(e as any,bizmetric);
 expect(attributed.accountHost).toBe('bizmetric.com');
 expect(usableCompanyEvidence(attributed,bizmetric)).toBe(true);
});

it('refuses a redirect that lands on an unrelated company',()=>{
 const e=redirected({finalUrl:'https://www.someoneelse.example/contact',accountHost:'someoneelse.example',
  companyFacts:[{id:randomUUID(),field:'name' as const,value:'Someone Else',
   statement:'Company-published structured data reports name: Someone Else.',
   sourceRef:{sourceId:'s',pointers:['/name']}}],
  structuredSources:[source('s','https://www.someoneelse.example/contact',
   {'@context':'https://schema.org','@type':'Organization',name:'Someone Else',url:'https://www.someoneelse.example/'})]});
 expect(redirectAliasEvidence(e as any,bizmetric)).toBeNull();
 expect(usableCompanyEvidence(attributeCompanyEvidence(e as any,bizmetric),bizmetric)).toBe(false);
});

it('refuses a name match with no redirect from the company\'s own domain',()=>{
 // A third-party page naming the company is not the company's new address.
 const e=redirected({url:'https://aggregator.example/profile/bizmetric',finalUrl:'https://aggregator.example/profile/bizmetric',
  accountHost:'aggregator.example'});
 expect(redirectAliasEvidence(e as any,bizmetric)).toBeNull();
 expect(usableCompanyEvidence(attributeCompanyEvidence(e as any,bizmetric),bizmetric)).toBe(false);
});

it('refuses a redirect whose destination carries no structured identity',()=>{
 const e=redirected({companyFacts:[],structuredSources:[]});
 expect(redirectAliasEvidence(e as any,bizmetric)).toBeNull();
});

/** Once the move is SUPPORTED and recorded, a direct read of the new address is this company's own
 *  page. Before this, only the record that carried the redirect was accepted, so everything read
 *  afterwards on the resolved domain failed attribution again. */
it('accepts a direct read of the resolved domain without requiring a second redirect',()=>{
 const p=movedPacket();
 const direct={...redirected({url:'https://www.bizmetric.ai/services',finalUrl:'https://www.bizmetric.ai/services',
  structuredSources:[source('s','https://www.bizmetric.ai/services',
   {'@context':'https://schema.org','@type':'Organization',name:'Bizmetric',url:'https://www.bizmetric.ai/'})]})};
 expect(redirectAliasEvidence(direct as any,bizmetric)).toBeNull();
 const identity={...bizmetric,aliases:companyIdentity(p,'bizmetric.com').aliases};
 expect(identity.aliases).toEqual(['bizmetric.ai']);
 const attributed=attributeCompanyEvidence(direct as any,identity);
 expect(attributed.accountHost).toBe('bizmetric.com');
 expect(usableCompanyEvidence(attributed,identity)).toBe(true);
 // Without the recorded resolution it is still an unrelated host.
 expect(usableCompanyEvidence(attributeCompanyEvidence(direct as any,bizmetric),bizmetric)).toBe(false);
});

/** A packet whose domain move has been supported and recorded. */
function movedPacket(extra:Record<string,unknown>={}){
 const evidenceId=randomUUID();
 const fact='Bizmetric published a data engineering services page in March 2026.';
 return Packet.parse({mode:'fixture',state:'contact_pending',notes:[],contractVersion:'kvd101',
  eligibility:{basis:'user_accepted_cohort',cohort:'selected run',
   acceptedNote:'Chosen by a reviewer for this selected-company run.',employeeRange:{min:200},countries:['US']},
  identityResolution:{from:'bizmetric.com',to:'bizmetric.ai',basis:'first_party_redirect_with_structured_identity',
   evidenceId,requestedUrl:'https://www.bizmetric.com/contact-us/',finalUrl:'https://www.bizmetric.ai/contact-us',at:now},
  candidate:{url:'https://www.bizmetric.com/',title:'Bizmetric',description:'Data engineering consultancy',
   source:'explorium',eventKey:'k',country:'US',language:'en',discoveredAt:now,
   providerCompany:{provider:'explorium',id:'b'.repeat(32),kind:'provider_reported',name:'Bizmetric',
    domain:'bizmetric.com',headquartersCountry:'united states',employees:null,employeeRange:'201-500',industry:'IT Services',
    observedAt:now,sourceUrl:'https://api.explorium.ai/v2/businesses',
    provenance:{name:'name',domain:'domain',headquartersCountry:'country_name',employees:'number_of_employees_range',industry:'naics_description'},
    icp:{status:'unknown',reasons:[],unknowns:[],searchCountry:'US'},
    intent:{status:'unknown',reason:'none'}}},
  evidence:[{id:evidenceId,url:'https://www.bizmetric.com/services',finalUrl:'https://www.bizmetric.ai/services',
   accountHost:'bizmetric.com',title:'Services',text:fact,contentHash:hash(fact),retrievedAt:now,publishedAt:null,
   source:'original_web',origin:'original',status:'unknown'}],
  research:{company:'Bizmetric',accountHost:'bizmetric.com',identityBasis:fact,service:'Website conversion review',
   demand:'plausible',whyNow:fact,offer:'A scoped conversion review of the services path.',buyerRole:'Head of Marketing',
   claims:[{id:'c1',kind:'fact',material:true,text:fact,quote:fact,evidenceId}],
   contrary:[],uncertainties:[],decision:'exploration',reason:'r',watchTrigger:null,specialist:'none',specialistReason:'r',followUp:null},
  ...extra});
}
function checked(p:ReturnType<typeof Packet.parse>){
 p.packetReview={acceptable:true,issues:[],inputHash:hash(JSON.stringify(p.research)),
  verdicts:[{claimId:'c1',verdict:'supported',evidenceIds:[p.evidence[0].id],repair:''}]};
 return p;
}

it('takes contacts, relationships and website capture to the resolved address, not the old one',async()=>{
 const p=checked(movedPacket({draft:{subject:'A scoped review',body:'Hello,\n\nWould a scoped review help?',
  recipient:'old@bizmetric.com',sender:null,claimIds:['c1']}}));
 p.draftReview={acceptable:true,issues:[],inputHash:hash(JSON.stringify(p.draft)),
  verdicts:[{claimId:'c1',verdict:'supported',evidenceIds:[p.evidence[0].id],repair:''}]};

 const askedRelationship:string[]=[];let contactHost='';
 let output:Packet|undefined,next:any;
 const tools={ai:{generate:async()=>{throw Error('unexpected_model_call');}},
  fetchEvidence:async()=>{throw Error('unexpected_fetch');},search:async()=>[],
  relationship:async(h:string)=>{askedRelationship.push(h);return 'clear' as const;},
  contact:async(h:string)=>{contactHost=h;return {name:'Buyer',role:'Head of Marketing',email:'buyer@bizmetric.ai',
   emailStatus:'provider_verified' as const,employmentEvidence:'e',source:'apollo',observedAt:now,
   state:'resolved' as const,reason:'r',candidates:[]};}} as unknown as StageTools;
 const job=Job.parse({id:randomUUID(),organization_id:randomUUID(),campaign_id:randomUUID(),opportunity_id:randomUUID(),
  stage:'S10',business_key:'moved',input_hash:'h',input_version:1,schema_version:'1',prompt_version:'7',
  attempt_token:randomUUID(),attempts:1,payload:p});
 await runStage({async rpc(_n,args:any){output=Packet.parse(args.p_output);next=args.p_next;return true;}},job,tools);

 // Contact work goes to the address the company is actually reachable at.
 expect(contactHost).toBe('bizmetric.ai');
 // A relationship attaches to the company, so BOTH addresses are checked.
 expect(askedRelationship.sort()).toEqual(['bizmetric.ai','bizmetric.com']);
 // The draft is rebound to the resolved recipient and its stale check is dropped.
 expect(output!.draft?.recipient).toBe('buyer@bizmetric.ai');
 expect(output!.draftReview).toBeUndefined();
 expect(next).toMatchObject({stage:'S11'});

 // Website capture follows the same identity.
 let captured='';
 const p2=checked(movedPacket());
 p2.research={...p2.research!,specialist:'cro',specialistReason:'Check the services conversion path.'};
 await websiteSpecialistStep(p2,{ai:{generate:async()=>{throw Error('unexpected_model_call');}} as any,
  websiteCapture:async(url:string,h:string)=>{captured=`${url}|${h}`;throw Error('capture_unavailable');}});
 // The capture is requested for the resolved address; the old domain is never opened.
 expect(captured.split('|')[1]).toBe('bizmetric.ai');
 expect(captured).toContain('bizmetric.ai');
 expect(captured).not.toContain('bizmetric.com');
});

it('keeps an existing relationship owner when the company has moved domains',async()=>{
 const p=checked(movedPacket());
 let output:Packet|undefined;
 const tools={ai:{generate:async()=>{throw Error('unexpected_model_call');}},
  fetchEvidence:async()=>{throw Error('unexpected_fetch');},search:async()=>[],
  // The owner is recorded against the OLD domain only.
  relationship:async(h:string)=>h==='bizmetric.com'?'handoff' as const:'unknown' as const,
  contact:async()=>{throw Error('contact_must_not_be_bought_for_a_handoff');}} as unknown as StageTools;
 const job=Job.parse({id:randomUUID(),organization_id:randomUUID(),campaign_id:randomUUID(),opportunity_id:randomUUID(),
  stage:'S10',business_key:'moved-handoff',input_hash:'h',input_version:1,schema_version:'1',prompt_version:'7',
  attempt_token:randomUUID(),attempts:1,payload:p});
 await runStage({async rpc(_n,args:any){output=Packet.parse(args.p_output);return true;}},job,tools);
 expect(output!.relationship).toBe('handoff');
 expect(output!.state).toBe('relationship_handoff');
});

it('applies an exclusion to every address the company is known at',()=>{
 // The resolved domain is on the excluded list; the canonical one is not.
 const p=movedPacket();
 p.identityResolution={...p.identityResolution!,to:'forbes.com'};
 expect(resolveCompanyFacts(p).status).toBe('mismatch');
 expect(resolveCompanyFacts(movedPacket()).status).not.toBe('mismatch');
});

/** A minimal real JobPosting: the employer name and url come from the page's own raw JSON-LD. */
function atsEvidence(over:Partial<any>={}){
 const raw={'@context':'https://schema.org','@type':'JobPosting',title:'Product Designer',
  hiringOrganization:{'@type':'Organization',name:'Example Employer',url:'https://example-employer.test/'}};
 const s=source('jd','https://jobs.ashbyhq.com/example',raw);
 return {id:randomUUID(),url:'https://jobs.ashbyhq.com/example',finalUrl:'https://jobs.ashbyhq.com/example',
  accountHost:null,title:'Example Employer Jobs',text:'roles',contentHash:'h',retrievedAt:now,publishedAt:null,
  source:'job_posting_web',origin:'original' as const,status:'unknown' as const,
  structuredSources:[s],
  attribution:{publisherHost:'jobs.ashbyhq.com',issuerName:'Example Employer',issuerHost:'example-employer.test',
   basis:'structured_employer' as const,sourceType:'job' as const,quote:'',
   sourceRef:{sourceId:'jd',pointers:['/hiringOrganization/name','/hiringOrganization/url']}},...over};
}

it('identifies the employer from the listing\'s own RAW structured data',()=>{
 const company=companyFromSelectedSource(atsEvidence() as any,'https://jobs.ashbyhq.com/example');
 expect(company).not.toBeNull();
 expect(company!.name).toBe('Example Employer');
 expect(company!.domain).toBe('example-employer.test');
 // Nothing is invented: size, country and industry stay unknown and are declared so.
 expect(company!.employees).toBeNull();
 expect(company!.headquartersCountry).toBeNull();
 expect(company!.industry).toBeNull();
 expect(company!.icp.status).toBe('unknown');
 expect(company!.intent.status).toBe('unknown');
});

it('refuses attribution fields that the page\'s raw data does not actually support',()=>{
 // Trusted-looking attribution with no raw structured source behind it.
 const unsupported=atsEvidence({structuredSources:[],
  attribution:{publisherHost:'jobs.ashbyhq.com',issuerName:'Example Employer',issuerHost:'example-employer.test',
   basis:'structured_employer',sourceType:'job',quote:''}});
 expect(companyFromSelectedSource(unsupported as any,'https://jobs.ashbyhq.com/example')).toBeNull();
 // Raw data naming a DIFFERENT employer than the attribution claims.
 const raw={'@context':'https://schema.org','@type':'JobPosting',
  hiringOrganization:{'@type':'Organization',name:'Another Company',url:'https://another.test/'}};
 const mismatched=atsEvidence({structuredSources:[source('jd','https://jobs.ashbyhq.com/example',raw)]});
 expect(companyFromSelectedSource(mismatched as any,'https://jobs.ashbyhq.com/example')).toBeNull();
});

it('leaves an ambiguous listing unresolved rather than guessing a corporate domain',()=>{
 const ambiguous={id:randomUUID(),url:'https://jobs.ashbyhq.com/example',finalUrl:'https://jobs.ashbyhq.com/example',
  accountHost:null,title:'Jobs',text:'JavaScript required',contentHash:'h',retrievedAt:now,publishedAt:null,
  source:'job_posting_web',origin:'original' as const,status:'unknown' as const};
 expect(companyFromSelectedSource(ambiguous as any,'https://jobs.ashbyhq.com/example')).toBeNull();
 // A recruiter listing with no verified issuer host is equally refused.
 const recruiter={...ambiguous,attribution:{publisherHost:'jobs.ashbyhq.com',issuerName:'Recruiter for a client',
  issuerHost:null,basis:'third_party',sourceType:'job',quote:''}};
 expect(companyFromSelectedSource(recruiter as any,'https://jobs.ashbyhq.com/example')).toBeNull();
});

it('accepts a reviewer\'s answer only when that company publishes the identity itself',()=>{
 const page={id:randomUUID(),url:'https://example-employer.test/',finalUrl:'https://example-employer.test/',
  accountHost:null,title:'Example Employer',text:'x'.repeat(200),contentHash:'h',retrievedAt:now,publishedAt:null,
  source:'original_web',origin:'original' as const,status:'unknown' as const,
  companyFacts:[{id:randomUUID(),field:'name' as const,value:'Example Employer',
   statement:'Company-published structured data reports name: Example Employer.',
   sourceRef:{sourceId:'o',pointers:['/name']}}],
  structuredSources:[source('o','https://example-employer.test/',
   {'@context':'https://schema.org','@type':'Organization',name:'Example Employer',url:'https://example-employer.test/'})]};
 const hint={name:'Example Employer',domain:'example-employer.test'};
 expect(companyFromVerifiedHint(hint,page as any)?.domain).toBe('example-employer.test');
 // A typed answer that the page does not support is refused; typing it certifies nothing.
 expect(companyFromVerifiedHint({name:'Some Other Company',domain:'example-employer.test'},page as any)).toBeNull();
 expect(companyFromVerifiedHint(hint,{...page,companyFacts:[],structuredSources:[]} as any)).toBeNull();
 // A page on a different host than the answer names.
 expect(companyFromVerifiedHint({name:'Example Employer',domain:'elsewhere.test'},page as any)).toBeNull();
});

/** Mirrors VentureBeat: a historical provider description warning with nothing contradicting it. */
function venturebeat(extra:Partial<any>={},evidence:unknown[]=[]){
 return Packet.parse({mode:'fixture',state:'discovered',notes:[],evidence,
  eligibility:{basis:'user_accepted_cohort',cohort:'selected run',acceptedNote:'Chosen by a reviewer for this selected-company run.',employeeRange:{min:200},countries:['US']},
  candidate:{url:'https://venturebeat.com',title:'VentureBeat',description:'d',source:'explorium',eventKey:'k',
   country:'US',language:'en',discoveredAt:now,
   providerCompany:{provider:'explorium',id:'v'.repeat(32),kind:'provider_reported',name:'VentureBeat',
    domain:'venturebeat.com',headquartersCountry:'united states',employees:null,employeeRange:'201-500',industry:'Media',
    observedAt:now,sourceUrl:'https://api.explorium.ai/v2/businesses',
    provenance:{name:'name',domain:'domain',headquartersCountry:'country_name',employees:'number_of_employees_range',industry:'naics_description'},
    icp:{status:'unknown',reasons:['Reported headquarters is in an approved country.'],
     unknowns:['Company description may conflict with the requested industry classification; human assessment required.'],searchCountry:'US'},
    intent:{status:'provider_reported',reason:'topic research',topics:[{topic:'media & advertising: pardot',score:73,sourceDate:null}]},
    ...extra}}});
}

it('treats a historical classification warning as answerable by evidence, not as an ending',()=>{
 const r=resolveCompanyFacts(venturebeat());
 expect(r.status).toBe('unresolved');
 expect(r.classification).toContain('Company description may conflict with the requested industry classification; human assessment required.');
 // The warning is preserved as history AND marked answerable, so research can still happen.
 expect(r.evidenceCanResolve).toBe(true);
 // Answerable is not answered: until evidence arrives it is provisional, and says so.
 expect(r.classificationStatus).toBe('provisional');
});

it('does not settle the warning merely because an industry value exists',()=>{
 const raw={'@context':'https://schema.org','@type':'Organization',name:'VentureBeat',
  url:'https://venturebeat.com/',industry:'Online media and technology news'};
 const page={id:randomUUID(),url:'https://venturebeat.com/about',finalUrl:'https://venturebeat.com/about',
  accountHost:'venturebeat.com',title:'About',text:'x'.repeat(200),contentHash:'h',retrievedAt:now,publishedAt:null,
  source:'original_web',origin:'original',status:'unknown',
  companyFacts:[{id:randomUUID(),field:'industry',value:'Online media and technology news',
   statement:'Company-published structured data reports industry: Online media and technology news.',
   sourceRef:{sourceId:'a',pointers:['/industry']}}],
  structuredSources:[source('a','https://venturebeat.com/about',raw)]};
 const r=resolveCompanyFacts(venturebeat({},[page]));
 // Knowing what a company publishes is not the same as it fitting this campaign. With no configured
 // industry restriction to judge it against, the fit stays provisional and research still proceeds;
 // the value is recorded rather than used to close the question.
 expect(r.classificationStatus).toBe('provisional');
 expect(r.status).toBe('unresolved');
 expect(r.evidenceCanResolve).toBe(true);
 expect(r.reused.join(' ')).toContain('configures no industry restriction');
 // Judged against an actual configured restriction, it settles either way.
 const inside=resolveCompanyFacts({...venturebeat({},[page]),
  eligibility:{...venturebeat().eligibility!,industries:['Media']}});
 expect(inside.classificationStatus).toBe('addressed_by_evidence');
 expect(inside.status).toBe('match');
 const outside=resolveCompanyFacts({...venturebeat({},[page]),
  eligibility:{...venturebeat().eligibility!,industries:['Financial services']}});
 expect(outside.evidenceCanResolve).toBe(false);
 expect(outside.conflicts.join(' ')).toContain('outside this campaign');
});

it('still stops when an attribute genuinely contradicts the cohort',()=>{
 const outside=venturebeat({headquartersCountry:'germany'});
 const r=resolveCompanyFacts(outside);
 expect(r.status).toBe('unresolved');
 // A contradicting country is not a classification question, so evidence cannot settle it.
 expect(r.evidenceCanResolve).toBe(false);
});

it('stops cycling once the bounded resolution budget is spent',()=>{
 const p=venturebeat();
 expect(resolutionExhausted(p)).toBe(false);
 p.pendingResolution={reason:'identity_unresolved',detail:'d',attempts:2,nextAction:'retry_resolution',at:now};
 expect(resolutionExhausted(p)).toBe(true);
 expect(resolutionExhausted({...p,pendingResolution:{...p.pendingResolution,attempts:1}},1)).toBe(true);
});
