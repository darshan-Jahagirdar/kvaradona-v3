import { createServerClient } from '@supabase/ssr';
import { NextResponse,type NextRequest } from 'next/server';
export async function proxy(request:NextRequest) {
 let response=NextResponse.next({request});
 const client=createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,{
  cookies:{getAll:()=>request.cookies.getAll(),setAll:values=>{for(const v of values) request.cookies.set(v.name,v.value);response=NextResponse.next({request});for(const v of values) response.cookies.set(v.name,v.value,v.options);}}
 });
 await client.auth.getUser();response.headers.set('Cache-Control','private, no-store');return response;
}
export const config={matcher:['/((?!_next/static|_next/image|favicon.ico).*)']};
