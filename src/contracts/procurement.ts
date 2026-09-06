import {z} from 'zod';
export const ProcurementNotice=z.object({source:z.enum(['sam','contracts_finder']).default('sam'),noticeId:z.string(),solicitationNumber:z.string().nullable(),buyer:z.string().nullable(),buyerCode:z.string().nullable(),title:z.string(),url:z.string().url(),postedAt:z.string().nullable(),observedAt:z.string().datetime(),type:z.string().nullable(),baseType:z.string().nullable(),active:z.enum(['yes','no','unknown']),deadlineRaw:z.string().nullable(),deadlineUtc:z.string().nullable(),archiveDate:z.string().nullable(),setAside:z.string().nullable(),naics:z.string().nullable(),awarded:z.boolean(),descriptionUrl:z.string().nullable(),attachmentUrls:z.array(z.string()).max(100),snapshotHash:z.string(),description:z.string().max(18000).optional(),descriptionTruncated:z.boolean().optional(),releaseId:z.string().optional()});
export type ProcurementNotice=z.infer<typeof ProcurementNotice>;
export const ProcurementDetails=z.object({
 requirements:z.array(z.object({requirement:z.string().max(500),evidenceId:z.string().uuid(),quote:z.string().max(800),response:z.string().max(800),status:z.enum(['proposed_approach','missing_input'])})).min(1).max(5),
 responseRoute:z.object({instruction:z.string().max(600),evidenceId:z.string().uuid(),quote:z.string().max(800)}).nullable(),
 missingInputs:z.array(z.string().max(400)).min(1).max(8),
});
export const ProcurementDocuments=z.object({snapshotHash:z.string(),attemptedUrls:z.array(z.string()),missing:z.array(z.string()),collectedAt:z.string().datetime()});
