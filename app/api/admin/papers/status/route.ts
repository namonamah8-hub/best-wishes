import { handle, ok, uuid } from '@/lib/http';
import { requireAdmin } from '@/lib/auth';
import { db, must } from '@/lib/supabase';
import { hindiComplete } from '@/lib/lang';

export const dynamic = 'force-dynamic';

/** Per-question status of a paper (used by scripts/upload_paper.py to VERIFY an automated upload). Never contains answers. */
export const GET = handle(async (req) => {
  requireAdmin();
  const paperId = uuid(new URL(req.url).searchParams.get('paper'), 'paper');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = must(await db().from('questions')
    .select('id,question_number,question_text,option_a,option_b,option_c,option_d,image_path,image_whole,question_text_hi,option_a_hi,option_b_hi,option_c_hi,option_d_hi,image_path_hi,image_whole_hi')
    .eq('paper_id', paperId).order('question_number')) as any[];
  const { count } = await db().from('attempts').select('id', { count: 'exact', head: true }).eq('paper_id', paperId);
  return ok({
    attempts: count ?? 0,
    questions: rows.map((q) => ({
      id: q.id, number: q.question_number,
      hasImage: !!q.image_path, imageWhole: q.image_whole !== false,
      hasImageHi: !!q.image_path_hi, imageWholeHi: q.image_whole_hi !== false,
      textComplete: !!(q.question_text ?? '').trim() && [q.option_a, q.option_b, q.option_c, q.option_d].every((o) => !!(o ?? '').trim()),
      hindiComplete: hindiComplete(q),
    })),
  });
});
