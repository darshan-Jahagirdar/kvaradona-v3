import OpenAI from 'openai';
import { modelTextFormat } from './format';
import { z } from 'zod';
import { required } from '../config/env';
import { modelCost,money,usd,PRICE_VERSION,type Model } from '../usage/money';
import type { OperationGateway } from '../usage/operations';
export const roleModels={A1:'gpt-5.6-luna',A2:'gpt-5.6-terra',A3:'gpt-5.6-terra',A4:'gpt-5.6-luna',A5:'gpt-5.6-terra',A6:'gpt-5.6-luna'} as const;
export interface AI { generate<T>(role:keyof typeof roleModels,key:string,schema:z.ZodType<T>,instructions:string,input:unknown,limits?:{maxOutputTokens:number}):Promise<T>; }
const Result=z.object({status:z.string().nullable(),text:z.string(),model:z.string(),id:z.string()});
export class OpenAIGateway implements AI {
 constructor(private operations:OperationGateway,private draftModel?:'gpt-5.6-terra'){}
 async generate<T>(role:keyof typeof roleModels,key:string,schema:z.ZodType<T>,instructions:string,input:unknown,limits?:{maxOutputTokens:number}):Promise<T>{
  const model:Model=role==='A4'&&this.draftModel?this.draftModel:roleModels[role];const format=modelTextFormat(schema,key.replace(/[^a-z0-9_]/gi,'_'));
  const content=JSON.stringify(input);if(Buffer.byteLength(content)>24000)throw new Error('model_input_limit');
  const maxOutput=z.number().int().min(256).max(2048).parse(limits?.maxOutputTokens??2048);
  const params={model,instructions,input:content,text:{format},max_output_tokens:maxOutput,reasoning:{effort:'low' as const},service_tier:'default' as const,store:false};
  // UTF-8 byte count plus protocol margin is a deliberately conservative text-token ceiling.
  // Reserve the cache-write premium even though explicit cache writes are not requested.
  const inputBound=Buffer.byteLength(JSON.stringify(params))+2048;
  const max=usd((money(modelCost(model,inputBound,0))*5n+3n)/4n+money(modelCost(model,0,maxOutput)));
  const result=Result.parse(await this.operations.run(key,'openai',params,max,0,Result,async()=>{
   const client=new OpenAI({apiKey:required('OPENAI_API_KEY'),maxRetries:0,timeout:55000});
   const response=await client.responses.create(params);const usage=response.usage;
   let actual:string|null=null;
   try{if(usage)actual=modelCost(response.model,usage.input_tokens,usage.output_tokens,usage.input_tokens_details.cached_tokens,usage.input_tokens_details.cache_write_tokens??0);}catch{/* Unknown billed model/categories retain the reservation. */}
   return {response:{status:response.status??null,text:response.output_text,model:response.model,id:response.id},usage:{...usage,request_id:response._request_id,requested_model:model,returned_model:response.model,role,price_version:PRICE_VERSION},actual};
  }));
  if(result.status!=='completed')throw new Error('model_incomplete_or_refused');
  return schema.parse(JSON.parse(result.text));
 }
}
