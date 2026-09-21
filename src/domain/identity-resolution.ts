import type {Evidence,Packet} from '../contracts/pipeline';
import {ProviderCompany} from '../contracts/discovery';
import {hostOf} from './policy';

/** A reviewer-selected careers or index record names an employer in its structured data. Building a
 *  company record from that is identification, not invention: the name and host both come from the
 *  page's own machine-readable employer fields, validated by the capture's attribution basis.
 *
 *  Returns null when the page does not carry a usable employer identity, so an ambiguous listing
 *  stays unresolved rather than being attached to a guessed corporate domain. */
export function companyFromSelectedSource(e:Evidence,candidateUrl:string):ProviderCompany|null{
 const a=e.attribution;
 if(!a?.issuerName||!a.issuerHost)return null;
 if(!['structured_employer','structured_issuer','explicit_issuer_link'].includes(a.basis))return null;
 let host:string;
 try{host=hostOf('https://'+a.issuerHost.replace(/^https?:\/\//,''));}catch{return null;}
 if(!host.includes('.'))return null;
 const parsed=ProviderCompany.safeParse({
  provider:'marketing',id:`selected-source:${host}`,kind:'provider_reported',
  name:a.issuerName,domain:host,headquartersCountry:null,employees:null,industry:null,
  observedAt:e.retrievedAt,sourceUrl:candidateUrl,
  provenance:{name:'name',domain:'domain',headquartersCountry:'country',employees:'estimated_num_employees',industry:'industry'},
  icp:{status:'unknown',
   reasons:[`Employer identified from the selected source's own structured employer fields (${a.basis}).`],
   unknowns:['Employee count, country and industry are unknown for this identified company; the listing does not report them.'],
   searchCountry:'unspecified'},
  intent:{status:'unknown',reason:'Identified from a reviewer-selected source; no provider intent observation exists.'}});
 return parsed.success?parsed.data:null;
}

/** Whether another resolution round can plausibly change the outcome, so a company is never cycled
 *  through the same stage on unchanged evidence. */
export function resolutionExhausted(p:Packet,limit=2){return (p.pendingResolution?.attempts??0)>=limit;}
