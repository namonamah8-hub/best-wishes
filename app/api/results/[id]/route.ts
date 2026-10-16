import { handle, ok, uuid, HttpError } from '@/lib/http';
import { requireCandidate } from '@/lib/auth';
import { loadOwned, syncAttempt, buildResultRows } from '@/lib/attempts';

export const dynamic = 'force-dynamic';

export const GET = handle(async (_req, { params }) => {
  const cand = await requireCandidate();
  const { attempt, paper } = await loadOwned(uuid(params.id), cand.id);
  const a = await syncAttempt(attempt, paper);
  if (a.status === 'IN_PROGRESS') throw new HttpError(403, 'NOT_SUBMITTED', 'Results are available after you submit.');
  const rows = await buildResultRows(a, paper);
  return ok({
    attempt: {
      id: a.id, paper: paper.title, candidate: a.candidate_name, status: a.status, startedAt: a.started_at,
      submittedAt: a.submitted_at, score: Number(a.score), total: paper.total_questions * Number(paper.correct_marks),
      correct: a.correct_count, wrong: a.wrong_count, unanswered: a.unanswered_count, sections: a.section_stats,
    },
    wrongAnswers: rows.filter((r) => r.status === 'WRONG').map((r) => ({ ...r, imageUrl: r.image ? `/api/attempts/${a.id}/image/${r.id}` : null })),
    review: rows.map((r) => ({ ...r, imageUrl: r.image ? `/api/attempts/${a.id}/image/${r.id}` : null })),
    unanswered: rows.filter((r) => r.status === 'UNANSWERED').map((r) => r.number),
  });
});
