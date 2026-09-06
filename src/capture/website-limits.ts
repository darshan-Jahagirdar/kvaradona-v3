/** Collection limits are independent of model timeouts and the cumulative API budget. */
export const websiteLimits={
 totalMs:240000,navigationMs:90000,settleMs:60000,
 requests:160,bytes:25000000,concurrent:6,optionalConcurrent:2,
 criticalBytes:2000000,optionalBytes:750000,optionalMs:5000,
 images:12,fonts:8,
} as const;
