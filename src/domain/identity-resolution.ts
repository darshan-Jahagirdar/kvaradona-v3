import type {Evidence,Packet} from '../contracts/pipeline';
import {ProviderCompany} from '../contracts/discovery';
import {hostOf} from './policy';
import {issuerBasisValid,companyNameKey,ownedHost} from './evidence-attribution';
import {validStructuredFact} from './structured-evidence';

/** The single supported identity for a company, used everywhere the pipeline needs a host.
 *
 *  `canonical` stays the historical provider-reported domain: it is never rewritten, and evidence
 *  stays grouped under it. `effective` is the address the company is actually reachable at now,
 *  which is the canonical domain unless a resolution supported a move. `hosts` is both, for checks
 *  that must consider either (exclusions, relationships, employer verification). */
export function companyIdentity(p:Packet,fallbackHost?:string|null){
 const c=p.candidate?.providerCompany;
 const canonical=c?.domain??fallbackHost??p.research?.accountHost??null;
 const a=p.identityResolution;
 const effective=a&&canonical&&a.from===canonical?a.to:canonical;
 const hosts=[...new Set([canonical,effective].filter((h):h is string=>Boolean(h)))];
 return {name:c?.name??p.research?.company??'',canonical,effective,hosts,
  aliases:hosts.filter(h=>h!==canonical),moved:Boolean(a&&canonical&&a.from===canonical)};
}
/** The company record attribution should judge against: its canonical domain plus supported aliases. */
export function attributionIdentity(p:Packet,company?:{domain:string|null;name:string}){
 const id=companyIdentity(p,company?.domain);
 return {domain:company?.domain??id.canonical,name:company?.name??id.name,aliases:id.aliases};
}
/** The host live work should use: contact search, website capture and direct company reads. */
export function effectiveHost(p:Packet,canonical:string|null|undefined){
 const a=p.identityResolution;
 return a&&canonical&&a.from===canonical?a.to:(canonical??null);
}

/** A reviewer-selected careers or index record names an employer in its structured data. Building a
 *  company record from that is identification, not invention: the name and host both come from the
 *  page's own machine-readable employer fields, and the RAW structured source or issuer link is
 *  revalidated here rather than trusting the attribution summary that was written alongside it.
 *
 *  Returns null when the page does not carry a usable, verifiable employer identity, so an ambiguous
 *  listing stays unresolved rather than being attached to a guessed corporate domain. */
export function companyFromSelectedSource(e:Evidence,candidateUrl:string):ProviderCompany|null{
 const a=e.attribution;
 if(!a?.issuerName||!a.issuerHost)return null;
 if(!['structured_employer','structured_issuer','explicit_issuer_link'].includes(a.basis))return null;
 // The raw JSON-LD pointers or the single labelled issuer link must actually say this, on this page.
 if(!issuerBasisValid(e))return null;
 let host:string;
 try{host=hostOf('https://'+a.issuerHost.replace(/^https?:\/\//,''));}catch{return null;}
 if(!host.includes('.'))return null;
 const parsed=ProviderCompany.safeParse({
  provider:'marketing',id:`selected-source:${host}`,kind:'provider_reported',
  name:a.issuerName,domain:host,headquartersCountry:null,employees:null,industry:null,
  observedAt:e.retrievedAt,sourceUrl:candidateUrl,
  provenance:{name:'name',domain:'domain',headquartersCountry:'country',employees:'estimated_num_employees',industry:'industry'},
  icp:{status:'unknown',
   reasons:[`Employer identified from the selected source's own structured employer fields (${a.basis}), revalidated against its raw structured data.`],
   unknowns:['Employee count, country and industry are unknown for this identified company; the listing does not report them.'],
   searchCountry:'unspecified'},
  intent:{status:'unknown',reason:'Identified from a reviewer-selected source; no provider intent observation exists.'}});
 return parsed.success?parsed.data:null;
}

/** A reviewer's typed answer is a hint, not a fact. It is accepted only when the hinted company's
 *  OWN page carries structured identity with that name, on that host. Typing a domain never
 *  certifies it. */
export function companyFromVerifiedHint(hint:{name:string;domain:string|null},e:Evidence):ProviderCompany|null{
 if(!hint.domain)return null;
 let host:string,final:string;
 try{host=hostOf('https://'+hint.domain.replace(/^https?:\/\//,''));final=hostOf(e.finalUrl);}catch{return null;}
 if(e.origin!=='original'||!ownedHost(final,host))return null;
 const named=(e.companyFacts??[]).filter(f=>['name','alternateName'].includes(f.field)&&validStructuredFact(e,f))
  .map(f=>String(f.value));
 const match=named.find(n=>companyNameKey(n)===companyNameKey(hint.name));
 if(!match)return null;
 const parsed=ProviderCompany.safeParse({
  provider:'marketing',id:`reviewer-verified:${host}`,kind:'provider_reported',
  name:match,domain:host,headquartersCountry:null,employees:null,industry:null,
  observedAt:e.retrievedAt,sourceUrl:e.finalUrl,
  provenance:{name:'name',domain:'domain',headquartersCountry:'country',employees:'estimated_num_employees',industry:'industry'},
  icp:{status:'unknown',
   reasons:[`A reviewer named this company; its own published structured identity on ${host} confirms the name.`],
   unknowns:['Employee count, country and industry remain unknown; the reviewer\'s answer supplies none of them.'],
   searchCountry:'unspecified'},
  intent:{status:'unknown',reason:'Identified from a reviewer answer verified against the company\'s own page; no provider intent observation exists.'}});
 return parsed.success?parsed.data:null;
}

/** Whether another resolution round can plausibly change the outcome, so a company is never cycled
 *  through the same stage on unchanged evidence. */
export function resolutionExhausted(p:Packet,limit=2){return (p.pendingResolution?.attempts??0)>=limit;}
