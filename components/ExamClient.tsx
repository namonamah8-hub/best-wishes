'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type Paper = { id: string; title: string; totalQuestions: number; sections: number; perSection: number; sectionMinutes: number };
type Q = { id: string; number: number; text: string; options: string[]; image: string | null; imageWhole: boolean };
type Sec = { number: number; state: 'locked' | 'current' | 'upcoming'; answered: number; total: number };
type State = {
  optionLabels?: string[]; section: number; sectionCount: number; sectionEndsAt: number; examEndsAt: number; serverNow: number;
  paperTitle: string; candidateName: string; questions: Q[]; answers: Record<string, number>; sections: Sec[];
};
const L = ['A', 'B', 'C', 'D'];
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

export default function ExamClient({ paper, candidateName, initialAttemptId, hasHindi = false }:
  { paper: Paper; candidateName: string; initialAttemptId: string | null; hasHindi?: boolean }) {
  const router = useRouter();
  const [attemptId, setAttemptId] = useState<string | null>(initialAttemptId);
  const [st, setSt] = useState<State | null>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [idx, setIdx] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [examRemaining, setExamRemaining] = useState(0);
  const [transitionFrom, setTransitionFrom] = useState<number | null>(null);
  const [submittedMsg, setSubmittedMsg] = useState(false);
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [agree, setAgree] = useState(false);
  const [lang, setLang] = useState<'en' | 'hi'>('en');
  const [busy, setBusy] = useState(false);
  const offset = useRef(0);          // serverNow - clientNow (only used to DISPLAY the countdown)
  const syncing = useRef(false);
  const lastSync = useRef(0);
  const curSection = useRef(0);

  const goResult = useCallback((url: string) => {
    setSubmittedMsg(true);
    setTimeout(() => router.push(url), 1500);
  }, [router]);

  /** Pull the authoritative state from the server. The server decides section + time left. */
  const sync = useCallback(async () => {
    if (!attemptId || syncing.current) return;
    syncing.current = true; lastSync.current = Date.now();
    try {
      const r = await fetch(`/api/attempts/${attemptId}`, { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) { setErr(d.message || 'Unable to load the exam.'); return; }
      if (d.finished) { goResult(d.resultUrl); return; }
      offset.current = d.serverNow - Date.now();
      if (curSection.current && d.section !== curSection.current) setIdx(0);
      curSection.current = d.section;
      setSt(d); setAnswers(d.answers); setErr('');
      // Pre-load this section's question images so moving between questions is instant (and survives a brief disconnect).
      (d.questions as Q[]).forEach((x) => { if (x.image) { const im = new Image(); im.src = x.image; } });
    } catch { setErr('Connection problem - your timer keeps running on the server. Reconnecting...'); }
    finally { syncing.current = false; }
  }, [attemptId, goResult]);

  useEffect(() => { if (attemptId) sync(); }, [attemptId, sync]);

  // Countdown (display only). When it hits zero, ask the server what happens next.
  useEffect(() => {
    if (!st) return;
    const tick = () => {
      const now = Date.now() + offset.current;
      const rem = Math.max(0, Math.ceil((st.sectionEndsAt - now) / 1000));
      setRemaining(rem);
      setExamRemaining(Math.max(0, Math.ceil((st.examEndsAt - now) / 1000)));
      if (rem <= 0) {
        setTransitionFrom((p) => p ?? st.section);
        if (Date.now() - lastSync.current > 700) sync();
      }
    };
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [st, sync]);

  // Hide the transition banner a moment after the new section has arrived.
  useEffect(() => {
    if (transitionFrom !== null && st && st.section !== transitionFrom) {
      const t = setTimeout(() => setTransitionFrom(null), 2500);
      return () => clearTimeout(t);
    }
  }, [st, transitionFrom]);

  // Re-sync periodically, when coming back online, and when the tab becomes visible.
  useEffect(() => {
    if (!attemptId) return;
    const i = setInterval(sync, 20000);
    const onVis = () => document.visibilityState === 'visible' && sync();
    window.addEventListener('online', sync);
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(i); window.removeEventListener('online', sync); document.removeEventListener('visibilitychange', onVis); };
  }, [attemptId, sync]);

  async function start() {
    setBusy(true); setErr('');
    try {
      const r = await fetch('/api/attempts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paperId: paper.id, lang }) });
      const d = await r.json();
      if (!r.ok) { setErr(d.message || 'Could not start the exam.'); return; }
      if (d.status && d.status !== 'IN_PROGRESS') { router.push(`/result/${d.attemptId}`); return; }
      setAttemptId(d.attemptId);
    } catch { setErr('Network problem. Please try again.'); } finally { setBusy(false); }
  }

  async function choose(q: Q, opt: number | null) {
    const prev = answers[q.id];
    const apply = (v: number | undefined) => setAnswers((a) => { const n = { ...a }; if (v === undefined) delete n[q.id]; else n[q.id] = v; return n; });
    apply(opt === null ? undefined : opt);
    try {
      const r = await fetch(`/api/attempts/${attemptId}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId: q.id, selectedOption: opt }) });
      if (r.ok) { setErr(''); return; }
      const d = await r.json().catch(() => ({}));
      apply(prev);
      if (r.status === 403) { setErr(d.message || 'This section is locked.'); sync(); }
      else setErr('Unable to save answer. Please try again.');
    } catch { apply(prev); setErr('Unable to save answer. Please try again.'); }
  }

  async function submit() {
    setBusy(true);
    try {
      const r = await fetch(`/api/attempts/${attemptId}/submit`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { setErr(d.message || 'Could not submit. Please try again.'); setConfirm(false); return; }
      setConfirm(false); goResult(d.resultUrl);
    } catch { setErr('Network problem. Please try again.'); setConfirm(false); } finally { setBusy(false); }
  }

  /* ---------------- start screen ---------------- */
  if (!attemptId) {
    return (
      <Shell>
        <div className="mx-auto max-w-2xl px-4 py-10">
          <div className="card p-7">
            <h1 className="font-serif text-3xl font-bold text-brand-900">{paper.title}</h1>
            <p className="mt-1 text-slate-600">Candidate: <b>{candidateName}</b></p>
            <dl className="mt-5 grid grid-cols-3 gap-3 text-center">
              <Info k="Questions" v={paper.totalQuestions} /><Info k="Sections" v={paper.sections} /><Info k="Minutes" v={paper.sections * paper.sectionMinutes} />
            </dl>
            <ul className="mt-5 divide-y divide-slate-100 rounded-lg border border-slate-200">
              {Array.from({ length: paper.sections }, (_, i) => (
                <li key={i} className="flex justify-between px-4 py-2.5 text-sm">
                  <span className="font-medium">Section {i + 1}: Questions {i * paper.perSection + 1}&ndash;{(i + 1) * paper.perSection}</span>
                  <span className="text-slate-600">{paper.sectionMinutes} minutes</span>
                </li>
              ))}
            </ul>
            <div className="mt-5 rounded-lg bg-saffron-100 p-4 text-sm leading-relaxed">
              <b>Important.</b> Once a section&apos;s time expires it is locked for good: you cannot view or change its answers.
              The next section opens by itself. Refreshing, closing the tab or losing internet does <b>not</b> pause the clock.
              Your attempt can be started only once.
            </div>
            {hasHindi && (
              <fieldset className="mt-5">
                <legend className="text-sm font-semibold">Question language / प्रश्नों की भाषा</legend>
                <div className="mt-2 grid grid-cols-2 gap-3">
                  {([['en', 'English'], ['hi', 'हिन्दी']] as const).map(([v, label]) => (
                    <label key={v} className={`flex cursor-pointer items-center gap-2 rounded-lg border-2 px-4 py-2.5 ${lang === v ? 'border-brand-600 bg-brand-50' : 'border-slate-200'}`}>
                      <input type="radio" name="lang" checked={lang === v} onChange={() => setLang(v)} /> <span className="font-medium">{label}</span>
                    </label>
                  ))}
                </div>
                <p className="mt-1 text-xs text-slate-500">You cannot change the language after you start. / शुरू करने के बाद भाषा बदली नहीं जा सकती।</p>
              </fieldset>
            )}
            <label className="mt-5 flex items-start gap-3 text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              I have read the instructions and I am ready to begin.
            </label>
            {err && <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{err}</p>}
            <button className="btn btn-primary mt-5 w-full" disabled={!agree || busy} onClick={start}>{busy ? 'Starting...' : 'Start Exam'}</button>
          </div>
        </div>
      </Shell>
    );
  }

  if (submittedMsg) {
    return <Shell><div className="grid min-h-screen place-items-center"><div className="card p-10 text-center"><h1 className="font-serif text-2xl font-bold text-brand-800">Exam submitted successfully.</h1><p className="mt-2 text-slate-600">Calculating your result...</p></div></div></Shell>;
  }

  if (!st) {
    return <Shell><div className="grid min-h-screen place-items-center text-slate-600">{err ? <p role="alert" className="text-red-700">{err}</p> : 'Loading your exam...'}</div></Shell>;
  }

  /* ---------------- exam screen ---------------- */
  const q = st.questions[Math.min(idx, st.questions.length - 1)];
  const labels = st.optionLabels ?? L;
  const whole = !!q.image && q.imageWhole; // screenshot IS the whole question -> show only A-D buttons
  const urgent = remaining <= 60;
  const lastSection = st.section === st.sectionCount;
  const answeredHere = st.questions.filter((x) => answers[x.id] !== undefined).length;

  return (
    <Shell>
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <p className="font-serif text-lg font-bold leading-tight text-brand-900">{st.paperTitle}</p>
            <p className="text-sm text-slate-600">Candidate: {st.candidateName}</p>
          </div>
          <p className="text-sm font-semibold">Section {st.section} / {st.sectionCount}</p>
          <div className={`rounded-lg px-4 py-1.5 text-center ${urgent ? 'bg-red-700 text-white' : 'bg-brand-50 text-brand-900'}`} aria-live="off">
            <p className="text-[11px] leading-none opacity-80">Time remaining</p>
            <p className="font-mono text-3xl font-bold leading-tight tabular-nums">{mmss(remaining)}</p>
          </div>
        </div>
        <div className="mx-auto flex max-w-6xl gap-2 px-4 pb-3">
          {st.sections.map((s) => (
            <div key={s.number} className={`flex-1 rounded-md border px-2 py-1 text-xs ${s.state === 'current' ? 'border-brand-600 bg-brand-50 font-semibold' : s.state === 'locked' ? 'border-slate-200 bg-slate-100 text-slate-500' : 'border-slate-200 text-slate-400'}`}>
              S{s.number} {s.state === 'locked' ? `locked (${s.answered}/${s.total})` : s.state === 'current' ? `open (${answeredHere}/${s.total})` : 'upcoming'}
            </div>
          ))}
        </div>
        {err && <p role="alert" className="bg-red-700 px-4 py-2 text-center text-sm text-white">{err}</p>}
      </header>

      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-6 lg:grid-cols-[1fr_280px]">
        <section className="card p-6">
          <p className="text-sm font-semibold text-slate-500">Question {q.number}</p>
          {!whole && <p className="mt-2 whitespace-pre-line text-lg leading-relaxed">{q.text}</p>}
          {q.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={q.id} src={q.image} alt={`Question ${q.number}`} className="mt-3 max-w-full rounded-lg border border-slate-200 bg-white" />
          )}
          <div className={whole ? 'mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4' : 'mt-5 space-y-3'} role="radiogroup" aria-label={`Options for question ${q.number}`}>
            {q.options.map((o, i) => {
              const on = answers[q.id] === i;
              return (
                <button key={i} role="radio" aria-checked={on} onClick={() => choose(q, i)}
                  className={`flex w-full items-center gap-3 rounded-xl border-2 px-4 py-3 text-left transition ${whole ? 'justify-center' : 'items-start'} ${on ? 'border-brand-600 bg-brand-50' : 'border-slate-200 bg-white hover:border-slate-400'}`}>
                  <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 text-xs font-bold ${on ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-400 text-slate-600'}`}>{labels[i]}</span>
                  {!whole && <span className="text-base">{o}</span>}
                </button>
              );
            })}
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-2">
              <button className="btn btn-ghost" disabled={idx === 0} onClick={() => setIdx(idx - 1)}>Previous</button>
              <button className="btn btn-primary" disabled={idx >= st.questions.length - 1} onClick={() => setIdx(idx + 1)}>Next</button>
            </div>
            <button className="text-sm text-slate-600 underline disabled:no-underline disabled:opacity-40" disabled={answers[q.id] === undefined} onClick={() => choose(q, null)}>Clear answer</button>
          </div>
        </section>

        <aside className="space-y-4">
          <div className="card p-4">
            <p className="mb-3 text-sm font-semibold">Section {st.section} questions</p>
            <div className="grid grid-cols-5 gap-2">
              {st.questions.map((x, i) => {
                const cur = i === idx, done = answers[x.id] !== undefined;
                return (
                  <button key={x.id} onClick={() => setIdx(i)} aria-label={`Question ${x.number}${done ? ', answered' : ''}`}
                    className={`h-10 rounded-md border text-sm font-semibold ${cur ? 'border-saffron-600 bg-saffron-500 text-white' : done ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}>
                    {x.number}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 space-y-1 text-xs text-slate-600">
              <p><span className="mr-2 inline-block h-3 w-3 rounded bg-brand-700 align-middle" />Answered ({answeredHere})</p>
              <p><span className="mr-2 inline-block h-3 w-3 rounded border border-slate-300 bg-white align-middle" />Unanswered ({st.questions.length - answeredHere})</p>
              <p><span className="mr-2 inline-block h-3 w-3 rounded bg-saffron-500 align-middle" />Current</p>
            </div>
          </div>
          <div className="card p-4 text-sm text-slate-600">
            <p>Total time left: <b className="font-mono text-ink">{mmss(examRemaining)}</b></p>
            {lastSection ? (
              <button className="btn btn-danger mt-3 w-full" onClick={() => setConfirm(true)}>Submit Exam</button>
            ) : (
              <p className="mt-2 text-xs">The next section opens automatically when this one ends.</p>
            )}
          </div>
        </aside>
      </div>

      {transitionFrom !== null && (
        <div className="fixed inset-0 z-30 grid place-items-center bg-ink/80 p-4" role="alertdialog" aria-live="assertive">
          <div className="card max-w-md p-8 text-center">
            {transitionFrom >= st.sectionCount ? (
              <><h2 className="font-serif text-2xl font-bold">Exam submitted successfully.</h2><p className="mt-2 text-slate-600">Time is up. Opening your result...</p></>
            ) : (
              <><h2 className="font-serif text-2xl font-bold">Section {transitionFrom} completed.</h2>
                <p className="mt-2 text-slate-600">You can no longer modify answers in this section.</p>
                <p className="mt-1 font-semibold text-brand-800">Moving to Section {transitionFrom + 1}...</p></>
            )}
          </div>
        </div>
      )}

      {confirm && (
        <div className="fixed inset-0 z-30 grid place-items-center bg-ink/70 p-4" role="dialog" aria-modal="true">
          <div className="card w-full max-w-md p-6">
            <h2 className="font-serif text-xl font-bold">Submit the exam now?</h2>
            <p className="mt-2 text-sm text-slate-600">This finishes the whole exam immediately. You will not be able to change any answer afterwards.</p>
            <div className="mt-5 flex justify-end gap-2">
              <button className="btn btn-ghost" onClick={() => setConfirm(false)} disabled={busy}>Keep going</button>
              <button className="btn btn-danger" onClick={submit} disabled={busy}>{busy ? 'Submitting...' : 'Yes, submit'}</button>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}

// Full-screen layer so the exam is distraction-free.
function Shell({ children }: { children: React.ReactNode }) {
  return <div className="fixed inset-0 z-20 overflow-y-auto bg-[#f7f6f1]">{children}</div>;
}
function Info({ k, v }: { k: string; v: number }) {
  return <div className="rounded-lg bg-slate-50 py-3"><dt className="text-xs text-slate-500">{k}</dt><dd className="font-serif text-2xl font-bold">{v}</dd></div>;
}
