import {randomUUID} from 'node:crypto';
import {load} from 'cheerio';
import type {Evidence,Packet} from '../contracts/pipeline';
import {firstPartyATS,hostOf} from './policy';
import {structuredValues,validStructuredFact} from './structured-evidence';
export const companyNameKey=(name:string)=>name.toLowerCase().replace(/[^a-z0-9]/g,'');
export const ownedHost=(host:string,companyHost:string)=>host===companyHost||host.endsWith('.'+companyHost);
/** A company, plus any domain that has been SUPPORTED as the same company's current address.
 *  Aliases are supplied by the packet's recorded identity resolution; they are never guessed here. */
type Company={domain:string|null;name:string;aliases?:readonly string[]};
/** Every host this company is known at: its canonical domain and any supported alias. One policy,
 *  used by attribution, evidence reuse, deduplication and the contact/website paths alike. */
export function identityOwnedHost(host:string,company:Company){
 if(company.domain&&ownedHost(host,company.domain))return true;
 return (company.aliases??[]).some(a=>Boolean(a)&&ownedHost(host,a));
}
export function issuerBasisValid(e:Evidence){
 const a=e.attribution;if(!a?.issuerName||!a.issuerHost||a.publisherHost!==hostOf(e.finalUrl))return false;
 if(a.sourceRef){
  const values=structuredValues(e,a.sourceRef);
  if(!values||values[0]!==a.issuerName||typeof values[1]!=='string')return false;
  try{return hostOf(values[1])===a.issuerHost;}catch{return false;}
 }
 if(a.linkSource){
  const $=load(a.linkSource.html),links=$('a[href]').toArray();
  if(links.length!==1||$(links[0]).text().trim()!==a.linkSource.label)return false;
  try{const href=new URL($(links[0]).attr('href')!,e.finalUrl).href;
   return href===a.linkSource.href&&hostOf(href)===a.issuerHost&&(a.basis==='structured_employer'?a.linkSource.label.toLowerCase().startsWith(a.issuerName.toLowerCase()):a.linkSource.label===a.issuerName&&/^(News provided by|Source:)\s+/i.test($.root().text().trim()));
  }catch{return false;}
 }
 return false;
}
function issuerNames(company:Company,known:Evidence[]){
 const names=[company.name];if(!company.domain)return names;
 for(const e of known){
  if(e.origin!=='original'||!identityOwnedHost(hostOf(e.finalUrl),company))continue;
  for(const f of e.companyFacts??[])if(['name','alternateName'].includes(f.field)&&validStructuredFact(e,f))names.push(String(f.value));
 }
 return names;
}
/** A company that has moved domains.
 *
 *  Accepting an alias requires BOTH signals, because either alone is forgeable or coincidental:
 *   - the company's OWN domain redirected here (recorded requested host vs final host), and
 *   - the destination's own structured identity names the same company.
 *
 *  A redirect can point anywhere, and any page can mention a company name. Neither a hard-coded
 *  domain pair nor a name match alone is accepted. */
export function redirectAliasEvidence(e:Evidence,company:Company){
 if(!company.domain||e.origin!=='original')return null;
 let requested:string,final:string;
 try{requested=hostOf(e.url);final=hostOf(e.finalUrl);}catch{return null;}
 if(!ownedHost(requested,company.domain)||ownedHost(final,company.domain))return null;
 const named=(e.companyFacts??[]).some(f=>['name','alternateName'].includes(f.field)
  &&validStructuredFact(e,f)&&companyNameKey(String(f.value))===companyNameKey(company.name));
 if(!named)return null;
 return {from:company.domain,to:final,basis:'first_party_redirect_with_structured_identity' as const,
  evidenceId:e.id,requestedUrl:e.url,finalUrl:e.finalUrl};
}
export function companyAttributionValid(e:Evidence,company:Company,known:Evidence[]=[]){
 if(!company.domain||e.origin!=='original')return false;
 const publisher=hostOf(e.finalUrl),a=e.attribution;
 // The company's own domain, or a domain already SUPPORTED as its current address. A direct read of
 // the resolved domain is the same company's page; it does not have to redirect again to qualify.
 if(identityOwnedHost(publisher,company)&&!firstPartyATS(publisher))return e.accountHost===publisher||e.accountHost===company.domain||(company.aliases??[]).includes(e.accountHost??'');
 // The company's own domain redirected here and this page carries its structured identity, so this
 // is the same company at its current address rather than an unrelated third-party host.
 if(redirectAliasEvidence(e,company))return e.accountHost===publisher||e.accountHost===company.domain||(company.aliases??[]).includes(e.accountHost??'');
 // Legacy ATS packets retain their previously validated employer attribution and IDs.
 if(!a&&firstPartyATS(publisher)&&e.accountHost===company.domain&&e.source==='job_posting_web')return true;
 return Boolean(a?.issuerHost&&identityOwnedHost(a.issuerHost,company)&&a.issuerName&&issuerNames(company,known).some(name=>companyNameKey(name)===companyNameKey(a.issuerName!))&&['structured_issuer','explicit_issuer_link','structured_employer'].includes(a.basis)&&issuerBasisValid(e));
}
/** Always validate off-domain issuer name, host and raw basis, even when accountHost is prefilled. */
export function attributeCompanyEvidence(e:Evidence,company:Company,known:Evidence[]=[]):Evidence {
 if(!company.domain||e.origin!=='original')return e;
 const valid=companyAttributionValid(e,company,known);
 const accountHost=valid?company.domain:e.accountHost===company.domain?null:e.accountHost;
 return accountHost===e.accountHost?e:{...e,accountHost,id:randomUUID(),derivedFromEvidenceId:e.id};
}
export function usableCompanyEvidence(e:Evidence,company:Company,known:Evidence[]=[]){return e.accountHost===company.domain&&companyAttributionValid(e,company,known)&&Number.isFinite(Date.parse(e.retrievedAt))&&Date.parse(e.retrievedAt)<=Date.now()+60000;}
/** Contact aliases require a shared provider domain and an original page naming the researched brand. */
export function evidencedCompanyNames(p:Packet):string[]{
 const r=p.research,c=p.candidate?.providerCompany;if(!r)return [];
 const names=[r.company];
 if(c?.domain===r.accountHost&&p.evidence.some(e=>e.origin==='original'&&e.accountHost===r.accountHost&&companyNameKey(e.text).includes(companyNameKey(r.company))))names.push(c.name);
 return [...new Set([...names,...issuerNames({domain:r.accountHost,name:r.company},p.evidence)])];
}
