import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:'Kvaradona · Opportunity review',description:'Evidence-led opportunity review',robots:{index:false,follow:false}};
export default function RootLayout({children}:{children:React.ReactNode}) {return <html lang="en"><body>{children}</body></html>;}
