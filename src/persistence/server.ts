import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
export async function userClient() {
 const jar=await cookies();
 return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,{
  cookies:{getAll:()=>jar.getAll(),setAll:(values)=>{try{for(const {name,value,options} of values) jar.set(name,value,options);}catch{/* Server component cookie refresh is handled by proxy. */}}}
 });
}
