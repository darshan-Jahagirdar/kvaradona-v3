import {it,expect,vi} from 'vitest';
import {searchApolloCompanies} from '../src/providers/apollo-companies';
import {DiscoveryGroup} from '../src/contracts/discovery';
import {Packet} from '../src/contracts/pipeline';
import {companyIdentity,reviewPlacement} from '../src/domain/opportunity-review';
import {collectCompanyContext} from '../src/stages/company-context';
import {randomUUID} from 'node:crypto';
const group=DiscoveryGroup.parse({source:'apollo',country:'US',language:'en'});
const company={id:'apollo-fixture-a',name:'Fixture A',primary_domain:'www.fixture-a.example.com',country:'United States',estimated_num_employees:120};
function ops(body:unknown,status=200){return {run:vi.fn(async(...args:any[])=>args[5].parse({httpStatus:status,body}))} as any;}
async function candidate(row:any=company){return (await searchApolloCompanies(ops({organizations:[row]}),'company_discovery',group)).candidates[0];}
it('reserves one documented page, records field provenance and never invents intent from ICP',async()=>{
 const operation=ops({organizations:[company]});const result=await searchApolloCompanies(operation,'company_discovery',group);
 expect(operation.run.mock.calls[0].slice(1,5)).toEqual(['apollo',{endpoint:'mixed_companies/search',params:{'organization_num_employees_ranges[]':['1,500','501,10000'],'organization_locations[]':['United States'],page:'1',per_page:'5'}},'0',1]);
 expect(result.candidates[0].providerCompany).toMatchObject({domain:'fixture-a.example.com',employees:120,icp:{status:'match'},intent:{status:'unknown'},provenance:{domain:'primary_domain'}});
 const packet=Packet.parse({candidate:result.candidates[0],state:'company_assessment_pending',evidence:[],mode:'live'});
 expect(companyIdentity(packet)?.name).toBe('Fixture A');expect(reviewPlacement(packet).section).toBe('human');
});
it('preserves missing ICP/domain fields, separates mismatches, and fails clearly without retries',async()=>{
 const missing=await candidate({id:'b',name:'Missing fields'});expect(missing.providerCompany?.icp.status).toBe('unknown');expect(missing.providerCompany?.domain).toBeNull();
 expect((await candidate({...company,estimated_num_employees:20000})).providerCompany?.icp.status).toBe('mismatch');
 for(const [status,body,error]of [[403,{},'access_denied'],[429,{},'rate_limited'],[200,{accounts:[]},'response_invalid'],[200,{organizations:[{id:'broken'}]},'records_invalid']] as const){const op=ops(body,status);await expect(searchApolloCompanies(op,'company_discovery',group)).rejects.toThrow(error);expect(op.run).toHaveBeenCalledTimes(1);}
});
it('researches only company pages, retains original attribution failures, and reuses fresh saved evidence',async()=>{
 const p=Packet.parse({candidate:await candidate(),state:'discovered',evidence:[],mode:'fixture'}),now=new Date().toISOString();
 const evidence={id:randomUUID(),url:p.candidate!.url,finalUrl:p.candidate!.url,title:'Company initiative',text:'Fixture evidence',contentHash:'fixture',retrievedAt:now,publishedAt:null,source:'website',origin:'original' as const,status:'unknown' as const,accountHost:'fixture-a.example.com'};
 const tools={search:vi.fn(async()=>[{...p.candidate!,url:'https://unrelated.example.com/claim'}]),fetchEvidence:vi.fn(async()=>({...evidence,accountHost:'unrelated.example.com'}))};
 expect(await collectCompanyContext(p,tools)).toBe(false);expect(p.state).toBe('company_context_pending');expect(tools.search.mock.calls).toHaveLength(1);expect(tools.fetchEvidence).toHaveBeenCalledWith('https://fixture-a.example.com');
 tools.search.mockClear();expect(await collectCompanyContext(p,{...tools,companyEvidence:async()=>[evidence]})).toBe(true);expect(tools.search).not.toHaveBeenCalled();expect(p.evidence[0].id).not.toBe(evidence.id);expect(p.evidence[0].retrievedAt).toBe(now);
});
it('dispatches Apollo S02 into its own bounded ingestion without a broad Brave search',async()=>{
 const {runStage}=await import('../src/stages/pipeline');const records=await Promise.all(['a','b','c','d','e'].map(id=>candidate({...company,id}))),rpc=vi.fn(async(_name:string,_args:Record<string,unknown>)=>true),search=vi.fn(async()=>[]);
 await runStage({rpc},{id:randomUUID(),organization_id:randomUUID(),campaign_id:randomUUID(),opportunity_id:null,stage:'S02',business_key:'fixture',input_hash:'h',input_version:7,schema_version:'1',prompt_version:'12',attempt_token:randomUUID(),attempts:1,payload:{groups:[group],groupIndex:0,maxResearch:3}},{companySearch:async()=>({candidates:records,providerResult:{httpStatus:200,returned:5,invalid:0,requestedPage:1,filters:{} as any,intent:'unknown'}}),search,ai:{generate:async()=>{throw Error('unexpected_model');}},fetchEvidence:async()=>{throw Error('unexpected_fetch');},relationship:async()=> 'unknown',contact:async()=>{throw Error('unexpected_contact');}});
 expect(search).not.toHaveBeenCalled();expect(rpc.mock.calls[0][0]).toBe('ingest_company_discovery');expect((rpc.mock.calls[0][1] as any).p_candidates).toHaveLength(5);
});
