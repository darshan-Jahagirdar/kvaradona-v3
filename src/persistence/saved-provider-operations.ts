import type {SupabaseClient} from '@supabase/supabase-js';
import type {ProviderCompany} from '../contracts/discovery';
import type {SavedOperation} from '../domain/provider-evidence';
const columns='id,provider,state,response,created_at,opportunity_id,operation_key,request_hash,actual_usd';
/** Keyset pagination avoids turning a full page of relevant history into a permanent hold. */
export async function readOperationPages(read:(after:string|null)=>Promise<SavedOperation[]>,pageSize=200){
 const out:SavedOperation[]=[];let cursor:string|null=null;
 for(;;){const page=await read(cursor);out.push(...page);if(page.length<pageSize)return out;
  const next=page[page.length-1].id;if(next===cursor)throw Error('saved_operation_cursor_stalled');cursor=next;
 }
}
export function opportunityProviderOperations(client:SupabaseClient,organizationId:string,opportunityId:string,provider:string){
 return readOperationPages(async after=>{
  let query=client.from('provider_operations').select(columns).eq('organization_id',organizationId).eq('opportunity_id',opportunityId).eq('provider',provider).order('id').limit(200);
  if(after)query=query.gt('id',after);const result=await query;if(result.error)throw Error('saved_provider_lookup_failed');return result.data;
 });
}
export async function companyProviderOperations(client:SupabaseClient,organizationId:string,company:ProviderCompany,opportunityId:string){
 const matching=company.provider==='explorium'?{body:{data:[{business_id:company.id}]}}:{body:{organizations:[{id:company.id}]}};
 const [direct,companyRows]=await Promise.all([
  opportunityProviderOperations(client,organizationId,opportunityId,company.provider),
  readOperationPages(async after=>{
   let query=client.from('provider_operations').select(columns).eq('organization_id',organizationId).eq('provider',company.provider).eq('state','succeeded').contains('response',matching).order('id').limit(200);
   if(after)query=query.gt('id',after);const result=await query;if(result.error)throw Error('saved_provider_lookup_failed');return result.data;
  }),
 ]);
 return [...new Map([...direct,...companyRows].map(row=>[row.id,row])).values()];
}

/** Apollo contact history for a COMPANY, not just one opportunity.
 *
 *  The reveal ceiling is a promise about a company, so a second opportunity record for the same
 *  company must not hand out a second authorization. This collects the organization's opportunities
 *  whose researched account host or provider-reported domain is one of the company's supported
 *  hosts (its canonical domain and any resolved alias), and returns the apollo operations recorded
 *  for all of them, including the current one.
 *
 *  Scope and its limit, stated exactly: same organization, same host or supported alias. A company
 *  recorded under an unrelated third domain that no resolution connects is not matched, and would
 *  still be counted separately. */
export async function companyContactOperations(client:SupabaseClient,organizationId:string,hosts:readonly string[],opportunityId:string){
 const distinct=[...new Set(hosts.filter(h=>/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h)))].slice(0,4);
 const direct=await opportunityProviderOperations(client,organizationId,opportunityId,'apollo');
 if(!distinct.length)return direct;
 const list=distinct.map(h=>`"${h}"`).join(',');
 const related=await client.from('opportunities').select('id').eq('organization_id',organizationId)
  .or(`packet->research->>accountHost.in.(${list}),packet->candidate->providerCompany->>domain.in.(${list}),packet->identityResolution->>to.in.(${list})`)
  .limit(100);
 if(related.error)throw Error('company_contact_history_lookup_failed');
 // A truncated list would understate the count, and an understated ceiling authorizes spending.
 if(related.data.length===100)throw Error('company_contact_history_incomplete');
 const others=related.data.map(r=>r.id as string).filter(id=>id!==opportunityId);
 const pages=await Promise.all(others.map(id=>opportunityProviderOperations(client,organizationId,id,'apollo')));
 return [...new Map([...direct,...pages.flat()].map(row=>[row.id,row])).values()];
}
