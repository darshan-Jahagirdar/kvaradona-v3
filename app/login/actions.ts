'use server';
import { redirect } from 'next/navigation';
import { userClient } from '../../src/persistence/server';
import { authConfigFingerprint } from '../../src/domain/auth-diagnostics';
export async function login(form:FormData) {
 const email=String(form.get('email')??'').trim(),password=String(form.get('password')??'');
 if(!email||!password) redirect('/login?error=missing');
 const client=await userClient();const {error}=await client.auth.signInWithPassword({email,password});
 if(error){
  // Only the provider's status and error code, plus the configuration fingerprint. Never the
  // email, password, tokens or request body.
  console.log(JSON.stringify({diagnostic:'auth_error',status:error.status??null,code:error.code??null,...authConfigFingerprint()}));
  redirect('/login?error=failed');
 }
 redirect('/');
}
export async function logout(){const client=await userClient();await client.auth.signOut();redirect('/login');}
