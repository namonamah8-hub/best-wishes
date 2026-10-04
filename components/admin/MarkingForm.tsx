'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function MarkingForm({ paperId, correct, wrong, total }: { paperId: string; correct: number; wrong: number; total: number }) {
  const router = useRouter();
  const [c, setC] = useState(String(correct));
  const [w, setW] = useState(String(wrong));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const cn = Number(c), wn = Number(w);
  const valid = Number.isFinite(cn) && cn > 0 && Number.isFinite(wn) && wn <= 0;

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/admin/papers/marking', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paperId, correct_marks: cn, wrong_marks: wn }) });
      const d = await r.json();
      if (!r.ok) { setMsg({ ok: false, text: d.message || 'Failed' }); return; }
      setMsg({ ok: true, text: `Saved. ${d.rescored} finished attempt(s) were re-scored.` });
      router.refresh();
    } catch { setMsg({ ok: false, text: 'Network problem.' }); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium">Marks for each correct answer<input className="input mt-1" type="number" step="0.25" min={0} value={c} onChange={(e) => setC(e.target.value)} /></label>
        <label className="text-sm font-medium">Marks for each wrong answer (0 or negative)<input className="input mt-1" type="number" step="0.25" max={0} value={w} onChange={(e) => setW(e.target.value)} /></label>
      </div>
      <p className="text-sm text-slate-600">
        {valid ? <>Scheme: <b>+{cn}</b> for each correct answer, <b>{wn}</b> for each wrong answer, 0 if unanswered. Maximum score: <b>{total * cn}</b>.</> : 'Enter a positive number for correct answers and 0 or a negative number for wrong answers.'}
      </p>
      {msg && <p role="alert" className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? 'bg-brand-50 text-brand-900' : 'bg-red-50 text-red-900'}`}>{msg.text}</p>}
      <button className="btn btn-primary" disabled={busy || !valid} onClick={save}>{busy ? 'Saving...' : 'Save marking scheme'}</button>
    </div>
  );
}
