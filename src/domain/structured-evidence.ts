import type {Evidence} from '../contracts/pipeline';
import {hash,hostOf} from './policy';
type Reference=NonNullable<NonNullable<Evidence['companyFacts']>[number]['sourceRef']>;
export function jsonPointer(value:unknown,pointer:string):unknown {
 if(pointer==='')return value;if(!pointer.startsWith('/'))return undefined;
 for(const part of pointer.slice(1).split('/').map(p=>p.replace(/~1/g,'/').replace(/~0/g,'~'))){
  if(!value||typeof value!=='object'||!Object.hasOwn(value,part))return undefined;
  value=(value as Record<string,unknown>)[part];
 }
 return value;
}
export function structuredValues(e:Evidence,ref:Reference):unknown[]|null {
 const source=e.structuredSources?.find(s=>s.id===ref.sourceId);
 if(!source||source.sourceUrl!==e.finalUrl||hash(source.rawJson)!==source.contentHash)return null;
 try{const parsed:unknown=JSON.parse(source.rawJson);return ref.pointers.map(p=>jsonPointer(parsed,p));}catch{return null;}
}
export function structuredFactStatement(field:string,value:string|number){return `Company-published structured data reports ${field}: ${value}.`;}
export function validStructuredFact(e:Evidence,f:NonNullable<Evidence['companyFacts']>[number]){
 if(!f.sourceRef||!f.id||f.statement!==structuredFactStatement(f.field,f.value))return false;
 const values=structuredValues(e,f.sourceRef);if(!values)return false;
 const suffixes:Record<string,RegExp>={employees:/\/numberOfEmployees(?:\/value)?$/,employeeRange:/\/numberOfEmployees\/(?:minValue|maxValue)$/,country:/\/address\/addressCountry$/,industry:/\/industry$/,name:/\/name$/,alternateName:/\/alternateName(?:\/\d+)?$/};
 if(f.sourceRef.pointers.some(p=>!suffixes[f.field].test(p)))return false;
 const objectPath=f.sourceRef.pointers[0].replace(suffixes[f.field],'');
 const source=e.structuredSources!.find(s=>s.id===f.sourceRef!.sourceId)!;
 const organization=jsonPointer(JSON.parse(source.rawJson),objectPath) as {url?:unknown;'@type'?:unknown}|undefined;
 if(!organization||organization['@type']!=='Organization'||typeof organization.url!=='string')return false;
 try{const host=hostOf(organization.url),publisher=hostOf(e.finalUrl);if(host!==publisher&&!publisher.endsWith('.'+host))return false;}catch{return false;}
 if(f.field==='employeeRange')return values.length===2&&f.sourceRef.pointers[0].endsWith('/minValue')&&f.sourceRef.pointers[1]===objectPath+'/numberOfEmployees/maxValue'&&values.every(v=>typeof v==='number'&&Number.isInteger(v)&&v>=0)&&Number(values[1])>=Number(values[0])&&f.value===values.join('-');
 return values.length===1&&values[0]===f.value&&(f.field!=='employees'||typeof f.value==='number'&&Number.isInteger(f.value)&&f.value>=0);
}
/** Models get source pointers/values; the complete unchanged raw JSON stays in the saved packet. */
export function evidenceModelContext(e:Evidence){
 const refs=[...(e.companyFacts??[]).flatMap(f=>f.sourceRef?[f.sourceRef]:[]),...(e.attribution?.sourceRef?[e.attribution.sourceRef]:[])];
 return {...e,structuredSources:undefined,structuredSourceFields:e.structuredSources?.map(s=>({id:s.id,sourceUrl:s.sourceUrl,scriptIndex:s.scriptIndex,contentHash:s.contentHash,fields:refs.filter(r=>r.sourceId===s.id).flatMap(r=>{const values=structuredValues(e,r);return values?r.pointers.map((pointer,i)=>({pointer,value:values[i]})):[];})}))};
}
