import {matchedTopicProfiles} from './intent-topics';
import type {ProviderCompany,DiscoveryGroup} from '../contracts/discovery';
export const companyCountries:Record<string,string>={US:'United States',GB:'United Kingdom',AU:'Australia',SG:'Singapore'};
export const companyIcp={employeeRanges:['1,500','501,10000'],regions:['US','Europe','Australia','Asia'],industries:null,revenue:null,exclusions:null};
export function assessCompany(employees:number|null,country:string|null,group:DiscoveryGroup){
 const reasons:string[]=[],unknowns=['Service need requires original company research.','Industry and revenue restrictions are not configured.'];let mismatch=false;
 if(employees===null)unknowns.push('Employee count unavailable.');else if(employees>=1&&employees<=10000)reasons.push('Reported employee count is within 1–10,000.');else{mismatch=true;reasons.push('Reported employee count is outside the saved ICP.');}
 if(!country)unknowns.push('Headquarters country unavailable.');else if([group.country,companyCountries[group.country]].some(v=>v?.toLowerCase()===country.toLowerCase()))reasons.push('Reported headquarters matches this pilot country.');else unknowns.push('Reported headquarters differs from the requested country; assess operating geography before excluding.');
 return {status:mismatch?'mismatch' as const:employees===null||reasons.length<2?'unknown' as const:'match' as const,reasons,unknowns,searchCountry:group.country};
}
/** Bounded queries answer different missing questions across the matched families. */
export function companyContextQuery(c:ProviderCompany,alternate=false){return companyContextQueries(c)[alternate?1:0].query;}
export function companyContextQueries(c:ProviderCompany,question=''){
 const name=c.name.replace(/["“”]/g,' ').replace(/\s+/g,' ').trim().slice(0,100);
 // Saved BMC results showed every multi-group query returning nothing: `site:` plus two OR groups gave 0
 // results, and the three-group name query returned only generic RFP templates. Keep one restriction and
 // at most one topic group per query. Terms come from the matched family, not its long discovery query.
 const group=(p?:{terms:readonly string[]})=>p?`(${p.terms.slice(0,3).map(t=>/\s/.test(t)?`"${t}"`:t).join(' OR ')})`:'(website OR CRM OR marketing)';
 const profiles=matchedTopicProfiles(c),primary=group(profiles[0]),secondary=group(profiles[1]??profiles[0]);
 const focus=/procure|tender|RFP|award|closing|deadline/i.test(question)?'(procurement OR tender OR RFP)':/hiring|responsibilit|role/i.test(question)?'(careers OR hiring)':/technolog|installed|stack|integration/i.test(question)?'(technology OR platform)':/employee|headcount|size/i.test(question)?'(employees OR headcount)':/country|headquarter|geograph/i.test(question)?'(headquarters OR locations)':/industry|classification/i.test(question)?'(about OR services)':primary;
 return [
  {question:question||'Which dated company initiative connects to the service?',query:`${c.domain?'site:'+c.domain:`"${name}"`} ${focus}`},
  {question:'Is there an issuer announcement, project-bearing role or procurement scope?',query:`"${name}" ${secondary}`},
  {question:'What company context supports a useful conditional offer?',query:`${c.domain?'site:'+c.domain:`"${name}"`} (about OR investor OR strategy OR services)`},
 ];
}
