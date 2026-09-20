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
