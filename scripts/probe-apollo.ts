import {mkdir,writeFile} from 'node:fs/promises';
import {required} from '../src/config/env';
import {z} from 'zod';
// These two documented endpoints consume zero Apollo credits; no prospect data is requested.
const key=required('APOLLO_API_KEY');
const Credits=z.object({credit_usage_stats:z.record(z.string(),z.object({limit:z.number(),consumed:z.number(),left_over:z.number()})),current_credit_cycle:z.object({start_date:z.string(),end_date:z.string()})});
async function probe(path:string,method:string){
 try{
  const response=await fetch('https://api.apollo.io/api/v1/'+path,{method,headers:{'x-api-key':key,'Content-Type':'application/json',accept:'application/json'},signal:AbortSignal.timeout(15000),redirect:'error'});
  const data=await response.json();
  if(path==='auth/health')return {path,status:response.status,authenticated:response.ok&&data.is_logged_in===true,health:data.is_logged_in===true,creditCost:0};
  const parsed=Credits.safeParse(data);
  return {path,status:response.status,creditCost:0,credits:response.ok&&parsed.success?parsed.data:null,error:response.status===403?'scope_or_account_access_denied':response.status===401?'unauthorized':!response.ok?'provider_error':!parsed.success?'unrecognized_credit_response':null};
 }catch{return {path,status:null,creditCost:0,error:'probe_unavailable',credits:null};}
}
// Balance inspection is opt-in. The user has confirmed the current allowance; do not poll it.
const results=await Promise.all([probe('auth/health','GET'),...(process.argv.includes('--include-credit-usage')?[probe('usage_stats/credit_usage_stats','POST')]:[])]);
const report={observedAt:new Date().toISOString(),evidence:'https://docs.apollo.io/reference/view-credit-usage-stats',results,freePlanConfirmed:false,enrichmentEnabled:false};
await mkdir('.local',{recursive:true});await writeFile('.local/apollo-capability-probe.json',JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify(report));
