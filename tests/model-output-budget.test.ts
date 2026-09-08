import {it,expect} from 'vitest';
import {z} from 'zod';
import {OpenAIGateway} from '../src/ai/gateway';
import type {OperationGateway} from '../src/usage/operations';
import {money} from '../src/usage/money';
it('reserves the enforced output ceiling and refuses limits above the gateway maximum before dispatch',async()=>{
 const calls:{max:string;tokens:number}[]=[];
 const operations={async run(_key:string,_provider:string,params:{model:string;max_output_tokens:number},max:string){calls.push({max,tokens:params.max_output_tokens});return {status:'completed',model:params.model,id:'fixture',text:'{"answer":"fixture"}'};}} as unknown as OperationGateway;
 const ai=new OpenAIGateway(operations),schema=z.object({answer:z.string()});
 await ai.generate('A5','review',schema,'Fixture only.',{});
 await ai.generate('A5','review',schema,'Fixture only.',{},{maxOutputTokens:1024});
 expect(calls.map(c=>c.tokens)).toEqual([2048,1024]);expect(money(calls[0].max)-money(calls[1].max)).toBe(money('0.02048'));
 await expect(ai.generate('A5','review',schema,'Fixture only.',{},{maxOutputTokens:4096})).rejects.toThrow();expect(calls).toHaveLength(2);
});
