import {searchLocale} from '../domain/search-locale';
import { z } from 'zod';
import { required } from '../config/env';
import type { OperationGateway } from '../usage/operations';
import { eventKey } from '../domain/policy';
const Result=z.object({web:z.object({results:z.array(z.object({url:z.string().url(),title:z.string(),description:z.string().default('')}))}).optional()});
export async function searchBrave(operations:OperationGateway,key:string,query:string,country='US',language='en'){
 const locale=searchLocale(query,country);
 if(locale.query.length>400)throw new Error('search_query_limit');
 const url=new URL('https://api.search.brave.com/res/v1/web/search');
 url.search=new URLSearchParams({q:locale.query,count:'5',country:locale.country,search_lang:language,freshness:'py'}).toString();
 const result=await operations.run(key,'brave',{query:locale.query,country:locale.country,targetCountry:country,language},'0.005',1,Result,async()=>{
  const r=await fetch(url,{headers:{'X-Subscription-Token':required('BRAVE_SEARCH_API_KEY'),Accept:'application/json'},signal:AbortSignal.timeout(12000)});
  const body=await r.json();return {response:body,usage:{http_status:r.status,queries:1,request_id:r.headers.get('x-request-id'),price_version:'2026-09-06-search'},actual:r.ok?'0.005':null};
 });
 return (result.web?.results??[]).slice(0,4).map(r=>({...r,eventKey:eventKey(r.url),source:'brave',country,searchCountry:locale.country,language,discoveredAt:new Date().toISOString()}));
}
