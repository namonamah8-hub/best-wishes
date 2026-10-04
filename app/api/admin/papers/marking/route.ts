import { handle, ok, readJson, uuid, HttpError } from '@/lib/http';
import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/** Change a paper's marking scheme. Finished attempts are re-scored in the same transaction, so the results board stays consistent. */
export const POST = handle(async (req) => {
  requireAdmin();
  const b = await readJson(req);
  const paperId = uuid(b.paperId, 'paperId');
  const correct = Number(b.correct_marks), wrong = Number(b.wrong_marks);
  if (!Number.isFinite(correct) || correct <= 0 || correct > 100) throw new HttpError(400, 'INVALID_MARKS', 'Marks for a correct answer must be a positive number (e.g. 2).');
  if (!Number.isFinite(wrong) || wrong > 0 || wrong < -100) throw new HttpError(400, 'INVALID_MARKS', 'Marks for a wrong answer must be 0 or negative (e.g. -0.5).');
  const { data, error } = await db().rpc('update_marking', { p_paper: paperId, p_correct: correct, p_wrong: wrong });
  if (error) {
    if (/PAPER_NOT_FOUND/.test(error.message)) throw new HttpError(404, 'NOT_FOUND', 'Paper not found.');
    throw new Error(error.message);
  }
  return ok({ ok: true, rescored: data });
});
