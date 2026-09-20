/** How a stage failure is handled by the shared worker.
 *
 *  `hold` never retries: a paid dispatch whose outcome is unknown stays held and visible, and an
 *  ownership/version loss means another worker or a newer revision owns the work.
 *  `retry` is for failures that happened BEFORE any provider request was dispatched, or for a
 *  completed model output that was rejected by our own schema/identity checks. Re-running those
 *  calls a provider again, so they stay bounded by the existing attempts<3 limit.
 *  `stop` is a deterministic problem that another identical attempt cannot fix.
 */
export type FailureClass='hold'|'retry'|'stop';

/** Uncertain paid dispatch or lost ownership. Retrying either would double-charge or overwrite. */
const held=/^(ambiguous_provider_operation|unknown_usage_requires_reconciliation|ownership_lost|stale_version|operation_key_conflict|explorium_credit_accounting_hold)$/;

/** Transient infrastructure and lookup failures that occur before or around a request. */
const transient=/(^|_)(timeout|timed_out|econnreset|enotfound|eai_again|socket_hang_up|fetch_failed|network)(_|$)|_lookup_failed$|_read_failed$|_unavailable$|^heartbeat_failed$|^saved_search_read_failed$|^job_read_failed$|^claim_failed$/i;

/** Completed-output rejections are NOT retried here. Requeueing the same job keeps the same
 *  business_key, so OperationGateway would replay the identical settled response rather than
 *  generating anything new. S11 handles these itself by persisting a bounded draftAttempt, which
 *  changes the operation key and the input; if one still escapes, another attempt cannot help. */
const completedOutputRejected=/^(invalid_draft_identity_or_claims|invalid_repaired_draft_identity_or_claims|website_profile_required|research_missing)$/;

/** Provider said no, or is switched off. Another immediate attempt changes nothing. */
const providerGate=/^(budget_paused|live_disabled|provider_unverified|free_quota_unverified_or_exhausted|invalid_reservation|apollo_response_limit|search_query_limit)$/;

export function classifyFailure(reason:string):FailureClass{
 const r=reason.trim();
 if(held.test(r))return 'hold';
 if(providerGate.test(r))return 'stop';
 if(completedOutputRejected.test(r))return 'stop';
 if(transient.test(r))return 'retry';
 return 'stop';
}

/** The retry delay is owned by fail_job, which sets due_at and therefore survives a worker restart.
 *  This helper documents the intended escalation for a future migration; the live schedule is the
 *  fixed 60-second requeue fail_job already applies. */
export function intendedRetryDelaySeconds(attempts:number){return Math.min(300,30*Math.max(1,attempts)**2);}
