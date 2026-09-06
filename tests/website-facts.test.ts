import {it,expect} from 'vitest';
import {selectWebsiteFacts} from '../src/capture/website-facts';
import type {WebsiteFact} from '../src/contracts/website';

it('retains metadata and both viewport categories under a crowded evidence budget without changing observations',()=>{
 const fact=(id:string,viewport:WebsiteFact['viewport'],category:WebsiteFact['category'],text='sample'):WebsiteFact=>({id,viewport,category,text,selector:null});
 const facts=[...Array.from({length:40},(_,i)=>fact(`mobile_cta_${i}`,'mobile','cta','Long action label '.repeat(70))),fact('mobile_content','mobile','content'),fact('title','page','content'),fact('robots','page','discovery'),fact('desktop_content','desktop','content'),fact('desktop_form','desktop','form')];
 const before=structuredClone(facts),result=selectWebsiteFacts(facts,4000,8);
 expect(result.facts.map(f=>f.id)).toEqual(expect.arrayContaining(['title','robots','mobile_cta_0','mobile_content','desktop_content','desktop_form']));
 expect(Buffer.byteLength(JSON.stringify(result.facts))).toBeLessThanOrEqual(4000);expect(result.facts.length).toBeLessThanOrEqual(8);
 expect(result.omitted).toBe(facts.length-result.facts.length);expect(facts).toEqual(before);for(const f of result.facts)expect(facts).toContainEqual(f);
});
