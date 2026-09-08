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
/** Short company-bound queries; fetched originals, not search matches, establish attribution. */
export function companyContextQuery(c:ProviderCompany,alternate=false){
 const name=c.name.replace(/["“”]/g,' ').replace(/\s+/g,' ').trim().slice(0,100);
 const profiles=matchedTopicProfiles(c),profile=profiles[alternate&&profiles.length>1?1:0];
 const term=profile?.terms[0]??'revenue operations';
 // The alternate can find an employer-attributed ATS page outside the company domain.
 return `${!alternate&&c.domain?'site:'+c.domain:`"${name}"`} "${term}"`;
}
