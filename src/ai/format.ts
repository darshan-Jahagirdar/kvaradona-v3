import {zodTextFormat} from 'openai/helpers/zod';
import type {z} from 'zod';
// Keep the transport schema within the documented Structured Outputs subset.
// Zod still enforces lengths and the full email regex on the returned output.
export function modelTextFormat<T>(schema:z.ZodType<T>,name:string){
 const format=zodTextFormat(schema,name);
 function visit(value:unknown):unknown{
  if(Array.isArray(value))return value.map(visit);
  if(!value||typeof value!=='object')return value;
  const node=value as Record<string,unknown>;
  return Object.fromEntries(Object.entries(node).filter(([key])=>
   !(node.type==='string'&&(key==='minLength'||key==='maxLength'||(key==='pattern'&&node.format==='email')))
  ).map(([key,child])=>[key,visit(child)]));
 }
 return {...format,schema:visit(format.schema) as Record<string,unknown>};
}
