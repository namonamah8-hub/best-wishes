import { handle, ok, readJson, uuid, HttpError } from '@/lib/http';
import { requireAdmin } from '@/lib/auth';
import { db, must } from '@/lib/supabase';
import { MAX_SLOTS_PER_DAY, todayStr } from '@/lib/config';
import { validateQuestions } from '@/lib/validate';

export const dynamic = 'force-dynamic';

export const GET = handle(async () => {
  requireAdmin();
  return ok({ schedule: must(await db().from('daily_papers').select('id,exam_date,slot,enabled,papers(id,title)').order('exam_date', { ascending: false }).order('slot').limit(200)) });
});

/** Re-verifies the paper (100 questions, 25 per section, 4 options, answers) before it can go live. */
async function assertPaperValid(paperId: string) {
  const { data: p } = await db().from('papers').select('id,section_count,questions_per_section').eq('id', paperId).maybeSingle();
  if (!p) throw new HttpError(404, 'NOT_FOUND', 'Paper not found.');
  const qs = must(await db().from('questions')
    .select('question_number,question_text,option_a,option_b,option_c,option_d,correct_option,section,image_path,image_whole').eq('paper_id', paperId)) as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  const errors = validateQuestions(qs.map((q) => ({
    question_number: q.question_number, question_text: q.question_text,
    options: [q.option_a, q.option_b, q.option_c, q.option_d], correct_option: q.correct_option,
    needs_image: !!q.image_path && q.image_whole !== false, // empty text is fine ONLY if a whole-question screenshot is attached
  })), { sections: p.section_count, perSection: p.questions_per_section });
  const wrongSection = qs.filter((q) => q.section !== Math.floor((q.question_number - 1) / p.questions_per_section) + 1);
  if (wrongSection.length) errors.push('Some questions are assigned to the wrong section.');
  if (errors.length) throw new HttpError(422, 'INVALID_PAPER', 'This paper is invalid and cannot be scheduled.', errors.slice(0, 20));
}

export const POST = handle(async (req) => {
  requireAdmin();
  const b = await readJson(req);
  const date = typeof b.date === 'string' ? b.date : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new HttpError(400, 'INVALID_DATE', 'Invalid date.');
  if (date < todayStr()) throw new HttpError(400, 'PAST_DATE', 'You cannot schedule a paper for a past date.');
  const slot = Number(b.slot);
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOTS_PER_DAY)
    throw new HttpError(400, 'INVALID_SLOT', `Only ${MAX_SLOTS_PER_DAY} papers can be scheduled per day (slot 1 or 2).`);
  const paperId = uuid(b.paperId, 'paperId');
  await assertPaperValid(paperId);

  // Same paper twice on the same day is pointless; reject with a clear message.
  const { data: dup } = await db().from('daily_papers').select('id,slot').eq('exam_date', date).eq('paper_id', paperId).maybeSingle();
  if (dup && dup.slot !== slot) throw new HttpError(409, 'DUPLICATE', `This paper is already scheduled on ${date} in slot ${dup.slot}.`);

  // Replaces whatever is in that slot (unique(exam_date, slot) guarantees max 2/day).
  const { error } = await db().from('daily_papers').upsert({ exam_date: date, slot, paper_id: paperId, enabled: true }, { onConflict: 'exam_date,slot' });
  if (error) throw new Error(error.message);
  return ok({ ok: true }, 201);
});

export const DELETE = handle(async (req) => {
  requireAdmin();
  const id = uuid(new URL(req.url).searchParams.get('id'), 'id');
  const { error } = await db().from('daily_papers').delete().eq('id', id);
  if (error) throw new Error(error.message);
  return ok({ ok: true });
});
