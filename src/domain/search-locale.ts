// Brave does not offer an SG country filter. Keep intended and effective targeting distinct.
const countries=new Set('AR AU AT BE BR CA CL DK FI FR DE GR HK IN ID IT JP KR MY MX NL NZ NO CN PL PT PH RU SA ZA ES SE CH TW TR GB US ALL'.split(' '));
export function searchLocale(query:string,country:string){
 if(country==='SG')return {query:`${query} Singapore`,country:'ALL',targetCountry:'SG'};
 if(!countries.has(country))throw Error('unsupported_search_country');return {query,country,targetCountry:country};
}
