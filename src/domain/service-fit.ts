// Admission floor for the configured service catalogue; not a buying-intent score.
// A journey term stays admissible when the audience qualifies it ("patient-journey"), since the
// catalogue entry is CRO either way; the qualifier names who is journeying, not a different service.
export function supportedService(text:string){return /\b(HubSpot|Salesforce|Zoho|CRM|CRO|AEO|SEO|search engine optimization|organic search|marketing automation|lifecycle marketing|(?:website|user|customer|patient|visitor|buyer)[ -]journey|website performance|monday\.com|customer relationship management|revenue operations|sales operations|marketing operations|conversion (?:rate|assessment|optimi[sz]ation)|answer engine|web(?:site)? (?:development|design|redesign))\b/i.test(text);}
