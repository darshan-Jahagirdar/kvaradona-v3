/** Match the browser's target host, including an explicit local port. */
export function sameRequestOrigin(origin:string|null,host:string|null,protocol:string){
 return Boolean(host&&origin===`${protocol}//${host}`);
}
