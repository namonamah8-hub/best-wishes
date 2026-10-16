import { db, must } from './supabase';
import { todayStr } from './config';
import type { Paper } from './attempts';
import { hindiComplete } from './lang';

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function getTodaysPapers(): Promise<(Paper & { slot: number })[]> {
  const rows = must(await db().from('daily_papers')
    .select('slot, papers(*)').eq('exam_date', todayStr()).eq('enabled', true).order('slot')) as any[];
  return rows.filter((r) => r.papers).map((r) => ({ ...(r.papers as Paper), slot: r.slot }));
}

export async function getPaper(id: string): Promise<Paper | null> {
  const { data } = await db().from('papers').select('*').eq('id', id).maybeSingle();
  return (data as Paper) ?? null;
}

export async function isScheduledToday(paperId: string): Promise<boolean> {
  const { data } = await db().from('daily_papers').select('id')
    .eq('exam_date', todayStr()).eq('paper_id', paperId).eq('enabled', true).maybeSingle();
  return !!data;
}

export type ActivityRow = {
  id: string; candidateId: string; name: string; paperId: string; paperTitle: string; total: number; examDate: string;
  score: number; correct: number; wrong: number; unanswered: number;
  sections: { section: number; correct: number; wrong: number; unanswered: number }[];
  submittedAt: string | null; status: string;
};

/** Finished attempts. Public-safe: never includes mobile/email. */
export async function getActivity(opts: { paperId?: string; order: 'score' | 'recent'; limit?: number }): Promise<ActivityRow[]> {
  await db().rpc('finalize_expired'); // auto-submit anything whose time is over
  let q = db().from('attempts')
    .select('id,candidate_id,candidate_name,paper_id,exam_date,score,correct_count,wrong_count,unanswered_count,section_stats,submitted_at,status,papers(title,total_questions,correct_marks)')
    .in('status', ['COMPLETED', 'AUTO_SUBMITTED']);
  if (opts.paperId) q = q.eq('paper_id', opts.paperId);
  q = opts.order === 'score'
    ? q.order('score', { ascending: false }).order('submitted_at', { ascending: true })
    : q.order('submitted_at', { ascending: false });
  const rows = must(await q.limit(opts.limit ?? 50)) as any[];
  return rows.map((r) => ({
    id: r.id, candidateId: r.candidate_id, name: r.candidate_name, paperId: r.paper_id, paperTitle: r.papers?.title ?? '',
    total: (r.papers?.total_questions ?? 0) * Number(r.papers?.correct_marks ?? 1),
    examDate: r.exam_date, score: Number(r.score ?? 0), correct: r.correct_count ?? 0, wrong: r.wrong_count ?? 0,
    unanswered: r.unanswered_count ?? 0, sections: r.section_stats ?? [], submittedAt: r.submitted_at, status: r.status,
  }));
}

export async function getInProgress(): Promise<{ name: string; paperTitle: string; startedAt: string }[]> {
  const rows = must(await db().from('attempts').select('candidate_name,started_at,papers(title)')
    .eq('status', 'IN_PROGRESS').gte('started_at', new Date(Date.now() - 2 * 3600_000).toISOString())
    .order('started_at', { ascending: false }).limit(30)) as any[];
  return rows.map((r) => ({ name: r.candidate_name, paperTitle: r.papers?.title ?? '', startedAt: r.started_at }));
}

export async function listPapersWithAttempts(): Promise<{ id: string; title: string }[]> {
  const rows = must(await db().from('papers').select('id,title').order('created_at', { ascending: false }).limit(100)) as any[];
  return rows;
}

/* ---------- admin results ---------- */
export type ResultFilters = { date?: string; paperId?: string; q?: string; minScore?: number };
export async function queryAttempts(f: ResultFilters, limit = 500) {
  await db().rpc('finalize_expired');
  let q = db().from('attempts')
    .select('id,candidate_name,candidate_mobile,candidate_email,exam_date,started_at,submitted_at,status,score,correct_count,wrong_count,unanswered_count,paper_id,papers(title)')
    .order('started_at', { ascending: false }).limit(limit);
  if (f.date) q = q.eq('exam_date', f.date);
  if (f.paperId) q = q.eq('paper_id', f.paperId);
  if (f.minScore !== undefined && !Number.isNaN(f.minScore)) q = q.gte('score', f.minScore);
  if (f.q) {
    const s = f.q.replace(/[%,()*]/g, '').slice(0, 60);
    if (s) q = q.or(`candidate_name.ilike.%${s}%,candidate_mobile.ilike.%${s}%,candidate_email.ilike.%${s}%`);
  }
  return must(await q) as any[];
}

/** Is a COMPLETE Hindi version available for this paper? (Only then do candidates get the language choice.) */
export async function hindiStatus(paperId: string): Promise<{ complete: number; total: number; ready: boolean }> {
  const rows = must(await db().from('questions').select('question_text_hi,option_a_hi,option_b_hi,option_c_hi,option_d_hi,image_path_hi,image_whole_hi').eq('paper_id', paperId)) as any[];
  const complete = rows.filter(hindiComplete).length;
  return { complete, total: rows.length, ready: rows.length > 0 && complete === rows.length };
}
