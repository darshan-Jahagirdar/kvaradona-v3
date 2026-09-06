import {hash,isFresh} from './policy';
export interface ExactMessage {opportunityId:string;version:number;recipient:string;sender:string;subject:string;body:string;attachmentHashes:string[]}
export interface MailState {providerConfigured:boolean;syncCursorValid:boolean;reconciledAt:string|null;relationship:'clear'|'unknown'|'replied'|'suppressed';accountLockOwned:boolean;attempt:'new'|'ambiguous'|'accepted'}
/** Provider-independent eligibility only. This module cannot transmit a message. */
export function outboundHold(message:ExactMessage,approvedHash:string|null,state:MailState,now=Date.now()):string|null{
 if(state.attempt==='accepted')return 'already_accepted';
 if(state.attempt==='ambiguous')return 'reconcile_ambiguous_send';
 if(!approvedHash||approvedHash!==hash(message))return 'exact_approval_required';
 if(!state.providerConfigured)return 'provider_unconfigured';
 if(!state.syncCursorValid||!isFresh(state.reconciledAt,5/1440,now))return 'reply_reconciliation_required';
 if(state.relationship!=='clear')return 'relationship_hold';
 if(!state.accountLockOwned)return 'conversation_lock_required';
 return null;
}
