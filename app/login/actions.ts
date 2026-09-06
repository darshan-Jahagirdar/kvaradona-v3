'use server';
import { redirect } from 'next/navigation';
import { userClient } from '../../src/persistence/server';
export async function login(form:FormData) {
 const email=String(form.get('email')??'').trim(),password=String(form.get('password')??'');
 if(!email||!password) redirect('/login?error=missing');
 const client=await userClient();const {error}=await client.auth.signInWithPassword({email,password});
 if(error) redirect('/login?error=failed');redirect('/');
}
export async function logout(){const client=await userClient();await client.auth.signOut();redirect('/login');}
