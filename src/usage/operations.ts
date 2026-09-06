import { z } from 'zod';
import type { Store } from '../persistence/client';
import type { Job } from '../contracts/pipeline';
import { hash } from '../domain/policy';
const Operation=z.object({id:z.string().uuid(),state:z.enum(['reserved','dispatched','succeeded','ambiguous']),response:z.unknown(),actual_usd:z.union([z.string(),z.number()]).nullable()});
export class OperationGateway {
 constructor(private store:Store,private job:Job) {}
 async run<T>(key:string,provider:string,request:unknown,max:string,units:number,validate:z.ZodType<T>,dispatch:()=>Promise<{response:unknown;usage:unknown;actual:string|null}>):Promise<T> {
  const requestHash=hash(request);
  const op=Operation.parse(await this.store.rpc('reserve_operation',{p_job:this.job.id,p_token:this.job.attempt_token,p_key:`${this.job.business_key}:${key}`,p_provider:provider,p_hash:requestHash,p_max:max,p_units:units}));
  if(op.state==='succeeded') { if(op.actual_usd===null) throw new Error('unknown_usage_requires_reconciliation'); return validate.parse(op.response); }
  if(op.state!=='reserved') throw new Error('ambiguous_provider_operation');
  // An uncertain dispatch acknowledgement never authorizes a provider request.
  if(await this.store.rpc('dispatch_operation',{p_operation:op.id,p_job:this.job.id,p_token:this.job.attempt_token})!==true) throw new Error('ownership_lost');
  let result;
  try { result=await dispatch(); } catch { throw new Error('ambiguous_provider_operation'); }
  const args={p_operation:op.id,p_hash:requestHash,p_response:result.response,p_usage:result.usage,p_actual:result.actual};
  // This retry only persists an already-returned response. Never call the provider again.
  try { await this.store.rpc('record_operation',args); }
  catch { await this.store.rpc('record_operation',args); }
  if(result.actual===null) throw new Error('unknown_usage_requires_reconciliation');
  return validate.parse(result.response);
 }
}
