import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {required} from '../src/config/env';
import {TheirStackCredits,unusedFreeCredits} from '../src/providers/theirstack';
const file='.local/theirstack-credit-probe.json';
let report:{at:string;status:number;data:unknown}|undefined;
try{const prior=JSON.parse(await readFile(file,'utf8'));if(!process.argv.includes('--refresh')&&Date.now()-Date.parse(prior.at)<3600000)report=prior;}catch(error){if(!(error instanceof Error&&'code' in error&&error.code==='ENOENT'))throw error;}
if(!report){
 const r=await fetch('https://api.theirstack.com/v0/billing/credit-balance',{headers:{Authorization:'Bearer '+required('THEIRSTACK_API_KEY')},redirect:'error',signal:AbortSignal.timeout(15000)});
 report={at:new Date().toISOString(),status:r.status,data:await r.json()};await mkdir('.local',{recursive:true});await writeFile(file,JSON.stringify(report,null,2),{mode:0o600});
}
if(report.status!==200)throw Error(`theirstack_credit_probe_http_${report.status}`);
const credits=TheirStackCredits.parse(report.data);
console.log(JSON.stringify({observedAt:report.at,availableApiCredits:credits.api_credits,usedThisCycle:credits.used_api_credits,unusedDocumentedFreeAllowance:unusedFreeCredits(credits),expiresAt:credits.earliest_expiration,jobSearchExecuted:false}));
