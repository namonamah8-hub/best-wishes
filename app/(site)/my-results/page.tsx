import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCandidate } from '@/lib/auth';
import { db, must } from '@/lib/supabase';
import { fmtDate, fmtDateTime } from '@/lib/config';

export const dynamic = 'force-dynamic';

/** Every test this candidate has taken - always reachable, so a result never "disappears" after the day it was scheduled. */
export default async function MyResults() {
  const cand = await getCandidate();
  if (!cand) redirect('/');
  await db().rpc('finalize_expired');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = must(await db().from('attempts')
    .select('id,paper_id,exam_date,started_at,submitted_at,status,score,correct_count,wrong_count,unanswered_count,papers(title,total_questions,correct_marks)')
    .eq('candidate_id', cand.id).order('started_at', { ascending: false })) as any[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-3xl font-bold text-brand-900">My results</h1>
        <p className="mt-1 text-slate-600">Every test you have taken. Open one to see which questions you got right, wrong or skipped.</p>
      </div>
      {rows.length === 0 ? (
        <p className="card p-6 text-slate-600">You have not taken a test yet. <Link href="/" className="font-medium text-brand-700 underline">See today&apos;s tests</Link>.</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[680px]">
            <thead className="border-b bg-slate-50"><tr>{['Test', 'Date', 'Score', 'Right', 'Wrong', 'Skipped', ''].map((h, i) => <th key={i} className="th">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => {
                const done = r.status !== 'IN_PROGRESS';
                const total = (r.papers?.total_questions ?? 0) * Number(r.papers?.correct_marks ?? 1);
                return (
                  <tr key={r.id}>
                    <td className="td font-medium">{r.papers?.title}</td>
                    <td className="td whitespace-nowrap text-sm text-slate-600">{fmtDate(r.exam_date)}<div className="text-xs text-slate-400">{fmtDateTime(r.submitted_at ?? r.started_at)}</div></td>
                    <td className="td font-semibold">{done ? <>{Number(r.score)}<span className="font-normal text-slate-400"> / {total}</span></> : <span className="text-xs font-normal text-saffron-600">in progress</span>}</td>
                    <td className="td text-brand-700">{done ? r.correct_count : '-'}</td>
                    <td className="td text-red-700">{done ? r.wrong_count : '-'}</td>
                    <td className="td text-slate-500">{done ? r.unanswered_count : '-'}</td>
                    <td className="td whitespace-nowrap text-right">
                      {done
                        ? <Link href={`/result/${r.id}`} className="btn btn-primary !py-1.5 text-sm">View paper</Link>
                        : <Link href={`/exam/${r.paper_id}`} className="btn btn-ghost !py-1.5 text-sm">Resume</Link>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
