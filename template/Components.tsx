// Design Guard — /components page. Dev-only: see README "The /components page".
//
// Reads every source file as raw text at build time (Vite's import.meta.glob) and runs
// the same scan the CLI runs, so what you see here is what the linter sees. Nothing to
// regenerate. This file is deliberately plain React + inline CSS: it must work in any
// Vite project and does not follow your design system, so keep it out of the lint path.
import { useMemo, useState } from 'react';
import { scanProject, summarize, type ComponentInfo, type ComponentStatus } from './scan-core.mjs';

// ---- configure ----
const COMPONENT_DIRS = ['src/components/ui']; // same as `components:` in design-guard.config
const EXCLUDE = ['src/design-guard']; // this page's own folder, left out of the stats
// -------------------

const raw = import.meta.glob('/src/**/*.{ts,tsx,jsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const files = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.replace(/^\//, ''), v]));

const BADGE: Record<ComponentStatus, { label: string; tone: string }> = {
  approved: { label: 'Approved', tone: 'ok' },
  'approved-unused': { label: 'Approved · unused', tone: 'muted' },
  'unmarked-in-use': { label: 'Not approved · in use', tone: 'warn' },
  'unmarked-unused': { label: 'Not approved · unused', tone: 'muted' },
};

const approvePrompt = (c: ComponentInfo) =>
  `Mark ${c.name} as approved: add "// @approved" as the first line of ${c.file}. Change nothing else.`;
const revokePrompt = (c: ComponentInfo) =>
  `Remove the "@approved" marker from ${c.file}. Change nothing else.` +
  (c.usageCount ? ` (${c.usageCount} file(s) import it and will be flagged afterwards.)` : '');
const command = (c: ComponentInfo) => `node scripts/ds-lint.mjs --${c.approved ? 'unapprove' : 'approve'} ${c.file}`;

export default function Components() {
  const components = useMemo(() => scanProject({ files, componentDirs: COMPONENT_DIRS }), []);
  const stats = useMemo(() => summarize(components, { files, componentDirs: COMPONENT_DIRS, exclude: EXCLUDE }), [components]);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied((cur) => (cur === id ? null : cur)), 1800);
    } catch {
      window.prompt('Copy this:', text);
    }
  };

  const waiting = components.filter((c) => c.status === 'unmarked-in-use').sort((a, b) => b.usageCount - a.usageCount);
  const approved = components.filter((c) => c.approved).sort((a, b) => b.usageCount - a.usageCount);
  const unused = components.filter((c) => c.status === 'unmarked-unused');

  const row = (c: ComponentInfo) => {
    const b = BADGE[c.status];
    const variantGroups = Object.entries(c.variants);
    return (
      <li key={c.key} className="dg-row">
        <div className="dg-main">
          <div className="dg-title">
            <strong>{c.name}</strong>
            <span className={`dg-badge dg-${b.tone}`}>{b.label}</span>
            {c.unstyledByDesign && <span className="dg-badge dg-muted">Unstyled by design</span>}
          </div>
          <code className="dg-path">{c.file}</code>
          {variantGroups.length > 0 && (
            <div className="dg-chips">
              {variantGroups.map(([group, vals]) => (
                <span key={group} className="dg-chipgroup">
                  <em>{group}</em> {vals.map((v) => <span key={v} className="dg-chip">{v}</span>)}
                </span>
              ))}
            </div>
          )}
          {c.props.length > 0 && (
            <details className="dg-details">
              <summary>{c.props.length} prop{c.props.length === 1 ? '' : 's'}</summary>
              <ul>
                {c.props.map((p) => (
                  <li key={p.name}><code>{p.name}{p.optional ? '?' : ''}: {p.type}</code></li>
                ))}
              </ul>
            </details>
          )}
          {c.usageCount > 0 && (
            <details className="dg-details">
              <summary>Used in {c.usageCount} file{c.usageCount === 1 ? '' : 's'}</summary>
              <ul>{c.usedBy.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
            </details>
          )}
        </div>
        <div className="dg-actions">
          <button
            className={c.approved ? 'dg-btn' : 'dg-btn dg-primary'}
            onClick={() => copy(c.key, c.approved ? revokePrompt(c) : approvePrompt(c))}
            title="Copies a prompt — paste it to your AI assistant"
          >
            {copied === c.key ? 'Prompt copied ✓' : c.approved ? 'Revoke approval' : 'Approve'}
          </button>
          <button className="dg-link" onClick={() => copy(c.key + ':cmd', command(c))} title={command(c)}>
            {copied === c.key + ':cmd' ? 'Command copied ✓' : 'Copy command'}
          </button>
        </div>
      </li>
    );
  };

  const section = (title: string, hint: string, list: ComponentInfo[], empty: string) => (
    <section className="dg-section">
      <h2>{title} <span className="dg-count">{list.length}</span></h2>
      <p className="dg-hint">{hint}</p>
      {list.length ? <ul className="dg-list">{list.map(row)}</ul> : <p className="dg-empty">{empty}</p>}
    </section>
  );

  const stat = (value: string | number, label: string, tone = '') => (
    <div className={`dg-stat ${tone}`}><div className="dg-num">{value}</div><div className="dg-lbl">{label}</div></div>
  );

  return (
    <main className="dg">
      <style>{CSS}</style>
      <header>
        <h1>Components</h1>
        <p className="dg-hint">
          Dev-only view of your design system, read live from source. Approving or revoking copies a prompt for
          your AI assistant — only a human decides what is approved.
        </p>
      </header>

      <div className="dg-stats">
        {stat(stats.approved, 'approved')}
        {stat(stats.decisionsWaiting, 'decisions waiting', stats.decisionsWaiting ? 'warn' : '')}
        {stat(stats.adoption === null ? '—' : `${stats.adoption}%`, 'usage through approved')}
        {stat(stats.rawElements, `raw elements in ${stats.rawElementFiles} file${stats.rawElementFiles === 1 ? '' : 's'}`, stats.rawElements ? 'warn' : '')}
        {stat(stats.unused, 'unmarked, unused')}
      </div>

      {components.length === 0 && (
        <p className="dg-empty">
          No components found in {COMPONENT_DIRS.join(', ')}. Check COMPONENT_DIRS at the top of this file.
        </p>
      )}

      {section('Decisions waiting', 'In use but not approved. Most-used first: approving or replacing these removes the most drift.', waiting, 'Nothing waiting. Every component in use is approved.')}
      {section('Approved', 'The current design system.', approved, 'Nothing approved yet — expected on a new project. Start with the most-used component above.')}
      {unused.length > 0 && (
        <details className="dg-section">
          <summary><h2 style={{ display: 'inline' }}>Not approved · unused <span className="dg-count">{unused.length}</span></h2></summary>
          <p className="dg-hint">Nothing imports these, so there is nothing to decide yet.</p>
          <ul className="dg-list">{unused.map(row)}</ul>
        </details>
      )}
    </main>
  );
}

