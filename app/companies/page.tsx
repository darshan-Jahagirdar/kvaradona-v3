import type { Metadata } from 'next';
import { connection } from 'next/server';
import { notFound, redirect } from 'next/navigation';
import { loadCompanyPreview } from '../../src/company-preview/server';
import { logout } from '../login/actions';
import { CompanyResearch } from '../../components/company-research';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Kvaradona · Company research', robots: { index: false, follow: false, nocache: true } };

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return <main className="login"><div className="brand"><span className="monogram">K</span> KVARADONA <small>V3</small></div>
    <section className="login-card"><h1>{title}</h1>{children}<form action={logout}><button className="primary">Sign out</button></form></section></main>;
}

export default async function Companies() {
  // Rendered per request: the private content is only ever read after the caller is authorized.
  await connection();
  const access = await loadCompanyPreview();
  if (access.status === 'unavailable') notFound();
  if (access.status === 'signin') redirect('/login');
  if (access.status === 'forbidden') return <Notice title="Access pending"><p className="muted">This company research is limited to members of its review organization.</p></Notice>;
  if (access.status === 'check_failed') return <Notice title="Access check unavailable"><p className="muted">Membership could not be confirmed, so nothing is shown. <a href="/companies">Retry</a></p></Notice>;
  if (access.status === 'misconfigured') return <Notice title="Company research unavailable"><p className="muted">This preview is not configured correctly, so no content is shown.</p></Notice>;

  return <div className="workspace">
    <aside>
      <div className="brand"><span className="monogram">K</span>KVARADONA <small>V3</small></div>
      <p className="eyebrow nav-label">PREVIEW</p>
      <a className="nav active" href="/companies" aria-current="page">◈ Company research <span>{access.content.counts.companies}</span></a>
      <div className="sidebar-bottom"><p>Read-only preview.<br />Sending is disabled.</p><form action={logout}><button className="text-button">Sign out</button></form></div>
    </aside>
    <main className="inbox"><CompanyResearch content={access.content} /></main>
  </div>;
}
