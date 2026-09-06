import { createClient } from '@supabase/supabase-js';
import { required } from '../config/env';
export function serviceClient() {
  return createClient(required('NEXT_PUBLIC_SUPABASE_URL'), required('SUPABASE_SECRET_KEY'), { auth: { persistSession:false,autoRefreshToken:false } });
}
export interface Store { rpc(name:string, args:Record<string,unknown>):Promise<unknown>; }
export function hostedStore(): Store {
  const client=serviceClient();
  return { async rpc(name,args) { const {data,error}=await client.rpc(name,args); if(error) throw new Error(error.message); return data; } };
}
