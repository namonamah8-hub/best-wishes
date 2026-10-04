import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { getCandidate } from '@/lib/auth';
import { loadOwned, syncAttempt, buildResultRows } from '@/lib/attempts';
import { HttpError, UUID_RE } from '@/lib/http';
import { LETTERS } from '@/lib/config';

export const dynamic = 'force-dynamic';

export default async function ResultPage({ params }: { params: { attemptId: string } }) {
  const cand = await getCandidate();
  if (!cand) redirect('/');
  if (!UUID_RE.test(params.attemptId)) notFound();
  let loaded;
  try { loaded = await loadOwned(params.attemptId, cand.id); }
  catch (e) { if (e instanceof HttpError) notFound(); throw e; }

  const a = await syncAttempt(loaded.attempt, loaded.paper);
  if (a.status === 'IN_PROGRESS') redirect(`/exam/${a.paper_id}`); // correct answers are never shown before submission
  const rows = await buildResultRows(a, loaded.paper);
  const wrong = rows.filter((r) => r.status === 'WRONG');
  const skipped = rows.filter((r) => r.status === 'UNANSWERED').map((r) => r.number);
  const labels = loaded.paper.option_style === 'numbers' ? ['1', '2', '3', '4'] : LETTERS;
  const total = loaded.paper.total_questions * Number(loaded.paper.correct_marks);
  const stats: { section: number; correct: number; wrong: number; unanswered: number }[] = a.section_stats ?? [];

  return (
    <div className="space-y-8">
      <div className="card p-6">
        <p className="text-sm text-slate-500">{loaded.paper.title}</p>
        <h1 className="font-serif text-3xl font-bold text-brand-900">
          {a.status === 'AUTO_SUBMITTED' ? 'Time up - exam submitted' : 'Exam completed'}
        </h1>
        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Score" value={`${Number(a.score)} / ${total}`} big />
          <Stat label="Correct" value={a.correct_count} tone="text-brand-700" />
          <Stat label="Wrong" value={a.wrong_count} tone="text-red-700" />
          <Stat label="Unanswered" value={a.unanswered_count} tone="text-slate-500" />
        </div>
        {Number(loaded.paper.wrong_marks) !== 0 && (
          <p className="mt-3 text-xs text-slate-500">Marking: +{Number(loaded.paper.correct_marks)} correct, {Number(loaded.paper.wrong_marks)} wrong, 0 unanswered.</p>
        )}
      </div>

      <section>
        <h2 className="font-serif text-xl font-bold">Section-wise</h2>
        <div className="card mt-3 overflow-x-auto">
          <table className="w-full min-w-[420px]">
            <thead className="border-b bg-slate-50"><tr><th className="th">Section</th><th className="th">Correct</th><th className="th">Wrong</th><th className="th">Unanswered</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {stats.map((s) => (
                <tr key={s.section}><td className="td font-medium">Section {s.section}</td><td className="td text-brand-700">{s.correct}</td><td className="td text-red-700">{s.wrong}</td><td className="td text-slate-500">{s.unanswered}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="font-serif text-xl font-bold">Wrong answers ({wrong.length})</h2>
        {wrong.length === 0 ? <p className="card mt-3 p-5 text-slate-600">No wrong answers. Well done.</p> : (
          <div className="mt-3 space-y-3">
            {wrong.map((r) => (
              <div key={r.number} className="card p-5">
                <p className="text-sm font-semibold text-slate-500">Question {r.number} &middot; Section {r.section}</p>
                {!r.imageWhole && <p className="mt-1 whitespace-pre-line font-medium">{r.text}</p>}
                {r.image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/attempts/${a.id}/image/${r.id}`} alt={`Question ${r.number}`} loading="lazy" className="mt-2 max-w-full rounded-lg border border-slate-200" />
                )}
                <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                  <p className="rounded-lg bg-red-50 px-3 py-2 text-red-900"><b>Your answer: {labels[r.yourOption!]}</b>{!r.imageWhole && <> &mdash; {r.options[r.yourOption!]}</>}</p>
                  <p className="rounded-lg bg-brand-50 px-3 py-2 text-brand-900"><b>Correct answer: {labels[r.correctOption]}</b>{!r.imageWhole && <> &mdash; {r.options[r.correctOption]}</>}</p>
                </div>
              </div>
            ))}
          </div>
        )}
        {skipped.length > 0 && <p className="mt-4 text-sm text-slate-600">Unanswered: Q{skipped.join(', Q')}</p>}
      </section>

      <div className="flex gap-3">
        <Link href="/" className="btn btn-primary">Back to today&apos;s tests</Link>
        <Link href={`/leaderboard?paper=${a.paper_id}`} className="btn btn-ghost">See the results board</Link>
      </div>
    </div>
  );
}

function Stat({ label, value, tone = '', big = false }: { label: string; value: string | number; tone?: string; big?: boolean }) {
  return (
    <div className="rounded-lg bg-slate-50 p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1 font-serif font-bold ${big ? 'text-3xl' : 'text-3xl'} ${tone}`}>{value}</p>
    </div>
  );
}
