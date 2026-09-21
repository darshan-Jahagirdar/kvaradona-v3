import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Packet} from '../src/contracts/pipeline';
import {redirectAliasEvidence,companyAttributionValid,usableCompanyEvidence,attributeCompanyEvidence} from '../src/domain/evidence-attribution';
import {companyFromSelectedSource,resolutionExhausted} from '../src/domain/identity-resolution';
import {resolveCompanyFacts} from '../src/domain/fact-resolution';
import {hash} from '../src/domain/policy';

const now=new Date().toISOString();
/** Mirrors Bizmetric: every bizmetric.com page redirected to bizmetric.ai, and attribution rejected
 *  each one because the final host no longer matched the recorded account domain. */
function source(id:string,url:string,json:object){
 const rawJson=JSON.stringify(json);
 return {id,rawJson,sourceUrl:url,contentHash:hash(rawJson)};
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

it('identifies the employer behind a selected careers record from its own structured fields',()=>{
 const ats={id:randomUUID(),url:'https://jobs.ashbyhq.com/harvey',finalUrl:'https://jobs.ashbyhq.com/harvey',
  accountHost:'example-employer.test',title:'Harvey Jobs',text:'roles',contentHash:'h',retrievedAt:now,publishedAt:null,
  source:'job_posting_web',origin:'original' as const,status:'unknown' as const,
  attribution:{publisherHost:'jobs.ashbyhq.com',issuerName:'Example Employer',issuerHost:'example-employer.test',
   basis:'structured_employer',sourceType:'job',quote:'',sourceRef:null,linkSource:null}};
 const company=companyFromSelectedSource(ats as any,'https://jobs.ashbyhq.com/harvey');
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

it('leaves an ambiguous listing unresolved rather than guessing a corporate domain',()=>{
 const ambiguous={id:randomUUID(),url:'https://jobs.ashbyhq.com/harvey',finalUrl:'https://jobs.ashbyhq.com/harvey',
  accountHost:null,title:'Harvey Jobs',text:'JavaScript required',contentHash:'h',retrievedAt:now,publishedAt:null,
  source:'job_posting_web',origin:'original' as const,status:'unknown' as const};
 expect(companyFromSelectedSource(ambiguous as any,'https://jobs.ashbyhq.com/harvey')).toBeNull();
 // A recruiter listing with no verified issuer host is equally refused.
 const recruiter={...ambiguous,attribution:{publisherHost:'jobs.ashbyhq.com',issuerName:'Recruiter for a client',
  issuerHost:null,basis:'third_party',sourceType:'job',quote:'',sourceRef:null,linkSource:null}};
 expect(companyFromSelectedSource(recruiter as any,'https://jobs.ashbyhq.com/harvey')).toBeNull();
});

/** Mirrors VentureBeat: a historical provider description warning with nothing contradicting it. */
function venturebeat(extra:Partial<any>={}){
 return Packet.parse({mode:'fixture',state:'discovered',notes:[],evidence:[],
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
