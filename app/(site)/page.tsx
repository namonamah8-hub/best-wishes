import Link from 'next/link';
import { getCandidate } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { getTodaysPapers, getActivity, getInProgress } from '@/lib/queries';
import { fmtDate, todayStr } from '@/lib/config';
import RegisterForm from '@/components/RegisterForm';
import ActivityTable from '@/components/ActivityTable';
import AutoRefresh from '@/components/AutoRefresh';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const cand = await getCandidate();

  if (!cand) {
    return (
      <div className="grid items-start gap-10 md:grid-cols-[1.2fr_1fr]">
        <div className="pt-4">
          <h1 className="font-serif text-4xl font-bold leading-tight text-brand-900 md:text-5xl">
            Sit the paper.<br />Under the real clock.
          </h1>
          <p className="mt-5 max-w-lg text-lg text-slate-700">
            Two fresh 100-question papers every day. Four sections of fifteen minutes each.
            When a section closes it stays closed, exactly as it will in the exam hall.
          </p>
          <ul className="mt-6 space-y-2 text-slate-700">
            <li>Sections lock automatically and the next one opens on its own.</li>
            <li>Your score and every wrong answer appear the moment you submit.</li>
            <li>Finished tests show up on the results board, section by section.</li>
          </ul>
        </div>
        <RegisterForm />
      </div>
    );
  }

  const papers = await getTodaysPapers();
  const { data: mine } = await db().from('attempts').select('id,paper_id,status').eq('candidate_id', cand.id);
  const finishedPapers = (mine ?? []).filter((a) => a.status !== 'IN_PROGRESS').map((a) => a.paper_id as string);
  const byPaper = new Map((mine ?? []).map((a) => [a.paper_id as string, a as { id: string; status: string }]));
  const [recent, live] = await Promise.all([getActivity({ order: 'recent', limit: 10 }), getInProgress()]);

  return (
    <div className="space-y-10">
      <AutoRefresh seconds={30} />
      <section>
        <h1 className="font-serif text-3xl font-bold text-brand-900">Hello, {cand.name.split(' ')[0]}</h1>
        <p className="mt-1 text-slate-600">Today&apos;s tests &middot; {fmtDate(todayStr())}</p>
        {papers.length === 0 ? (
          <p className="card mt-5 p-6 text-slate-600">No tests are scheduled for today. Please check back tomorrow.</p>
        ) : (
          <div className="mt-5 grid gap-5 md:grid-cols-2">
            {papers.map((p) => {
              const a = byPaper.get(p.id);
              return (
                <div key={p.id} className="card flex flex-col p-6">
                  <h2 className="font-serif text-xl font-bold">{p.title}</h2>
                  {p.description && <p className="mt-1 text-sm text-slate-600">{p.description}</p>}
                  <p className="mt-3 text-sm text-slate-700">
                    {p.total_questions} questions &middot; {(p.section_count * p.section_seconds) / 60} minutes &middot; {p.section_count} sections
                  </p>
                  <div className="mt-5">
                    {a && a.status !== 'IN_PROGRESS' ? (
                      <Link href={`/result/${a.id}`} className="btn btn-ghost">View my result</Link>
                    ) : (
                      <Link href={`/exam/${p.id}`} className="btn btn-primary">{a ? 'Resume test' : 'Start test'}</Link>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {live.length > 0 && (
        <section>
          <h2 className="font-serif text-xl font-bold">Taking a test right now</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {live.map((l, i) => (
              <span key={i} className="rounded-full border border-saffron-500/40 bg-saffron-100 px-3 py-1 text-sm">
                {l.name} <span className="text-slate-500">&middot; {l.paperTitle}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="mb-3 flex items-end justify-between">
          <h2 className="font-serif text-xl font-bold">Latest results</h2>
          <span className="flex gap-5 text-sm font-medium"><Link href="/my-results" className="text-brand-700 hover:underline">My results</Link><Link href="/leaderboard" className="text-brand-700 hover:underline">Full results board</Link></span>
        </div>
        <ActivityTable rows={recent} viewerId={cand.id} finishedPapers={finishedPapers} />
      </section>
    </div>
  );
}
