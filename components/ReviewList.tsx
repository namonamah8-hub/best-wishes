'use client';
import { useState } from 'react';
import type { ResultRow } from '@/lib/attempts';

type Filter = 'ALL' | 'CORRECT' | 'WRONG' | 'UNANSWERED';
type Status = ResultRow['status'];

const LOOK: Record<Status, { dot: string; side: string; badge: string; label: string }> = {
  CORRECT: { dot: 'border-brand-700 bg-brand-700 text-white', side: 'border-l-brand-600', badge: 'bg-brand-50 text-brand-800', label: 'Correct' },
  WRONG: { dot: 'border-red-700 bg-red-700 text-white', side: 'border-l-red-600', badge: 'bg-red-50 text-red-800', label: 'Wrong' },
  UNANSWERED: { dot: 'border-slate-300 bg-slate-100 text-slate-600', side: 'border-l-slate-300', badge: 'bg-slate-100 text-slate-700', label: 'Skipped' },
};

/** The candidate's own paper after submission: every question, their answer, the correct answer, and the result. */
export default function ReviewList({ rows, attemptId, labels, correctMarks, wrongMarks }:
  { rows: ResultRow[]; attemptId: string; labels: string[]; correctMarks: number; wrongMarks: number }) {
  const [filter, setFilter] = useState<Filter>('ALL');
  const count = (s: Status) => rows.filter((r) => r.status === s).length;
  const visible = filter === 'ALL' ? rows : rows.filter((r) => r.status === filter);
  const marks = (r: ResultRow) => (r.status === 'CORRECT' ? `+${correctMarks}` : r.status === 'WRONG' ? `${wrongMarks}` : '0');

  function jump(n: number) {
    setFilter('ALL');
    setTimeout(() => document.getElementById(`q${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  }

  const tabs: [Filter, string, number][] = [
    ['ALL', 'All questions', rows.length], ['WRONG', 'Wrong', count('WRONG')],
    ['CORRECT', 'Correct', count('CORRECT')], ['UNANSWERED', 'Skipped', count('UNANSWERED')],
  ];
  let lastSection = 0;

  return (
    <section id="review" className="space-y-5">
      <div>
        <h2 className="font-serif text-2xl font-bold text-brand-900">Review your paper</h2>
        <p className="mt-1 text-sm text-slate-600">Every question with your answer and the correct answer. Tap a number to jump to it.</p>
      </div>

      <div className="card p-4">
        <div className="flex flex-wrap gap-1.5">
          {rows.map((r) => (
            <button key={r.id} onClick={() => jump(r.number)} aria-label={`Question ${r.number}: ${LOOK[r.status].label}`}
              className={`h-8 min-w-8 rounded border px-1 text-xs font-semibold ${LOOK[r.status].dot}`}>{r.number}</button>
          ))}
        </div>
        <p className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-600">
          <span><span className="mr-1.5 inline-block h-3 w-3 rounded bg-brand-700 align-middle" />Correct ({count('CORRECT')})</span>
          <span><span className="mr-1.5 inline-block h-3 w-3 rounded bg-red-700 align-middle" />Wrong ({count('WRONG')})</span>
          <span><span className="mr-1.5 inline-block h-3 w-3 rounded border border-slate-300 bg-slate-100 align-middle" />Skipped ({count('UNANSWERED')})</span>
        </p>
      </div>

      <div className="flex flex-wrap gap-2" role="tablist">
        {tabs.map(([f, label, n]) => (
          <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}
            className={`btn !py-1.5 text-sm ${filter === f ? 'btn-primary' : 'btn-ghost'}`}>{label} ({n})</button>
        ))}
      </div>

      {visible.length === 0 && <p className="card p-5 text-slate-600">Nothing to show here.</p>}

      <div className="space-y-4">
        {visible.map((r) => {
          const look = LOOK[r.status];
          const head = r.section !== lastSection;
          lastSection = r.section;
          return (
            <div key={r.id}>
              {head && <h3 className="mb-3 mt-4 font-serif text-lg font-bold text-slate-700">Section {r.section}</h3>}
              <article id={`q${r.number}`} className={`card scroll-mt-4 border-l-4 p-5 ${look.side}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-500">Question {r.number}</p>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${look.badge}`}>{look.label}</span>
                    <span className="text-xs font-semibold text-slate-600">{marks(r)} marks</span>
                  </div>
                </div>

                {!r.imageWhole && r.text && <p className="mt-2 whitespace-pre-line font-medium">{r.text}</p>}
                {r.image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/attempts/${attemptId}/image/${r.id}`} alt={`Question ${r.number}`} loading="lazy"
                    className="mt-3 max-w-full rounded-lg border border-slate-200 bg-white" />
                )}

                {!r.imageWhole && (
                  <ul className="mt-3 space-y-2">
                    {r.options.map((o, i) => {
                      const isRight = i === r.correctOption, isYours = i === r.yourOption;
                      return (
                        <li key={i} className={`flex items-start gap-3 rounded-lg border-2 px-3 py-2 text-sm ${isRight ? 'border-brand-600 bg-brand-50' : isYours ? 'border-red-500 bg-red-50' : 'border-slate-200'}`}>
                          <span className="font-bold">{labels[i]}</span>
                          <span className="flex-1">{o}</span>
                          {isRight && <span className="shrink-0 text-xs font-semibold text-brand-800">Correct answer{isYours ? ' (yours)' : ''}</span>}
                          {isYours && !isRight && <span className="shrink-0 text-xs font-semibold text-red-800">Your answer</span>}
                        </li>
                      );
                    })}
                  </ul>
                )}

                <p className={`mt-3 rounded-lg px-3 py-2 text-sm ${look.badge}`}>
                  {r.status === 'CORRECT' && <>You answered <b>{labels[r.yourOption!]}</b> - correct.</>}
                  {r.status === 'WRONG' && <>You answered <b>{labels[r.yourOption!]}</b>. The correct answer is <b>{labels[r.correctOption]}</b>.</>}
                  {r.status === 'UNANSWERED' && <>You skipped this question. The correct answer is <b>{labels[r.correctOption]}</b>.</>}
                </p>
              </article>
            </div>
          );
        })}
      </div>
    </section>
  );
}
