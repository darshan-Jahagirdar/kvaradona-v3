export function failureDiagnostics(error:unknown){
 const e=error&&typeof error==='object'?error as Record<string,unknown>:{};
 const marker=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z][a-zA-Z0-9_.\[\]]{0,79}$/.test(v)?v:null;
 return {httpStatus:Number.isInteger(e.status)&&Number(e.status)>=100&&Number(e.status)<=599?Number(e.status):null,code:marker(e.code),parameter:marker(e.param),requestId:typeof e.request_id==='string'&&/^req_[a-zA-Z0-9_]{1,100}$/.test(e.request_id)?e.request_id:null};
}
