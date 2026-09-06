import {it,expect} from 'vitest';
import {z} from 'zod';
import {imageDescriptor} from '../src/ai/images';
import {OpenAIGateway} from '../src/ai/gateway';
import type {OperationGateway} from '../src/usage/operations';
import {money} from '../src/usage/money';
it('bounds actual PNG dimensions, reserves image tokens, and routes visual A3 through Sol without exposing image bytes in operation metadata',async()=>{
 // Header-only fixture exercises accounting and validation; it is never dispatched to an API.
 const png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.write('IHDR',12);png.writeUInt32BE(1440,16);png.writeUInt32BE(900,20);
 const image={png,width:1440,height:900,id:'desktop'};expect(imageDescriptor(image).tokens).toBe(1567);expect(()=>imageDescriptor({...image,width:1600})).toThrow('invalid_bounded_image');
 const calls:{model:string;images?:unknown;input:string;max:string}[]=[];
 const operations={async run(_k:string,_p:string,request:{model:string;images?:unknown;input:string},max:string){calls.push({...request,max});return {status:'completed',model:request.model,id:'fixture',text:'{"answer":"fixture"}'};}} as unknown as OperationGateway;
 const ai=new OpenAIGateway(operations),schema=z.object({answer:z.string()});await ai.generate('A3','fixture',schema,'Fixture.',{},{maxOutputTokens:1024,images:[image]});await ai.generate('A5','fixture',schema,'Fixture.',{},{maxOutputTokens:1024,images:[image]});
 expect(calls.map(c=>c.model)).toEqual(['gpt-5.6-sol','gpt-5.6-terra']);expect(JSON.stringify(calls)).not.toContain(png.toString('base64'));expect(calls[0].images).toBeDefined();expect(money(calls[0].max)).toBeGreaterThan(money('0.02048'));
 await expect(ai.generate('A3','fixture',schema,'Fixture.',{},{maxOutputTokens:1024,images:[image,image,image]})).rejects.toThrow('image_role_or_count_limit');expect(calls).toHaveLength(2);
});
