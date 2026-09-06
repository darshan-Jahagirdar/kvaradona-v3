export function displayDate(value:string,includeTime=false){
 const date=new Date(value);if(!Number.isFinite(date.getTime()))return 'Unknown date';
 const iso=date.toISOString();return includeTime?`${iso.slice(0,10)} ${iso.slice(11,19)} UTC`:iso.slice(0,10);
}
