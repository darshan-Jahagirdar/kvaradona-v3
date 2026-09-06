import {expect,it} from 'vitest';
import {outboundHold,type ExactMessage,type MailState} from '../src/domain/outbound';
import {hash} from '../src/domain/policy';
it('holds outbound after laptop downtime, edits, replies and uncertain sends without coupling discovery to mail',()=>{
 const now=Date.parse('2026-09-06T12:00:00Z');
 const message:ExactMessage={opportunityId:'fixture',version:1,recipient:'buyer@example.test',sender:'reviewer@example.test',subject:'A factual idea',body:'A tentative offer.',attachmentHashes:[]};
 const approval=hash(message),state:MailState={providerConfigured:true,syncCursorValid:true,reconciledAt:'2026-09-06T11:59:00Z',relationship:'clear',accountLockOwned:true,attempt:'new'};
 expect(outboundHold(message,approval,state,now)).toBeNull();
 expect(outboundHold(message,approval,{...state,reconciledAt:'2026-09-05T11:59:00Z'},now)).toBe('reply_reconciliation_required');
 expect(outboundHold(message,approval,{...state,syncCursorValid:false},now)).toBe('reply_reconciliation_required');
 expect(outboundHold({...message,recipient:'different@example.test'},approval,state,now)).toBe('exact_approval_required');
 expect(outboundHold({...message,body:'A changed claim.'},approval,state,now)).toBe('exact_approval_required');
 expect(outboundHold(message,approval,{...state,relationship:'replied'},now)).toBe('relationship_hold');
 expect(outboundHold(message,approval,{...state,attempt:'ambiguous'},now)).toBe('reconcile_ambiguous_send');
 expect(outboundHold(message,approval,{...state,attempt:'accepted'},now)).toBe('already_accepted');
 expect(outboundHold(message,approval,{...state,providerConfigured:false},now)).toBe('provider_unconfigured');
});
