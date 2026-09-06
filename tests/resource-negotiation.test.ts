import{it,expect,vi}from'vitest';
vi.mock('node:dns/promises',()=>({lookup:async()=>[{address:'8.8.8.8',family:4}]}));
vi.mock('undici',()=>({Agent:class{async close(){}},request:async(url:URL,options:{headers:Record<string,string>})=>{
 // A strict origin negotiates each asset's MIME type; HTML/JSON-only Accept
 // reproduced the collector's 406 for a JavaScript dependency.
 const type=url.pathname.endsWith('.js')?'text/javascript':'text/css';
 const accepted=options.headers.accept.split(',').some(x=>x.trim().split(';')[0]==='*/*'||x.trim()===type);
 const bytes=Buffer.from(accepted?'fixture asset':'Not Acceptable');
 return {statusCode:accepted?200:406,headers:{'content-type':type},body:(async function*(){yield bytes;})()};
}}));
import{safeRead}from'../src/capture/fetch';
it('negotiates public script and stylesheet responses without excluding their formats',async()=>{
 for(const path of ['critical.js','critical.css']){
 const result=await safeRead(`https://fixture.invalid/${path}`);
 expect(result.status).toBe(200);expect(result.text).toBe('fixture asset');
 }
});
