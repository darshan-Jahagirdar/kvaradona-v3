export type SourceAttempt={url:string;stage:'robots'|'page'|'attribution';code:string;status?:number};
export class SourceReadError extends Error {
 constructor(readonly detail:SourceAttempt){super(detail.code);}
}
export function sourceFailure(error:unknown,url:string,stage:SourceAttempt['stage']):SourceAttempt{
 if(error instanceof SourceReadError)return error.detail;
 const e=error as {message?:unknown;code?:unknown;cause?:{code?:unknown}}|null;
 const value=e?.cause?.code??e?.code??e?.message;
 const code=typeof value==='string'&&/^[a-z0-9_]{1,80}$/i.test(value)?value:'source_unavailable';
 const u=new URL(url);u.username='';u.password='';u.search='';u.hash='';
 return {url:u.href,stage,code};
}
