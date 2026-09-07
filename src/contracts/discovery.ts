import {z} from 'zod';
export const DiscoveryGroup=z.object({asOf:z.string().datetime({offset:true}).optional(),source:z.enum(['brave','apollo','explorium','theirstack','sam','contracts_finder']).default('brave'),region:z.enum(['US','Europe','Australia','Asia','unspecified']).default('unspecified'),country:z.string().regex(/^[A-Z]{2}$/),language:z.string().regex(/^[a-z]{2,3}$/),nextCursor:z.string().max(2000).optional(),page:z.number().int().min(1).max(500).default(1),query:z.string().max(400).default(''),jobTitlePatterns:z.array(z.string().max(160)).max(6).default([]),jobDescriptionPatterns:z.array(z.string().max(160)).max(6).default([]),postedWithinDays:z.number().int().min(1).max(90).default(30)});
export const DiscoveryConfig=z.object({asOf:z.string().datetime({offset:true}).optional(),groups:z.array(DiscoveryGroup).min(1).max(16),groupIndex:z.number().int().nonnegative().max(1000000),maxResearch:z.number().int().min(0).max(4).default(1),seenTheirStackIds:z.array(z.number().int().positive().safe()).max(500).default([])});
export const ProviderJob=z.object({provider:z.literal('theirstack'),id:z.string().regex(/^\d+$/),kind:z.literal('provider_reported'),sourceUrl:z.string().url(),finalUrl:z.string().url().nullable(),company:z.string().nullable(),companyDomain:z.string().nullable(),headquartersCountry:z.string().nullable(),jobCountries:z.array(z.string()),postedAt:z.string().nullable(),discoveredAt:z.string().nullable(),closedAt:z.string().nullable(),description:z.string().max(6000),observedAt:z.string().datetime()});
export type DiscoveryGroup=z.infer<typeof DiscoveryGroup>;

export const ProviderCompany=z.object({
 provider:z.enum(['apollo','explorium']),id:z.string().min(1).max(200),kind:z.literal('provider_reported'),name:z.string().min(1).max(300),
 domain:z.string().nullable(),headquartersCountry:z.string().nullable(),employees:z.number().int().nonnegative().nullable(),industry:z.string().nullable(),employeeRange:z.string().nullable().optional(),
 observedAt:z.string().datetime(),sourceUrl:z.string().url(),
 provenance:z.object({name:z.literal('name'),domain:z.enum(['primary_domain','website_url','domain','unavailable']),headquartersCountry:z.enum(['country','country_name']),employees:z.enum(['estimated_num_employees','number_of_employees_range']),industry:z.enum(['industry','naics_description'])}),
 icp:z.object({status:z.enum(['match','unknown','mismatch']),reasons:z.array(z.string()),unknowns:z.array(z.string()),searchCountry:z.string()}),
 intent:z.object({status:z.enum(['unknown','provider_reported']),reason:z.string(),topics:z.array(z.object({topic:z.string(),score:z.number().min(0).max(100),sourceDate:z.string().nullable()})).optional()})
});
export type ProviderCompany=z.infer<typeof ProviderCompany>;
