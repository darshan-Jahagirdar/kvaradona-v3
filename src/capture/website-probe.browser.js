// Evaluated as browser JavaScript, without worker-side TypeScript helpers.
function collectWebsiteFacts(viewport){
  const facts=[];
  const clean=(s)=>s?.replace(/\s+/g,' ').trim()??'';
  const visible=(e)=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';};
  const selector=(e)=>{if(e.id)return '#'+CSS.escape(e.id);const parts=[];let current=e;while(current&&parts.length<5){const tag=current.tagName.toLowerCase(),siblings=current.parentElement?[...current.parentElement.children].filter(s=>s.tagName===current.tagName):[];parts.unshift(tag+(siblings.length>1?`:nth-of-type(${siblings.indexOf(current)+1})`:''));current=current.parentElement;}return parts.join(' > ');};
  const name=(e)=>{
   const labelled=e.getAttribute('aria-labelledby')?.split(/\s+/).map(id=>clean(document.getElementById(id)?.textContent??null)).filter(Boolean).join(' ');
   const control=e;
   return labelled||clean(e.getAttribute('aria-label'))||[...(control.labels??[])].map(l=>clean(l.textContent)).filter(Boolean).join(' ')||clean(e.getAttribute('title'))||(['BUTTON','A'].includes(e.tagName)?clean(e.textContent):/^(submit|button|reset)$/.test(control.type)?control.value||control.type:'');
  };
  const add=(id,category,text,e)=>facts.push({id:`${viewport}_${id}`,category,viewport,selector:e?selector(e):null,text:text.slice(0,1600)});
  const rect=(e)=>{const r=e.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};};
  add('layout','mobile',`At ${innerWidth} × ${innerHeight} CSS pixels, document width is ${document.documentElement.scrollWidth}px.`);
  const controls=[...document.querySelectorAll('input:not([type=hidden]),select,textarea')].filter(visible);
  add('forms','form',`${controls.length} visible form controls; ${controls.filter(e=>!name(e)).length} have no detected accessible name. This is a DOM heuristic, not a complete accessibility audit.`);
  controls.slice(0,5).forEach((e,i)=>add(`field_${i}`,'form',JSON.stringify({tag:e.tagName,type:e.getAttribute('type'),name:name(e)||null,required:e.hasAttribute('required'),autocomplete:e.getAttribute('autocomplete'),rect:rect(e)}),e));
  const actions=[...document.querySelectorAll('a[href],button,input[type=submit],a[role=button]')].filter(visible);
  actions.filter(e=>{const r=e.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight;}).slice(0,8).forEach((e,i)=>add(`action_${i}`,e.closest('nav')?'navigation':'cta',JSON.stringify({label:name(e)||null,href:e.getAttribute('href'),tag:e.tagName,rect:rect(e),disabled:e.hasAttribute('disabled')}),e));
  add('navigation','navigation',`${document.querySelectorAll('nav,[role=navigation]').length} navigation landmarks; ${actions.length} visible action/link elements. Controls were inspected without activating them or submitting forms.`);
  const main=document.querySelector('main,[role=main]')??document.body;
  [...main.querySelectorAll('h1,h2,h3')].filter(visible).slice(0,6).forEach((e,i)=>add(`heading_${i}`,'structure',`${e.tagName}: ${clean(e.textContent).slice(0,350)}`,e));
  [...main.querySelectorAll('p,dd,li')].filter(e=>visible(e)&&!e.closest('nav,footer,header')&&clean(e.textContent).length>35).slice(0,5).forEach((e,i)=>add(`passage_${i}`,'content',clean(e.textContent).slice(0,1100),e));
  add('headings','structure',`H1 elements: ${document.querySelectorAll('h1').length}; H2 elements: ${document.querySelectorAll('h2').length}. Counts alone do not establish content quality or AI visibility.`);
  const nav=performance.getEntriesByType('navigation')[0];
  return {facts,title:document.title,bodyText:clean(document.body.innerText).slice(0,12000),robots:[...document.querySelectorAll('meta[name=robots],meta[name=googlebot]')].map(e=>`${e.getAttribute('name')}: ${e.getAttribute('content')}`),canonical:document.querySelector('link[rel=canonical]')?.getAttribute('href')??null,description:document.querySelector('meta[name=description]')?.getAttribute('content')??null,structuredData:[...document.querySelectorAll('script[type="application/ld+json"]')].slice(0,4).map(e=>{try{const value=JSON.parse(e.textContent??'');return JSON.stringify(value).slice(0,1200);}catch{return 'Invalid JSON-LD syntax';}}),domContentLoadedMs:nav?Math.round(nav.domContentLoadedEventEnd):null};
}
