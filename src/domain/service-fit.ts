// Admission floor for the configured service catalogue; not a buying-intent score.
export function supportedService(text:string){return /\b(HubSpot|Salesforce|Zoho|CRM|CRO|AEO|monday\.com|customer relationship management|revenue operations|sales operations|marketing operations|conversion rate|answer engine|web(?:site)? (?:development|design|redesign))\b/i.test(text);}
