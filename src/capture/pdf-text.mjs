// Runs in a disposable, bounded child process; PDF bytes never trigger URL loading.
import {readFile} from 'node:fs/promises';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
const task=getDocument({data:new Uint8Array(await readFile(process.argv[2])),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,verbosity:0});
try{
 const pdf=await task.promise;if(pdf.numPages>30)throw Error('pdf_page_limit');
 let text='';for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i),content=await page.getTextContent();text+=content.items.map(item=>'str' in item?item.str:'').join(' ')+'\n';if(text.length>18000)throw Error('pdf_text_limit');}
 if(text.trim().length<120)throw Error('pdf_text_insufficient');process.stdout.write(JSON.stringify({text:text.replace(/\s+/g,' ').trim()}));
}finally{await task.destroy();}
