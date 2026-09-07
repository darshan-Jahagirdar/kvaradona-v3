import {intentIcp} from './intent-icp';
export const exploriumPilotTopic='media & advertising: pardot';
// Values verified through Explorium's industry autocomplete. These are provider classifications.
export const exploriumIndustries=['it services and it consulting','construction','advertising services','real estate','hospitals and health care','business consulting and services','operations consulting','software development','consumer services','motor vehicle manufacturing','retail motor vehicles','wholesale motor vehicles and parts','motor vehicle parts manufacturing','education','education management','higher education','education administration programs','primary and secondary education','design services','hospitality'];
export const discoveryExcludedDomains=['crossover.com','wsj.com','forbes.com','github.com','nytimes.com','higgsfield.ai'];
// Only bands wholly inside 500-10,000 are requested. The overlapping 201-500 band was dropped after two live runs:
// it consumed 2 credits per company and every result stalled as `unknown`, unable to be enriched or researched.
// exploriumIcp still treats a boundary-crossing band as unknown if the provider returns one.
export function exploriumFilters(){return {country_code:{values:intentIcp.countries.map(c=>c.code.toLowerCase())},company_size:{values:['501-1000','1001-5000','5001-10000']},linkedin_category:{values:exploriumIndustries},business_intent_topics:{topics:[exploriumPilotTopic]}};}
export function exploriumIcp(row:{number_of_employees_range?:string|null;country_name?:string|null;business_description?:string|null;naics_description?:string|null}){
 const reasons:string[]=[],unknowns:string[]=[];let mismatch=false;
 const range=row.number_of_employees_range?.match(/^(\d+)-(\d+)$/),min=range?Number(range[1]):null,max=range?Number(range[2]):null;
 if(min===null||max===null)unknowns.push('Employee count unavailable.');
 else if(max<500||min>10000){mismatch=true;reasons.push('Reported employee range is outside 500–10,000.');}
 else if(min<500||max>10000)unknowns.push('The reported employee band crosses the ICP boundary; verify the exact count, including companies with exactly 500 employees.');
 else reasons.push('Reported employee band is within 500–10,000.');
 const country=intentIcp.countries.find(c=>[c.name,c.code].some(v=>v.toLowerCase()===row.country_name?.toLowerCase()));
 if(country)reasons.push('Reported headquarters is in an approved country.');else unknowns.push('Headquarters needs verification against the approved countries.');
 if(!row.naics_description)unknowns.push('Industry classification unavailable.');
 else if(/\b(news|journalism|publisher of news|broadband|telecommunications)\b/i.test(row.business_description??''))unknowns.push('Company description may conflict with the requested industry classification; human assessment required.');
 else reasons.push('Provider returned this company under the configured industry filters; original context must verify service fit.');
 return {status:mismatch?'mismatch' as const:unknowns.length?'unknown' as const:'match' as const,reasons,unknowns,searchCountry:country?.code??'unknown'};
}