const CSS = `
.dg{--bg:#fff;--fg:#14171f;--mut:#667085;--line:#e4e7ec;--card:#f9fafb;--ok:#067647;--okbg:#ecfdf3;--warn:#b54708;--warnbg:#fffaeb;--pri:#14171f;--prifg:#fff;
  max-width:1000px;margin:0 auto;padding:32px 20px 80px;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--fg);background:var(--bg)}
@media (prefers-color-scheme:dark){.dg{--bg:#0f1117;--fg:#eceff4;--mut:#9aa3b2;--line:#262b36;--card:#161a23;--ok:#6ce9a6;--okbg:#0b2a1b;--warn:#fec84b;--warnbg:#2b2108;--pri:#eceff4;--prifg:#0f1117}}
body:has(.dg){background:#fff}@media (prefers-color-scheme:dark){body:has(.dg){background:#0f1117}}
.dg h1{font-size:26px;margin:0 0 4px}.dg h2{font-size:16px;margin:0}.dg code{font:12px ui-monospace,Menlo,monospace}
.dg-hint{color:var(--mut);margin:4px 0 14px}.dg-empty{color:var(--mut);padding:14px;border:1px dashed var(--line);border-radius:10px}
.dg-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:20px 0 28px}
.dg-stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}.dg-stat.warn{background:var(--warnbg);border-color:transparent}
.dg-num{font-size:26px;font-weight:650;line-height:1.1}.dg-lbl{color:var(--mut);font-size:12px;margin-top:4px}
.dg-section{margin-bottom:30px}.dg-count{color:var(--mut);font-weight:400;margin-left:4px}
.dg-list{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.dg-row{display:flex;gap:16px;justify-content:space-between;align-items:flex-start;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.dg-main{min-width:0;display:grid;gap:6px}.dg-title{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dg-path{color:var(--mut);word-break:break-all}
.dg-badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--mut)}
.dg-badge.dg-ok{background:var(--okbg);color:var(--ok);border-color:transparent}.dg-badge.dg-warn{background:var(--warnbg);color:var(--warn);border-color:transparent}
.dg-chips{display:flex;flex-wrap:wrap;gap:6px 14px}.dg-chipgroup em{color:var(--mut);font-style:normal;font-size:12px;margin-right:4px}
.dg-chip{display:inline-block;font:11px ui-monospace,Menlo,monospace;padding:1px 7px;margin-right:4px;border:1px solid var(--line);border-radius:6px}
.dg-details summary{cursor:pointer;color:var(--mut);font-size:12px}.dg-details ul{margin:6px 0 0;padding-left:18px}
.dg-actions{display:grid;gap:4px;justify-items:end;flex:none}
.dg-btn{font:inherit;font-weight:600;padding:7px 12px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
.dg-btn.dg-primary{background:var(--pri);color:var(--prifg);border-color:var(--pri)}
.dg-link{font:inherit;font-size:12px;background:none;border:0;color:var(--mut);cursor:pointer;text-decoration:underline}
@media (max-width:640px){.dg-row{flex-direction:column}.dg-actions{justify-items:start}}
`;
