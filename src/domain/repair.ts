import type {Packet} from '../contracts/pipeline';
import {hash} from './policy';
const issueKey=(issues:string[])=>hash([...new Set(issues.map(s=>s.toLowerCase().replace(/\s+/g,' ').trim()))].sort());
export function beginRepair(p:Packet,stage:string,issues:string[],input:unknown){
 const issueHash=issueKey(issues),inputHash=hash(input);
 if(p.repairs?.some(r=>r.stage===stage&&(r.issueHash===issueHash||r.inputHash===inputHash))){p.notes.push('Recovery stopped: the same material issue or input has already been repaired. Obtain changed evidence or a human correction.');return false;}
 p.repairs=[...(p.repairs??[]),{stage,issueHash,inputHash,issues}].slice(-12);return true;
}
export function finishRepair(p:Packet,stage:string,output:unknown){
 const r=p.repairs?.findLast(r=>r.stage===stage&&!r.outputHash);if(!r)return false;
 r.outputHash=hash(output);r.changed=r.outputHash!==r.inputHash;
 if(!r.changed)p.notes.push('Recovery stopped: repair returned unchanged material. No identical review was queued.');
 return r.changed;
}
