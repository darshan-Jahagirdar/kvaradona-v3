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
 expect(q).toContain('"Ames Construction"');expect(q).toContain('revenue operations');expect(q).not.toContain('site:');
});

it('admits an employer-attributed ATS posting and skips the homepage read',async()=>{
 const p=packet(),url='https://jobs.lever.co/ames/abc123';
 const fetchEvidence=vi.fn(async()=>evidence(url,domain,'job_posting_web'));
 const tools={search:vi.fn(async()=>[{url,title:'Revenue Operations Manager',description:'CRM implementation'} as any]),fetchEvidence};
 expect(await collectCompanyContext(p,tools)).toBe(true);
 expect(p.state).toBe('evidence_collected');
 expect(fetchEvidence).toHaveBeenCalledTimes(1);
 expect(fetchEvidence).toHaveBeenCalledWith(url);
});

it('treats a deeper on-domain page as need evidence',async()=>{
 const p=packet(),url='https://amesconstruction.com/news/marketing-operations-rebuild';
 const tools={search:vi.fn(async()=>[{url,title:'Marketing operations rebuild',description:'CRM implementation'} as any]),fetchEvidence:vi.fn(async()=>evidence(url,domain))};
 expect(await collectCompanyContext(p,tools)).toBe(true);expect(p.state).toBe('evidence_collected');
});

it('still researches a homepage-only company but marks the packet exploratory',async()=>{
 const p=packet();
 const fetchEvidence=vi.fn(async(u:string)=>evidence(u,domain));
 const tools={search:vi.fn(async()=>[]),fetchEvidence};
 expect(await collectCompanyContext(p,tools)).toBe(true);
 expect(p.state).toBe('evidence_collected');
 expect(fetchEvidence).toHaveBeenCalledWith('https://'+domain);
 expect(p.evidence).toHaveLength(1);
 expect(p.notes.join(' ')).toContain('exploratory packet');
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
 expect(fetchEvidence).toHaveBeenCalledWith(board);
 expect(fetchEvidence).toHaveBeenCalledWith('https://'+domain);
 // The unattributed board posting is discarded; only the homepage survives as evidence.
 expect(p.evidence).toHaveLength(1);expect(p.evidence[0].accountHost).toBe(domain);
});
