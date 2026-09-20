import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Packet} from '../src/contracts/pipeline';
import {WebsiteCapture,type WebsiteAnalysis} from '../src/contracts/website';
import {websiteSpecialistStep,type WebsiteTools} from '../src/stages/website-specialist';
import {journeyTarget} from '../src/domain/website-specialist';

const host='fixture.invalid';
function capture(url:string,extra:{id:string;category:'cta'|'navigation';text:string}[]=[],complete=true){
 return WebsiteCapture.parse({id:randomUUID(),url,finalUrl:url,accountHost:host,observedAt:new Date().toISOString(),
  version:'web-1',mode:'fixture',complete,renderStable:true,screenshots:[],limitations:[],requests:0,bytes:0,elapsedMs:0,
  facts:[{id:'page_title',category:'content',viewport:'page',selector:null,text:'Fixture'},
   ...extra.map(e=>({id:e.id,category:e.category,viewport:'desktop' as const,selector:null,text:e.text}))]});
}
const action=(label:string,href:string)=>JSON.stringify({label,href,tag:'A',rect:{x:0,y:0,width:10,height:10},disabled:false});

function packet(question:string){
 return Packet.parse({mode:'fixture',state:'researched',notes:[],evidence:[
  {id:randomUUID(),url:`https://${host}/news`,finalUrl:`https://www.${host}/news`,accountHost:host,origin:'original',
   source:'original_web',text:'News',title:'News',contentHash:'h',retrievedAt:new Date().toISOString(),publishedAt:null,status:'unknown'}],
  research:{company:'Fixture',accountHost:host,identityBasis:'f',service:'Website journey',demand:'plausible',whyNow:'f',
   offer:'A conditional review.',buyerRole:'Owner',claims:[],contrary:[],uncertainties:[],decision:'exploration',
   reason:'f',watchTrigger:null,specialist:'cro',specialistReason:question,followUp:null}});
}
const analysis:WebsiteAnalysis={coverage:[{profile:'cro',result:'findings',reason:'r'}],
 findings:[{id:'web_x',profile:'cro',observationIds:['page_title'],hypothesis:'h',validationQuestion:'q',proposedChange:'c'}],
 limitations:['l']};

function tools(pages:Record<string,WebsiteCapture>,fail:string[]=[]){
 const captured:string[]=[],calls:string[]=[];
 const t:WebsiteTools={
  websiteCapture:async(url:string)=>{captured.push(url);if(fail.includes(url))throw new Error('capture_failed');
   const page=pages[url];if(!page)throw new Error('unexpected_capture_target');return page;},
  websiteImages:async()=>[],
  ai:{async generate(role,_key,schema,_i,input){calls.push(role);return schema.parse(role==='A3'?analysis:
   {inputHash:(input as {inputHash:string}).inputHash,acceptable:true,issues:[],
    verdicts:analysis.findings.map(f=>({findingId:f.id,observationIds:f.observationIds,verdict:'supported_hypothesis',reason:''}))});}}};
 return {t,captured,calls};
}

it('picks the journey page the research question asks about, not merely the loudest call to action',()=>{
 const front=capture(`https://www.${host}`,[
  {id:'a1',category:'cta',text:action('Pricing','/pricing')},
  {id:'a2',category:'cta',text:action('Request an appointment','/appointments/request')},
  {id:'a3',category:'navigation',text:action('About','/about')}]);
 const appointment=journeyTarget(front,host,['cro'],'What does a patient meet when requesting an appointment?');
 expect(appointment?.url).toBe(`https://www.${host}/appointments/request`);
 expect(appointment?.why).toContain('appointment');
 // The same page set, a different question, selects a different step.
 expect(journeyTarget(front,host,['cro'],'How is pricing presented to a buyer?')?.url).toBe(`https://www.${host}/pricing`);
});

it('refuses off-host, self-referencing and root links',()=>{
 const front=capture(`https://www.${host}`,[
  {id:'a1',category:'cta',text:action('Demo elsewhere','https://other.invalid/demo')},
  {id:'a2',category:'cta',text:action('Home','/')},
  {id:'a3',category:'cta',text:action('Demo here',`https://www.${host}`)}]);
 expect(journeyTarget(front,host,['cro'],'demo')).toBeNull();
});

it('keeps the journey page across S08 transitions and never recaptures the front door',async()=>{
 const frontUrl=`https://www.${host}`,journeyUrl=`https://www.${host}/demo/request`;
 const front=capture(frontUrl,[{id:'a1',category:'cta',text:action('Request a demo','/demo/request')}]);
 const journey=capture(journeyUrl,[{id:'a1',category:'cta',text:action('Request a demo','/demo/request')}]);
 const p=packet('What does a buyer meet on the demo request step?');
 const h=tools({[frontUrl]:front,[journeyUrl]:journey});

 // Pass 1: capture the front door, follow the company's own call to action.
 expect(await websiteSpecialistStep(p,h.t)).toBe('S08');
 expect(h.captured).toEqual([frontUrl,journeyUrl]);
 expect(p.websiteSupplement?.capture.finalUrl).toBe(journeyUrl);
 expect(p.websiteTarget?.url).toBe(journeyUrl);
 expect(p.websiteJourney?.label).toBe('Request a demo');

 // Pass 2 and 3: analysis and review run against the JOURNEY page, with no further capture.
 const resumed=Packet.parse(JSON.parse(JSON.stringify(p)));
 expect(await websiteSpecialistStep(resumed,h.t)).toBe('S08');
 expect(h.calls).toEqual(['A3']);
 expect(h.captured).toEqual([frontUrl,journeyUrl]);
 expect(resumed.websiteSupplement?.capture.finalUrl).toBe(journeyUrl);

 await websiteSpecialistStep(resumed,h.t);
 expect(h.calls).toEqual(['A3','A5']);
 expect(h.captured).toEqual([frontUrl,journeyUrl]);
 expect(resumed.websiteSupplement?.capture.finalUrl).toBe(journeyUrl);
});

it('keeps the front-door capture when the follow-up fails or does not render',async()=>{
 const frontUrl=`https://www.${host}`,journeyUrl=`https://www.${host}/demo/request`;
 const front=capture(frontUrl,[{id:'a1',category:'cta',text:action('Request a demo','/demo/request')}]);

 // Thrown failure.
 const thrown=tools({[frontUrl]:front},[journeyUrl]);
 const p1=packet('demo request step');
 expect(await websiteSpecialistStep(p1,thrown.t)).toBe('S08');
 expect(p1.websiteSupplement?.capture.finalUrl).toBe(frontUrl);
 expect(p1.websiteJourney).toBeUndefined();
 expect(p1.notes.join(' ')).toContain('the front-door capture was kept');

 // Incomplete render.
 const partial=tools({[frontUrl]:front,[journeyUrl]:capture(journeyUrl,[],false)});
 const p2=packet('demo request step');
 expect(await websiteSpecialistStep(p2,partial.t)).toBe('S08');
 expect(p2.websiteSupplement?.capture.finalUrl).toBe(frontUrl);
 expect(p2.websiteJourney).toBeUndefined();
});

it('uses the canonical origin, not the first original page collected',async()=>{
 const frontUrl=`https://www.${host}`;
 const h=tools({[frontUrl]:capture(frontUrl)});
 const p=packet('front door');
 await websiteSpecialistStep(p,h.t);
 expect(h.captured).toEqual([frontUrl]);
});
