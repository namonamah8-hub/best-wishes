'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { validateQuestions, normCorrect, type DraftQ } from '@/lib/validate';
import { textFlags, type Flag } from '@/lib/flags';
import ImageAttach from './ImageAttach';
import { prepareImage } from '@/lib/clientImage';

type DQ = DraftQ & { flags?: Flag[]; page?: number; crop?: string; section?: string };
type Draft = { option_style: 'letters' | 'numbers'; title: string; description: string; source_filename: string; correct_marks: number; wrong_marks: number; section_seconds: number; questions: DQ[] };
type Img = { blob: Blob; url: string; whole: boolean };
/** Text or an option is missing: the question is (partly) a picture, so only a WHOLE-question screenshot can carry it. */
const isIncomplete = (q: { question_text?: string; options?: string[] }) =>
  !(q.question_text ?? '').trim() || [0, 1, 2, 3].some((i) => !(q.options?.[i] ?? '').trim());

export default function ImportPanel() {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [parseReport, setParseReport] = useState<{ errors: string[]; warnings: string[] } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; details?: string[]; link?: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [images, setImages] = useState<Record<number, Img>>({});
  const [okText, setOkText] = useState<Set<number>>(new Set());

  const L = draft?.option_style === 'numbers' ? ['1', '2', '3', '4'] : ['A', 'B', 'C', 'D'];
  const problems = useMemo(
    () => (draft ? validateQuestions(draft.questions.map((q) => ({ ...q, needs_image: isIncomplete(q) }))) : []),
    [draft]);
  const badNumbers = useMemo(() => new Set(problems.map((p) => Number(p.match(/Question (\d+)/)?.[1])).filter(Boolean)), [problems]);

  // Merge flags from the offline checker (layout-aware) with text clues.
  const flags = useMemo(() => {
    const m = new Map<number, Flag[]>();
    draft?.questions.forEach((q) => {
      const all = [...(q.flags ?? []), ...textFlags({ question_text: q.question_text ?? '', options: q.options ?? [] })];
      const seen = new Set<string>();
      const uniq = all.filter((f) => (seen.has(f.reason) ? false : (seen.add(f.reason), true)));
      if (uniq.length) m.set(q.question_number, uniq);
    });
    return m;
  }, [draft]);
  const incompleteOf = (n: number) => { const q = draft?.questions.find((x) => x.question_number === n); return !!q && isIncomplete(q); };
  const needsImage = (n: number) => !!flags.get(n)?.some((f) => f.level === 'image') || incompleteOf(n);
  // resolved = a screenshot is attached (a WHOLE one if text is missing) or the admin confirmed the complete text is fine
  const isResolved = (n: number) => { const i = images[n]; return incompleteOf(n) ? !!i?.whole : !!i || okText.has(n); };
  const unresolved = useMemo(() => (draft?.questions ?? []).map((q) => q.question_number).filter((n) => needsImage(n) && !isResolved(n)).sort((a, b) => a - b), [draft, flags, images, okText]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => Object.values(images).forEach((i) => URL.revokeObjectURL(i.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  function reset(d: Draft | null) { setDraft(d); setImages({}); setOkText(new Set()); setOpen(null); }

  async function onFile(f: File | undefined) {
    if (!f) return;
    setMsg(null); setParseReport(null); setBusy('Reading file...');
    try {
      if (/\.json$/i.test(f.name)) {
        const j = JSON.parse(await f.text());
        reset({ option_style: j.option_style === 'numbers' ? 'numbers' : 'letters', title: j.title ?? '', description: j.description ?? '', source_filename: j.source_filename ?? f.name, correct_marks: j.correct_marks ?? 2, wrong_marks: j.wrong_marks ?? -0.5, section_seconds: j.section_seconds ?? 900, questions: j.questions ?? [] });
        if (Array.isArray(j.report?.errors)) setParseReport({ errors: j.report.errors, warnings: j.report.warnings ?? [] });
      } else {
        const fd = new FormData(); fd.append('file', f);
        const r = await fetch('/api/admin/parse', { method: 'POST', body: fd });
        const d = await r.json();
        if (!r.ok) { setMsg({ ok: false, text: d.message || 'Could not read the file.' }); return; }
        reset({ option_style: 'letters', title: d.title || f.name.replace(/\.\w+$/, ''), description: '', source_filename: d.source_filename, correct_marks: 2, wrong_marks: -0.5, section_seconds: 900, questions: d.questions });
        setParseReport({ errors: d.errors, warnings: d.warnings });
      }
    } catch (e) { setMsg({ ok: false, text: 'Could not read that file. ' + (e instanceof Error ? e.message : '') }); }
    finally { setBusy(''); }
  }

  function edit(i: number, patch: Partial<DQ>) {
    setDraft((d) => d && { ...d, questions: d.questions.map((q, k) => (k === i ? { ...q, ...patch } : q)) });
  }
  function setImage(n: number, blob: Blob) {
    setImages((p) => { if (p[n]) URL.revokeObjectURL(p[n].url); return { ...p, [n]: { blob, url: URL.createObjectURL(blob), whole: p[n]?.whole ?? true } }; });
  }
  async function onBulk(files: FileList | null) {
    if (!files || !draft) return;
    let matched = 0; const skipped: string[] = [];
    for (const f of Array.from(files)) {
      const n = Number(f.name.match(/q0*(\d{1,3})/i)?.[1]);
      if (!n || !draft.questions.some((q) => q.question_number === n)) { skipped.push(f.name); continue; }
      try { setImage(n, await prepareImage(f)); matched++; } catch { skipped.push(f.name); }
    }
    setMsg({ ok: skipped.length === 0, text: `Attached ${matched} screenshot(s) by file name (q051.png goes to Q51).${skipped.length ? ` Skipped: ${skipped.slice(0, 5).join(', ')}` : ''}` });
  }
  function dropImage(n: number) {
    setImages((p) => { const c = { ...p }; if (c[n]) URL.revokeObjectURL(c[n].url); delete c[n]; return c; });
  }

  async function doImport() {
    if (!draft) return;
    setMsg(null); setBusy('Importing paper...');
    try {
      const r = await fetch('/api/admin/papers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...draft, questions: draft.questions.map(({ flags: _f, page: _p, crop: _c, section: _s, ...q }) => ({ ...q, needs_image: isIncomplete(q) })) }) });
      const d = await r.json();
      if (!r.ok) { setMsg({ ok: false, text: d.message || 'Import failed.', details: d.details }); return; }
      const entries = Object.entries(images).map(([n, i]) => [Number(n), i] as const);
      const failed: number[] = [];
      for (let k = 0; k < entries.length; k++) {
        setBusy(`Uploading screenshots ${k + 1}/${entries.length}...`);
        const fd = new FormData();
        fd.append('paperId', d.id); fd.append('questionNumber', String(entries[k][0])); fd.append('whole', String(entries[k][1].whole));
        fd.append('file', entries[k][1].blob, 'q.png');
        try { const u = await fetch('/api/admin/questions/image', { method: 'POST', body: fd }); if (!u.ok) failed.push(entries[k][0]); } catch { failed.push(entries[k][0]); }
      }
      setMsg(failed.length
        ? { ok: false, text: `Paper imported (Questions: ${d.questions}) but ${failed.length} screenshot(s) failed: Q${failed.join(', Q')}. Attach them again on the paper page.`, link: `/admin/papers/${d.id}` }
        : { ok: true, text: `Paper imported successfully. Questions: ${d.questions}  Sections: ${d.sections}  Screenshots attached: ${entries.length}`, link: `/admin/papers/${d.id}` });
      reset(null); setParseReport(null); router.refresh();
    } catch { setMsg({ ok: false, text: 'Network problem.' }); } finally { setBusy(''); }
  }

  const chip = (n: number) => {
    if (badNumbers.has(n)) return 'border-red-600 bg-red-50 text-red-800';
    if (images[n]) return 'border-sky-600 bg-sky-50 text-sky-800';
    if (needsImage(n) && !isResolved(n)) return 'border-saffron-600 bg-saffron-100 text-ink';
    if (flags.has(n)) return 'border-slate-400 bg-slate-100 text-slate-700';
    return 'border-slate-300 bg-white text-slate-600';
  };

  return (
    <section className="card space-y-5 p-6">
      <div>
        <h2 className="font-serif text-xl font-bold">Import a paper</h2>
        <p className="mt-1 text-sm text-slate-600">
          Best: run <code className="rounded bg-slate-100 px-1">python scripts/pdf_to_paper.py your.pdf</code> on your computer - it reads the real PDF layout and lists
          exactly which questions have tables, equations or pictures - then upload the <b>.json</b> it creates. You can also upload a text-based <b>PDF</b> (up to 4 MB) directly,
          but then only text clues can flag questions.
        </p>
        <input type="file" accept=".pdf,.txt,.json" className="mt-3 block text-sm" onChange={(e) => onFile(e.target.files?.[0])} disabled={!!busy} />
        {busy && <p className="mt-2 text-sm text-slate-600">{busy}</p>}
      </div>

      {msg && (
        <div role="alert" className={`rounded-lg px-4 py-3 text-sm ${msg.ok ? 'bg-brand-50 text-brand-900' : 'bg-red-50 text-red-900'}`}>
          <p className="font-semibold">{msg.text}</p>
          {msg.details && <ul className="mt-1 list-disc pl-5">{msg.details.slice(0, 15).map((x, i) => <li key={i}>{x}</li>)}</ul>}
          {msg.link && <Link href={msg.link} className="mt-1 inline-block font-semibold underline">Open the paper</Link>}
        </div>
      )}

      {draft && (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm font-medium">Paper title *<input className="input mt-1" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
            <label className="text-sm font-medium">Description<input className="input mt-1" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
            <label className="text-sm font-medium">Marks per correct answer<input className="input mt-1" type="number" step="0.25" value={draft.correct_marks} onChange={(e) => setDraft({ ...draft, correct_marks: Number(e.target.value) })} /></label>
            <label className="text-sm font-medium">Marks per wrong answer (0 or negative, e.g. -0.5)<input className="input mt-1" type="number" step="0.25" max={0} value={draft.wrong_marks} onChange={(e) => setDraft({ ...draft, wrong_marks: Number(e.target.value) })} /></label>
            <label className="text-sm font-medium">Seconds per section (900 = 15 min; use 20 only for timer testing)<input className="input mt-1" type="number" min={10} max={3600} value={draft.section_seconds} onChange={(e) => setDraft({ ...draft, section_seconds: Number(e.target.value) })} /></label>
          </div>

          {parseReport && (parseReport.errors.length > 0 || parseReport.warnings.length > 0) && (
            <details open className="rounded-lg border border-saffron-500/50 bg-saffron-100 p-3 text-sm">
              <summary className="cursor-pointer font-semibold">Parser report: {parseReport.errors.length} problem(s), {parseReport.warnings.length} warning(s)</summary>
              <ul className="mt-2 list-disc space-y-0.5 pl-5">{[...parseReport.errors, ...parseReport.warnings].slice(0, 40).map((x, i) => <li key={i}>{x}</li>)}</ul>
            </details>
          )}

          <label className="block rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3 text-sm font-medium">
            Attach all the checker&apos;s crops at once - select the files from the <code>images</code> folder (file q051.png goes to Q51)
            <input type="file" multiple accept="image/png,image/jpeg,image/webp" className="mt-1 block text-sm font-normal" onChange={(e) => { onBulk(e.target.files); e.target.value = ''; }} />
          </label>

          <div className={`rounded-lg px-4 py-3 text-sm ${problems.length ? 'bg-red-50 text-red-900' : 'bg-brand-50 text-brand-900'}`}>
            {problems.length === 0
              ? <b>Text check passed: {draft.questions.length} questions, 4 sections x 25, all options and answers present.</b>
              : <><b>{problems.length} issue(s) to fix before import:</b><ul className="mt-1 list-disc pl-5">{problems.slice(0, 10).map((x, i) => <li key={i}>{x}</li>)}</ul>{problems.length > 10 && <p>...and {problems.length - 10} more. Click a red question number below to fix it.</p>}</>}
          </div>

          {flags.size > 0 && (
            <div className="rounded-lg border border-saffron-500/60 bg-saffron-100 p-4 text-sm">
              <p className="font-semibold">
                {[...flags.keys()].filter(needsImage).length} question(s) probably contain a table, equation or picture that text cannot capture
                {unresolved.length > 0 ? ` - ${unresolved.length} still to resolve` : ' - all resolved'}
              </p>
              <p className="mt-1 text-slate-700">For each one: open it in the PDF, take a screenshot, paste it below - or tick &quot;text is fine&quot; if the text really is complete.</p>
              <ul className="mt-2 space-y-0.5">
                {[...flags.entries()].sort((a, b) => a[0] - b[0]).map(([n, fl]) => {
                  const q = draft.questions.find((x) => x.question_number === n);
                  const state = !needsImage(n) ? 'check' : isResolved(n) ? (images[n] ? 'screenshot attached' : 'text confirmed fine') : 'TO DO';
                  return (
                    <li key={n}>
                      <button className="font-semibold text-brand-800 underline" onClick={() => setOpen(draft.questions.findIndex((x) => x.question_number === n))}>Q{n}</button>
                      {q?.page ? ` (PDF page ${q.page})` : ''}: {fl.map((f) => f.reason).join('; ')} <span className="font-semibold">[{state}]</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            {draft.questions.map((q, i) => (
              <button key={i} onClick={() => setOpen(open === i ? null : i)} className={`h-8 min-w-8 rounded border px-1.5 text-xs font-semibold ${chip(q.question_number)} ${open === i ? 'ring-2 ring-brand-600' : ''}`}>
                {q.question_number}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500">
            <span className="mr-1 inline-block h-3 w-3 rounded border border-red-600 bg-red-50 align-middle" />needs a text fix &nbsp;
            <span className="mr-1 inline-block h-3 w-3 rounded border border-saffron-600 bg-saffron-100 align-middle" />needs a screenshot &nbsp;
            <span className="mr-1 inline-block h-3 w-3 rounded border border-sky-600 bg-sky-50 align-middle" />screenshot attached &nbsp;
            <span className="mr-1 inline-block h-3 w-3 rounded border border-slate-400 bg-slate-100 align-middle" />checked
          </p>

          {open !== null && draft.questions[open] && (() => {
            const q = draft.questions[open]; const n = q.question_number; const fl = flags.get(n) ?? []; const img = images[n]; const inc = isIncomplete(q);
            return (
              <div className="space-y-3 rounded-lg border border-slate-200 p-4">
                <p className="text-sm font-semibold">Question {n}{q.page ? ` - PDF page ${q.page}` : ''}</p>
                {inc && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-900">The text or an option is missing here (probably pictures). Attach a <b>whole-question</b> screenshot that includes the options {L[0]}-{L[3]}, or type the missing text above.</p>}
                {fl.length > 0 && <ul className="rounded bg-saffron-100 px-3 py-2 text-sm">{fl.map((f, i) => <li key={i}>{f.level === 'image' ? 'Needs screenshot' : 'Check'}: {f.reason}</li>)}</ul>}
                {q.crop && <p className="text-xs text-slate-600">The checker saved a ready-made crop of this question: <code>{q.crop}</code> in your output folder - you can paste/upload that.</p>}
                <textarea className="input min-h-20" value={q.question_text} onChange={(e) => edit(open, { question_text: e.target.value })} />
                {L.map((l, k) => (
                  <label key={l} className="flex items-center gap-2 text-sm"><span className="w-5 font-bold">{l}</span>
                    <input className="input" value={q.options[k] ?? ''} onChange={(e) => edit(open, { options: [0, 1, 2, 3].map((z) => (z === k ? e.target.value : q.options[z] ?? '')) })} /></label>
                ))}
                <label className="flex items-center gap-2 text-sm font-medium">Correct answer
                  <select className="input !w-auto" value={normCorrect(q.correct_option) ?? ''} onChange={(e) => edit(open, { correct_option: e.target.value === '' ? null : Number(e.target.value) })}>
                    <option value="">- choose -</option>{L.map((l, k) => <option key={l} value={k}>{l}</option>)}
                  </select></label>

                <div className="space-y-2 border-t border-slate-200 pt-3">
                  <p className="text-sm font-semibold">Screenshot (table / equation / picture)</p>
                  {img ? (
                    <div className="space-y-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.url} alt={`Screenshot for Q${n}`} className="max-h-72 max-w-full rounded border border-slate-300" />
                      <div className="space-y-1 text-sm">
                        <label className="flex items-start gap-2"><input type="radio" className="mt-1" checked={img.whole} onChange={() => setImages((p) => ({ ...p, [n]: { ...p[n], whole: true } }))} />
                          <span><b>Whole question</b> - my screenshot includes the question <u>and</u> the options (a)-(d). Candidates see the screenshot + A/B/C/D buttons only. <i>Recommended.</i></span></label>
                        <label className="flex items-start gap-2"><input type="radio" className="mt-1" disabled={inc} checked={!img.whole} onChange={() => setImages((p) => ({ ...p, [n]: { ...p[n], whole: false } }))} />
                          <span><b>Only the table/figure</b> - show the question text and option text above/below it as usual.</span></label>
                      </div>
                      <button className="text-sm font-medium text-red-700 hover:underline" onClick={() => dropImage(n)}>Remove screenshot</button>
                    </div>
                  ) : (
                    <>
                      <ImageAttach onImage={(b) => setImage(n, b)} />
                      {!inc && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={okText.has(n)} onChange={(e) => setOkText((s) => { const c = new Set(s); if (e.target.checked) c.add(n); else c.delete(n); return c; })} />
                        I checked the PDF: the text above is complete and correct - no screenshot needed.</label>}
                    </>
                  )}
                </div>
              </div>
            );
          })()}

          {unresolved.length > 0 && <p className="text-sm font-medium text-red-800">Import is locked until these are resolved: Q{unresolved.join(', Q')}</p>}
          <button className="btn btn-primary" disabled={!!busy || problems.length > 0 || unresolved.length > 0 || !draft.title.trim()} onClick={doImport}>{busy || 'Import paper'}</button>
        </div>
      )}
    </section>
  );
}
