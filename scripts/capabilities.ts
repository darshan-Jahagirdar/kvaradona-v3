import { configurationReport } from '../src/config/env';
import { serviceClient } from '../src/persistence/client';
const client=serviceClient();const report=configurationReport();
const [limits,budget,ops]=await Promise.all([client.from('provider_limits').select('*'),client.from('budget').select('limit_usd,live_enabled'),client.from('provider_operations').select('provider,state,actual_usd,reserved_usd,units,usage')]);
const capabilities=report.map(row=>{
 const limit=limits.data?.find(l=>l.provider===row.provider),success=ops.data?.some(o=>o.provider===row.provider&&o.state==='succeeded'&&(!o.usage?.http_status||(o.usage.http_status>=200&&o.usage.http_status<300)));
 const dbVerified=row.provider==='supabase'&&!limits.error&&!budget.error&&!ops.error;
 const current=Boolean(limit?.expires_at&&Date.parse(limit.expires_at)>Date.now());
 let userConfirmed=false;try{userConfirmed=JSON.parse(limit?.evidence??'{}').kind==='user_confirmed_free_allowance';}catch{}
 const heldUnits=ops.data?.filter(o=>o.provider===row.provider).reduce((total,o)=>total+o.units,0);
 return {...row,authenticated:success||dbVerified||limit?.authenticated?'observed_success':'unverified',endpoint:success?'saved_operation_succeeded':dbVerified?'database_read_succeeded':'unverified',quota:userConfirmed?'user_confirmed_allowance':current&&limit?.authenticated&&limit?.usable&&limit?.free_units>0?'recorded_free_allowance':'unverified',freeCreditsRemaining:userConfirmed&&heldUnits!==undefined?Math.max(0,limit.free_units-heldUnits):null,enabled:Boolean(budget.data?.[0]?.live_enabled&&current&&(limit?.probe_enabled||(limit?.authenticated&&limit?.usable))),evidence:success?'Recorded successful operation; endpoint access and credit allowance are reported separately.':dbVerified?'Service-role operational table reads succeeded.':'No successful task recorded.'};
});
console.log(JSON.stringify({configuration:capabilities,limits:limits.error?'database_unavailable':limits.data,budget:budget.error?'unknown':budget.data,usage:ops.error?'unknown':ops.data,sendingEnabled:false},null,2));
