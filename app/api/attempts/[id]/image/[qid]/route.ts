import { handle, uuid, HttpError } from '@/lib/http';
import { requireCandidate } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { loadForViewing, finalize } from '@/lib/attempts';
import { computeTiming } from '@/lib/exam';
import { imageResponse } from '@/lib/images';
import { asLang, view } from '@/lib/lang';

export const dynamic = 'force-dynamic';

/**
 * Question image. The bucket is private; this route is the ONLY way to get a picture, and it applies the same
 * timer rules as the JSON API: while the exam runs, only questions of the section open right now are served
 * (so future sections cannot be peeked at). After submission the candidate may open them again (result page).
 */
export const GET = handle(async (_req, { params }) => {
  const cand = await requireCandidate();
  const { attempt, paper } = await loadForViewing(uuid(params.id), cand.id); // owner, or someone who finished the same test
  const qid = uuid(params.qid, 'question');
  const { data: q } = await db().from('questions').select('paper_id,section,image_path,image_whole,question_text_hi,option_a_hi,option_b_hi,option_c_hi,option_d_hi,image_path_hi,image_whole_hi').eq('id', qid).maybeSingle();
  const imagePath = q ? view(q, asLang(attempt.lang)).imagePath : null;
  if (!q || q.paper_id !== attempt.paper_id || !imagePath) throw new HttpError(404, 'NOT_FOUND', 'Image not found.');

  if (attempt.status === 'IN_PROGRESS') {
    const t = computeTiming(Date.parse(attempt.started_at), Date.now(), paper);
    if (t.finished) await finalize(attempt.id, 'AUTO_SUBMITTED');
    else if (q.section !== t.section) throw new HttpError(403, 'SECTION_LOCKED', 'This section is not open.');
  }
  return imageResponse(imagePath);
});
