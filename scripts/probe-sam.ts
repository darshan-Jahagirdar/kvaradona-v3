import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {samQuery,readSam,normalizeSam,SamSaved} from '../src/providers/sam';
import {procurementPreparation} from '../src/domain/procurement';
const path='.local/sam-initial-probe.json',query=samQuery('CRM',90);await mkdir('.local',{recursive:true});
let saved;
try{const prior=JSON.parse(await readFile(path,'utf8'));if(!prior.response)throw Error('sam_probe_outcome_unknown_do_not_retry');saved=SamSaved.parse(prior.response);}
catch(error){if(!(error instanceof Error&&'code' in error&&error.code==='ENOENT'))throw error;
 await writeFile(path,JSON.stringify({query,state:'dispatched',requestCeiling:1,reason:'Initial bounded public procurement access verification; no paid service or repeat attempt.'}),{mode:0o600,flag:'wx'});
 try{saved=await readSam(query);}catch{
  await writeFile('.local/sam-initial-probe-failure.json',JSON.stringify({at:new Date().toISOString(),reason:'sam_transport_unavailable',attempts:1,providerAcceptance:'unknown',records:'unknown',retryAllowed:false}),{mode:0o600});throw Error('sam_probe_outcome_unknown_do_not_retry');
 }
 await writeFile(path,JSON.stringify({query,state:'returned',requestCeiling:1,response:saved},null,2),{mode:0o600});
}
if(saved.status!==200){console.log(JSON.stringify({status:saved.status,requests:1,liveAcceptance:false}));process.exitCode=1;}
else {const notices=normalizeSam(saved.body,saved.observedAt);await writeFile('.local/sam-initial-notices.json',JSON.stringify(notices,null,2),{mode:0o600});await writeFile('.local/sam-preparation.json',JSON.stringify(notices.map(n=>procurementPreparation(n)),null,2),{mode:0o600});console.log(JSON.stringify({status:saved.status,requests:1,notices:notices.map(n=>({id:n.noticeId,title:n.title,type:n.type,active:n.active,deadlineKnown:Boolean(n.deadlineUtc)}))}));}
