import {it,expect} from 'vitest';
import {pdfText} from '../src/capture/procurement';
it('extracts a bounded actual PDF in a disposable process and rejects corrupt input',async()=>{
 const words='Example procurement fixture requires CRM discovery and a practical implementation outline. Supplier eligibility, pricing and proof must be confirmed before any response is submitted.';
 const stream=`BT /F1 3 Tf 50 750 Td (${words}) Tj ET`;
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
 let pdf='%PDF-1.4\n',offsets=[0];objects.forEach((object,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${object}\nendobj\n`;});const xref=pdf.length;pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
 expect(await pdfText(Buffer.from(pdf))).toContain('Example procurement fixture');await expect(pdfText(Buffer.from('corrupt'))).rejects.toThrow('pdf_extraction_unavailable');
});
