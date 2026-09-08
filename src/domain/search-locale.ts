// Use broad search with explicit geography for supported target markets without a country filter. Keep intended and effective targeting distinct.
const countries=new Set('AR AU AT BE BR CA CL DK FI FR DE GR HK IN ID IT JP KR MY MX NL NZ NO CN PL PT PH RU SA ZA ES SE CH TW TR GB US ALL'.split(' '));
export function searchLocale(query:string,country:string){
 if(country==='SG'||country==='AE')return {query:`${query} ${country==='SG'?'Singapore':'United Arab Emirates'}`,country:'ALL',targetCountry:country};
 if(!countries.has(country))throw Error('unsupported_search_country');return {query,country,targetCountry:country};
}
