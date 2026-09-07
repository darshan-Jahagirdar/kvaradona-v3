import {z} from 'zod';
import {callApollo,type ContactOperations} from './apollo';
import {ProviderCompany,type DiscoveryGroup} from '../contracts/discovery';
import {Candidate} from '../contracts/pipeline';
import {assessCompany,companyCountries,companyIcp} from '../domain/company-discovery';
import {hash,hostOf} from '../domain/policy';
const Row=z.object({id:z.string().min(1),name:z.string().min(1),primary_domain:z.string().nullable().optional(),website_url:z.string().nullable().optional(),country:z.string().nullable().optional(),estimated_num_employees:z.number().int().nonnegative().nullable().optional(),industry:z.string().nullable().optional()});
const Page=z.object({organizations:z.array(z.unknown()).max(100)});
export async function searchApolloCompanies(operations:ContactOperations,key:string,group:DiscoveryGroup,request:typeof fetch=fetch){
 const location=companyCountries[group.country];if(!location)throw Error('apollo_country_mapping_required');
 const params={'organization_num_employees_ranges[]':companyIcp.employeeRanges,'organization_locations[]':[location],page:String(group.page),per_page:'5'};
 const response=await callApollo(operations,request,key,'mixed_companies/search',params,1);
 if(response.httpStatus!==200)throw Error(response.httpStatus===403?'apollo_company_access_denied':response.httpStatus===401?'apollo_company_auth_failed':response.httpStatus===429?'apollo_company_rate_limited':'apollo_company_http_failure');
 const parsed=Page.safeParse(response.body);if(!parsed.success)throw Error('apollo_company_response_invalid');
 const candidates:z.infer<typeof Candidate>[]=[];let invalid=0;
 for(const raw of parsed.data.organizations.slice(0,5)){
  const row=Row.safeParse(raw);if(!row.success){invalid++;continue;}const r=row.data;
  let domain:string|null=null,domainField:'primary_domain'|'website_url'|'unavailable'='unavailable';
  for(const [field,value]of [['primary_domain',r.primary_domain],['website_url',r.website_url]] as const){try{if(value){const url=new URL(value.includes('://')?value:'https://'+value);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)continue;const host=hostOf(url.href);if(/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)){domain=host;domainField=field;break;}}}catch{}}
  const observedAt=new Date().toISOString(),sourceUrl='https://app.apollo.io/#/organizations/'+encodeURIComponent(r.id);
  const company=ProviderCompany.parse({provider:'apollo',id:r.id,kind:'provider_reported',name:r.name,domain,headquartersCountry:r.country??null,employees:r.estimated_num_employees??null,industry:r.industry??null,observedAt,sourceUrl,provenance:{name:'name',domain:domainField,headquartersCountry:'country',employees:'estimated_num_employees',industry:'industry'},icp:assessCompany(r.estimated_num_employees??null,r.country??null,group),intent:{status:'unknown',reason:'Organization Search establishes provider-reported company attributes. Automated buying-intent access is not verified.'}});
  candidates.push(Candidate.parse({url:domain?'https://'+domain:sourceUrl,title:r.name,description:'Apollo company discovery; service need and buying intent require research.',source:'apollo',eventKey:hash(['apollo_company',r.id]),country:group.country,language:group.language,discoveredAt:observedAt,providerCompany:company}));
 }
 if(parsed.data.organizations.length&&!candidates.length)throw Error('apollo_company_records_invalid');
 return {candidates,providerResult:{httpStatus:200,returned:parsed.data.organizations.length,invalid,requestedPage:group.page,filters:params,intent:'unknown'}};
}
