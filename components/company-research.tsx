'use client';
import { useEffect, useRef, useState } from 'react';
import type { DisplayCompany, DisplayContent } from '../src/company-preview/content';

type Link = { title: string; url: string | null };
function SourceLinks({ links }: { links: Link[] }) {
  if (!links.length) return null;
  return <span className="cr-cites">{links.map((l, i) => <span key={`${l.title}-${i}`}>{i ? ' · ' : ''}{l.url
    ? <a href={l.url} target="_blank" rel="noreferrer">{l.title} ↗</a>
    : <span>{l.title}</span>}</span>)}</span>;
}

/** Some embedded browsers refuse the async clipboard API; a selection copy still works there. */
function selectionCopy(text: string) {
  const previous = document.activeElement as HTMLElement | null, area = document.createElement('textarea');
  area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
  document.body.appendChild(area); area.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { area.remove(); previous?.focus(); }
}

function CopyButton({ label, text }: { label: string; text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copy() {
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch { copied = selectionCopy(text); }
    setState(copied ? 'copied' : 'failed');
    setTimeout(() => setState('idle'), 2500);
  }
  return <button type="button" className="cr-copy" onClick={copy}>
    {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed — select the text' : label}
    <span className="cr-sr" aria-live="polite">{state === 'copied' ? `${label}: copied` : state === 'failed' ? `${label}: copy failed` : ''}</span>
  </button>;
}

/**
 * Informational only. Opening the dialog is the whole behaviour: no request, no job, no simulated
 * progress. The server-side route lockdown still refuses any workflow request sent by hand.
 */
function RunWorkflow() {
  const dialog = useRef<HTMLDialogElement | null>(null), opener = useRef<HTMLButtonElement | null>(null);
  return <div className="cr-run">
    <button ref={opener} type="button" className="primary cr-run-button" aria-haspopup="dialog" onClick={() => dialog.current?.showModal()}>Run workflow</button>
    <dialog ref={dialog} className="cr-dialog" aria-labelledby="cr-run-title" aria-describedby="cr-run-body" onClose={() => opener.current?.focus()}>
      <h2 id="cr-run-title">Explorium credits exhausted</h2>
      <p id="cr-run-body">No run was started.</p>
      <form method="dialog"><button className="primary" autoFocus>Close</button></form>
    </dialog>
  </div>;
}

const sectionIds: Record<string, string> = {
  'Overview': 'overview', 'Pain points': 'pain-points', 'Facts': 'facts', 'Inferences': 'inferences',
  'Recommended offer': 'offer', 'Contact': 'contact', 'Draft for review': 'draft', 'Sources & open questions': 'sources',
};

function Detail({ company, content, headingRef }: { company: DisplayCompany; content: DisplayContent; headingRef: React.RefObject<HTMLHeadingElement | null> }) {
  const c = company, observed = c.painPoints.filter(p => p.status === 'observed').length;
  const sections: Record<string, React.ReactNode> = {
    'Overview': <><p>{c.summary}</p><p className="cr-meta">Services: {c.services.join(', ')} · Research: {c.researchStatus} · Contact: {c.contactStatus}</p></>,
    'Pain points': <ul className="cr-pains">{c.painPoints.map(p => <li key={p.id} className={`cr-pain ${p.status}`}>
      <span className={`cr-tag ${p.status}`}>{p.label}</span><strong>{p.title}</strong><p>{p.description}</p></li>)}</ul>,
    'Facts': <ul className="cr-list">{c.facts.map(f => <li key={f.id}>{f.text} <SourceLinks links={f.sources} /></li>)}</ul>,
    'Inferences': <ul className="cr-list">{c.inferences.map(i => <li key={i.id}>{i.text}</li>)}</ul>,
    'Recommended offer': <><p><strong>{c.offer.title}.</strong> {c.offer.description}</p><p><span className="cr-label">Deliverable</span> {c.offer.deliverable}</p><p><span className="cr-label">How to judge it</span> {c.offer.validation}</p></>,
    'Contact': <>
      <p className="cr-contact-name"><strong>{c.contact.name}</strong> — {c.contact.title}</p>
      <p>{c.contact.email ? <><span className="cr-label">Work email</span> <span className="cr-email">{c.contact.email}</span></> : <span className="cr-missing">No work email — recipient unresolved</span>}</p>
      <p className="cr-meta">{c.contact.emailStatusLabel}</p>
      <p>{c.contact.fit}</p>
      <p className="cr-meta">Role source: <SourceLinks links={c.contact.roleSources} />{c.contact.emailSources.length ? <> · Email source: <SourceLinks links={c.contact.emailSources} /></> : null}{c.contact.linkedin ? <> · <a href={c.contact.linkedin} target="_blank" rel="noreferrer">Professional profile ↗</a></> : null}</p>
    </>,
    'Draft for review': <div className="cr-draft">
      <p className="cr-meta">{c.draft.status} · {content.labels.sending}</p>
      <p><span className="cr-label">To</span> {c.draft.recipientEmail ?? <span className="cr-missing">No recipient — work email unresolved</span>}</p>
      <div className="cr-field"><span className="cr-label">Subject</span><p className="cr-subject">{c.draft.subject}</p><CopyButton label="Copy subject" text={c.draft.subject} /></div>
      <div className="cr-field"><span className="cr-label">Body</span><pre className="cr-body">{c.draft.body}</pre><CopyButton label="Copy body" text={c.draft.body} /></div>
      <CopyButton label="Copy subject and body" text={`Subject: ${c.draft.subject}\n\n${c.draft.body}`} />
    </div>,
    'Sources & open questions': <>
      <details><summary>Sources ({c.sources.length})</summary><ul className="cr-list">{c.sources.map(s => <li key={s.id}>
        {s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.title} ↗</a> : <strong>{s.title}</strong>}
        <span className="cr-meta"> — checked {s.checkedOn} · {s.basisLabel}. {s.note}</span></li>)}</ul></details>
      <details><summary>Open questions and limitations ({c.limitations.length})</summary><ul className="cr-list">{c.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul></details>
    </>,
  };
  return <section className="card cr-detail" aria-labelledby="cr-detail-title">
    <div className="card-heading"><div><p className="eyebrow">{c.domain}</p><h2 id="cr-detail-title" tabIndex={-1} ref={headingRef}>{c.name}</h2>
      <p className="muted">{observed} {content.labels.observed.toLowerCase()} · {c.painPoints.length - observed} {content.labels.potential.toLowerCase()}</p></div>
      <span className="badge">{content.labels.sending}</span></div>
    {content.sectionOrder.filter(name => name in sections).map(name => <div key={name} className="cr-section" id={`${c.id}-${sectionIds[name] ?? name}`}>
      <h3>{name === 'Draft for review' ? content.labels.draft : name}</h3>{sections[name]}</div>)}
  </section>;
}

export function CompanyResearch({ content }: { content: DisplayContent }) {
  const [selected, setSelected] = useState(content.companies[0].id);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const moved = useRef(false);
  useEffect(() => {
    const fromHash = window.location.hash.slice(1);
    if (content.companies.some(c => c.id === fromHash)) setSelected(fromHash);
  }, [content.companies]);
  function choose(id: string) {
    setSelected(id); moved.current = true;
    try { history.replaceState(null, '', `#${id}`); } catch { /* the selection still works without the hash */ }
  }
  useEffect(() => { if (moved.current) { headingRef.current?.focus(); moved.current = false; } }, [selected]);
  const company = content.companies.find(c => c.id === selected) ?? content.companies[0];
  const [companiesLabel, emailLabel, draftLabel] = content.labels.overview;

  return <>
    <header><p className="eyebrow">REVIEWED COMPANY RESEARCH</p>
      <div className="title-row"><div><h1>{content.title}</h1><p className="muted">{content.subtitle}</p></div>
        <div className="cr-actions"><RunWorkflow /><span className="badge">{content.labels.sending}</span></div></div>
      <p className="cr-meta">Research reviewed {content.reviewedOn} · content version {content.contentVersion}</p>
    </header>
    <section className="cr-intent" aria-label="Intent context">
      <p><span className="cr-label">Account-level intent topic</span> {content.intent.topic} — {content.intent.basis}. Signal date: {content.intent.signalDate ?? 'unknown'}. Originating unit: {content.intent.originatingUnit ?? 'unknown'}.</p>
      <p className="cr-meta">{content.intent.note}</p>
    </section>
    <section className="metrics cr-metrics" aria-label="Content counts">
      <div><span>{companiesLabel}</span><strong>{content.counts.companies}</strong></div>
      <div><span>{emailLabel}</span><strong>{content.counts.workEmails}</strong></div>
      <div><span>{draftLabel}</span><strong>{content.counts.drafts}</strong>{content.counts.draftsWithoutRecipient ? <small>{content.counts.draftsWithoutRecipient} without a recipient</small> : null}</div>
    </section>
    <p className="footnote">These counts describe the research shown here. They are not workflow results, conversion figures or automated checks.</p>
    <nav className="cr-cards" aria-label="Companies">
      {content.companies.map(c => {
        const observed = c.painPoints.filter(p => p.status === 'observed').length, active = c.id === company.id;
        return <button key={c.id} type="button" className={`cr-card${active ? ' active' : ''}`} aria-pressed={active} aria-controls="cr-detail" onClick={() => choose(c.id)}>
          <span className="cr-card-head"><strong>{c.name}</strong>{active ? <span className="cr-selected">Selected</span> : null}</span>
          <span className="cr-meta">{c.domain}</span>
          <span className="cr-card-summary">{c.summary}</span>
          <span className="cr-meta">{c.painPoints.length} pain points · {observed} {content.labels.observed.toLowerCase()} · {c.contactStatus}</span>
        </button>;
      })}
    </nav>
    <div id="cr-detail"><Detail company={company} content={content} headingRef={headingRef} /></div>
    <footer>Research supports a conversation. It does not establish buying intent, project timing or budget, and nothing here has been sent.</footer>
  </>;
}
