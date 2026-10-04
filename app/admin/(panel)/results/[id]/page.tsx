import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/supabase';
import { syncAttempt, buildResultRows, type Paper } from '@/lib/attempts';
import { UUID_RE } from '@/lib/http';
import { fmtDateTime, LETTERS } from '@/lib/config';

export const dynamic = 'force-dynamic';

export default async function ResultDetail({ params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) notFound();
  const { data: a0 } = await db().from('attempts').select('*').eq('id', params.id).maybeSingle();
  if (!a0) notFound();
  const { data: paper } = await db().from('papers').select('*').eq('id', a0.paper_id).single();
  const a = await syncAttempt(a0, paper as Paper);
  const rows = await buildResultRows(a, paper as Paper);
  const labels = (paper as { option_style?: string } | null)?.option_style === 'numbers' ? ['1', '2', '3', '4'] : LETTERS;
  const tone = { CORRECT: 'text-brand-700', WRONG: 'text-red-700', UNANSWERED: 'text-slate-500' } as const;
  return (
    <div className="space-y-6">
      <Link href="/admin/results" className="text-sm font-medium text-brand-700 hover:underline">&larr; All results</Link>
      <div className="card grid gap-4 p-6 md:grid-cols-3">
        <div><p className="text-xs text-slate-500">Candidate</p><p className="font-semibold">{a.candidate_name}</p><p className="text-sm text-slate-600">{a.candidate_mobile} &middot; {a.candidate_email}</p></div>
        <div><p className="text-xs text-slate-500">Paper</p><p className="font-semibold">{paper?.title}</p><p className="text-sm text-slate-600">{a.status} &middot; Language: {a.lang === 'hi' ? 'Hindi' : 'English'}</p></div>
        <div><p className="text-xs text-slate-500">Score</p><p className="font-serif text-3xl font-bold">{a.score ?? '-'}</p>
          <p className="text-sm text-slate-600">{a.correct_count ?? 0} correct &middot; {a.wrong_count ?? 0} wrong &middot; {a.unanswered_count ?? 0} unanswered</p></div>
        <p className="text-sm text-slate-600 md:col-span-3">Started {fmtDateTime(a.started_at)} &middot; Submitted {fmtDateTime(a.submitted_at)}</p>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[520px]">
          <thead className="border-b bg-slate-50"><tr><th className="th">Q</th><th className="th">Section</th><th className="th">Candidate</th><th className="th">Correct</th><th className="th">Result</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.number}><td className="td font-medium">Q{r.number}{r.image && <a className="ml-2 text-xs font-normal text-brand-700 hover:underline" href={`/api/admin/images/${r.id}?lang=${a.lang ?? 'en'}`} target="_blank" rel="noreferrer">view</a>}</td><td className="td">{r.section}</td>
                <td className="td">{r.yourOption === null ? '-' : labels[r.yourOption]}</td><td className="td">{labels[r.correctOption]}</td>
                <td className={`td font-medium ${tone[r.status]}`}>{r.status === 'CORRECT' ? 'Correct' : r.status === 'WRONG' ? 'Wrong' : 'Unanswered'}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
