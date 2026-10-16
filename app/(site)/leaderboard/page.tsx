import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCandidate } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { getActivity, getInProgress, listPapersWithAttempts } from '@/lib/queries';
import { UUID_RE } from '@/lib/http';
import ActivityTable from '@/components/ActivityTable';
import AutoRefresh from '@/components/AutoRefresh';

export const dynamic = 'force-dynamic';

export default async function Leaderboard({ searchParams }: { searchParams: { paper?: string } }) {
  const cand = await getCandidate();
  if (!cand) redirect('/');
  const { data: mine } = await db().from('attempts').select('paper_id,status').eq('candidate_id', cand.id);
  const finishedPapers = (mine ?? []).filter((a) => a.status !== 'IN_PROGRESS').map((a) => a.paper_id as string);
  const papers = await listPapersWithAttempts();
  const paperId = searchParams.paper && UUID_RE.test(searchParams.paper) ? searchParams.paper : undefined;
  const [rows, live] = await Promise.all([
    getActivity({ paperId, order: paperId ? 'score' : 'recent', limit: 100 }), getInProgress(),
  ]);

  return (
    <div className="space-y-6">
      <AutoRefresh seconds={20} />
      <div>
        <h1 className="font-serif text-3xl font-bold text-brand-900">Results board</h1>
        <p className="mt-1 text-slate-600">Every finished attempt, with wrong answers in each section. Updates automatically.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link href="/leaderboard" className={`btn ${!paperId ? 'btn-primary' : 'btn-ghost'} !py-1.5 text-sm`}>All tests (latest)</Link>
        {papers.map((p) => (
          <Link key={p.id} href={`/leaderboard?paper=${p.id}`} className={`btn ${paperId === p.id ? 'btn-primary' : 'btn-ghost'} !py-1.5 text-sm`}>{p.title}</Link>
        ))}
      </div>
      {live.length > 0 && <p className="text-sm text-slate-600">Taking a test now: {live.map((l) => l.name).join(', ')}</p>}
      <ActivityTable rows={rows} ranked={!!paperId} viewerId={cand.id} finishedPapers={finishedPapers} />
      {paperId && <p className="text-xs text-slate-500">Ranked by score; ties are broken by who finished first.</p>}
    </div>
  );
}
