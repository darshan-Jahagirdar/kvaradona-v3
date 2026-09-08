import {companyResearchContext} from '../src/domain/company-research';
import {it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Packet} from '../src/contracts/pipeline';
import {collectCompanyContext} from '../src/stages/company-context';
import {companyContextQuery} from '../src/domain/company-discovery';
const now=new Date().toISOString(),domain='amesconstruction.com';
const company={provider:'explorium' as const,id:'a'.repeat(32),kind:'provider_reported' as const,name:'Ames Construction',domain,headquartersCountry:'United States',employees:null,employeeRange:'501-1000',industry:'Construction',observedAt:now,sourceUrl:'https://api.explorium.ai/v2/businesses',
 provenance:{name:'name' as const,domain:'domain' as const,headquartersCountry:'country_name' as const,employees:'number_of_employees_range' as const,industry:'naics_description' as const},
 icp:{status:'match' as const,reasons:['ok'],unknowns:[],searchCountry:'US'},
 intent:{status:'provider_reported' as const,reason:'topic research',topics:[{topic:'media & advertising: pardot',score:70,sourceDate:'2026-09-06'}]}};
const packet=()=>Packet.parse({candidate:{url:'https://'+domain,title:'Ames Construction',description:'d',source:'explorium',eventKey:'k',country:'US',language:'en',discoveredAt:now,providerCompany:company},state:'discovered',evidence:[],mode:'live'});
const evidence=(url:string,accountHost:string|null,source='original_web')=>({id:randomUUID(),url,finalUrl:url,title:'t',text:'x'.repeat(200),contentHash:'h',retrievedAt:now,publishedAt:null,source,origin:'original' as const,status:'unknown' as const,accountHost});

it('asks for evidence of a need rather than a technology mention',()=>{
 const q=companyContextQuery(company);
 expect(q).toBe('site:amesconstruction.com "revenue operations"');expect(q).not.toContain(' OR ');
});

it('admits an employer-attributed ATS posting and skips the homepage read',async()=>{
 const p=packet(),url='https://jobs.lever.co/ames/abc123';
 const fetchEvidence=vi.fn(async()=>evidence(url,domain,'job_posting_web'));
 const tools={search:vi.fn(async()=>[{url,title:'Revenue Operations Manager',description:'CRM implementation'} as any]),fetchEvidence};
 expect(await collectCompanyContext(p,tools)).toBe(true);
 expect(p.state).toBe('evidence_collected');
 expect(fetchEvidence).toHaveBeenCalledTimes(1);
 expect(fetchEvidence).toHaveBeenCalledWith(url,expect.any(Function));
});

it('retains a deeper page without treating its path as proof of need',async()=>{
 const p=packet(),url='https://amesconstruction.com/news/marketing-operations-rebuild';
 const tools={search:vi.fn(async()=>[{url,title:'Marketing operations rebuild',description:'CRM implementation'} as any]),fetchEvidence:vi.fn(async()=>evidence(url,domain))};
 expect(await collectCompanyContext(p,tools)).toBe(true);expect(p.state).toBe('evidence_collected');expect(companyResearchContext(p).evidenceLimitations?.needAssessment).toBe('unconfirmed_until_original_evidence_review');
});

it('still researches a homepage-only company but marks the packet exploratory',async()=>{
 const p=packet();
 const fetchEvidence=vi.fn(async(u:string)=>evidence(u,domain));
 const tools={search:vi.fn(async()=>[]),fetchEvidence};
 expect(await collectCompanyContext(p,tools)).toBe(true);
 expect(p.state).toBe('evidence_collected');
 expect(fetchEvidence).toHaveBeenCalledWith('https://'+domain,expect.any(Function));
 expect(p.evidence).toHaveLength(1);
 expect(p.notes.join(' ')).toContain('Need remains unconfirmed');
});

it('keeps a company with no readable source as an assessment candidate, not a rejection',async()=>{
 const p=packet();
 const tools={search:vi.fn(async()=>[]),fetchEvidence:vi.fn(async()=>{throw new Error('source_http_403');})};
 expect(await collectCompanyContext(p,tools)).toBe(false);
 expect(p.state).toBe('company_context_pending');
 expect(p.notes.join(' ')).toContain('do not establish poor fit');
});

it('never fetches a third-party host, and an unattributed board posting does not count',async()=>{
 const p=packet(),board='https://jobs.lever.co/someone-else/x1';
 const fetchEvidence=vi.fn(async(u:string)=>u===board?evidence(u,'lever.co'):evidence(u,domain));
 const tools={search:vi.fn(async()=>[{url:'https://recruiter.example.com/ames',title:'Ames jobs',description:'CRM'} as any,{url:board,title:'Revenue Operations',description:'CRM implementation'} as any]),fetchEvidence};
 expect(await collectCompanyContext(p,tools)).toBe(true);
 expect(fetchEvidence).not.toHaveBeenCalledWith('https://recruiter.example.com/ames');
 expect(fetchEvidence).toHaveBeenCalledWith(board,expect.any(Function));
 expect(fetchEvidence).toHaveBeenCalledWith('https://'+domain,expect.any(Function));
 // The unattributed board posting is discarded; only the homepage survives as evidence.
 expect(p.evidence).toHaveLength(1);expect(p.evidence[0].accountHost).toBe(domain);
});

it('uses a second matched family before A2 when the first search has no original material',async()=>{
 const p=packet();p.candidate!.providerCompany!.intent.topics=[{topic:'web: replatform website',score:80,sourceDate:now.slice(0,10)},{topic:'crm: customer relationship management (crm)',score:70,sourceDate:now.slice(0,10)}];
 const url='https://news.'+domain+'/crm-project';
 const search=vi.fn().mockResolvedValueOnce([{url:'https://vendor.example/website',title:'Website',description:'website'}]).mockResolvedValueOnce([{url,title:'CRM project',description:'CRM implementation'}]);
 const fetchEvidence=vi.fn(async()=>evidence(url,'news.'+domain));
 expect(await collectCompanyContext(p,{search,fetchEvidence})).toBe(true);
 expect(search.mock.calls.map(c=>c[1])).toEqual(['site:amesconstruction.com "website"','"Ames Construction" "CRM"']);
 expect(fetchEvidence).toHaveBeenCalledTimes(1);expect(p.evidence[0].accountHost).toBe(domain);expect(p.evidence[0].finalUrl).toBe(url);
});

it('retains per-source failures and never exceeds two searches or two source attempts',async()=>{
 const p=packet(),fetchEvidence=vi.fn(async()=>{throw Object.assign(Error('TLS failed'),{code:'UNABLE_TO_VERIFY_LEAF_SIGNATURE'});});
 const search=vi.fn().mockResolvedValueOnce([{url:'https://'+domain+'/a',title:'CRM project',description:'implementation'}]).mockResolvedValueOnce([{url:'https://'+domain+'/b',title:'CRM project',description:'implementation'}]);
 expect(await collectCompanyContext(p,{search,fetchEvidence})).toBe(false);expect(search).toHaveBeenCalledTimes(2);expect(fetchEvidence).toHaveBeenCalledTimes(2);
 expect(p.contextAttempts).toHaveLength(2);expect(p.contextAttempts![0]).toMatchObject({url:'https://'+domain+'/a',stage:'page',code:'UNABLE_TO_VERIFY_LEAF_SIGNATURE'});
});

it('reuses saved original company context without fetching it again or buying an alternate search',async()=>{
 const p=packet();p.evidence=[evidence('https://'+domain+'/',domain)];const search=vi.fn(async()=>[]),fetchEvidence=vi.fn();
 expect(await collectCompanyContext(p,{search,fetchEvidence})).toBe(true);expect(p.evidence).toHaveLength(1);expect(search).toHaveBeenCalledTimes(1);expect(fetchEvidence).not.toHaveBeenCalled();
});
