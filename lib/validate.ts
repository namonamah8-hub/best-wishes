/** Paper validation shared by the server (authoritative) and the admin review screen. */
export type DraftQ = {
  question_number: number;
  question_text: string;
  options: string[];
  correct_option: number | string | null;
  image_path?: string | null;
  /** true = the question/options are (partly) pictures; a WHOLE-question screenshot will carry them, so empty text is allowed. */
  needs_image?: boolean;
};
export type PaperShape = { sections: number; perSection: number };
export const DEFAULT_SHAPE: PaperShape = { sections: 4, perSection: 25 };
const L = ['A', 'B', 'C', 'D'];

/** Accepts 0-3 or "A"-"D". Returns 0-based index or null. 0=A,1=B,2=C,3=D. */
export function normCorrect(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3) return v;
  if (typeof v === 'string') {
    const s = v.trim().toUpperCase();
    if (s.length === 1 && L.includes(s)) return L.indexOf(s);
    if (/^[0-3]$/.test(s)) return Number(s);
  }
  return null;
}

export function validateQuestions(qs: unknown, shape: PaperShape = DEFAULT_SHAPE): string[] {
  const errors: string[] = [];
  const expected = shape.sections * shape.perSection;
  if (!Array.isArray(qs)) return ['"questions" must be a list.'];
  if (qs.length !== expected) errors.push(`Expected exactly ${expected} questions but found ${qs.length}.`);
  const seen = new Set<number>();
  for (const raw of qs as DraftQ[]) {
    const n = raw?.question_number;
    if (!Number.isInteger(n) || n < 1 || n > expected) { errors.push(`Invalid question number: ${String(n)} (must be 1-${expected}).`); continue; }
    if (seen.has(n)) errors.push(`Question ${n}: duplicate question number.`);
    seen.add(n);
    const pic = raw.needs_image === true; // text may be empty: a whole-question screenshot replaces it
    if (typeof raw.question_text !== 'string' || (!pic && !raw.question_text.trim())) errors.push(`Question ${n}: question text is empty.`);
    else if (raw.question_text.length > 5000) errors.push(`Question ${n}: question text is too long.`);
    if (!Array.isArray(raw.options) || raw.options.length !== 4) errors.push(`Question ${n}: must have exactly 4 options.`);
    else raw.options.forEach((o, i) => {
      if (typeof o !== 'string' || (!pic && !o.trim())) errors.push(`Question ${n}: Missing option ${L[i]}.`);
      else if (o.length > 2000) errors.push(`Question ${n}: option ${L[i]} is too long.`);
    });
    if (normCorrect(raw.correct_option) === null) errors.push(`Question ${n}: correct answer is missing or invalid.`);
  }
  for (let n = 1; n <= expected; n++) if (!seen.has(n)) errors.push(`Question ${n}: missing.`);
  // Section balance follows automatically from numbering (25 per section) once 1..N all exist exactly once.
  return errors;
}

export type CleanPaper = {
  title: string; description: string; source_filename: string;
  correct_marks: number; wrong_marks: number; option_style: 'letters' | 'numbers';
  section_count: number; questions_per_section: number; section_seconds: number;
  questions: { question_number: number; question_text: string; options: string[]; correct_option: number; image_path: string | null }[];
};

export function validatePaperInput(input: Record<string, unknown>, shape: PaperShape = DEFAULT_SHAPE):
  { errors: string[]; clean?: CleanPaper } {
  const errors: string[] = [];
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) errors.push('Paper title is required.');
  if (title.length > 200) errors.push('Paper title is too long.');
  const num = (v: unknown, d: number) => (v === undefined || v === null || v === '' ? d : Number(v));
  const correct = num(input.correct_marks, 1), wrong = num(input.wrong_marks, 0);
  if (!Number.isFinite(correct) || correct <= 0 || correct > 100) errors.push('Marks for a correct answer must be a positive number.');
  if (!Number.isFinite(wrong) || wrong > 0 || wrong < -100) errors.push('Marks for a wrong answer must be 0 or negative (e.g. -0.5).');
  const ss = input.section_seconds === undefined || input.section_seconds === null || input.section_seconds === '' ? 900 : Number(input.section_seconds);
  if (!Number.isInteger(ss) || ss < 10 || ss > 3600) errors.push('Seconds per section must be a whole number between 10 and 3600 (900 = 15 minutes).');
  errors.push(...validateQuestions(input.questions, shape));
  if (errors.length) return { errors };
  const questions = (input.questions as DraftQ[])
    .map((q) => ({
      question_number: q.question_number,
      question_text: q.question_text.trim(),
      options: q.options.map((o) => o.trim()),
      correct_option: normCorrect(q.correct_option) as number,
      image_path: typeof q.image_path === 'string' && /^[\w\-./]{1,200}$/.test(q.image_path) && !q.image_path.includes('..') ? q.image_path : null,
    }))
    .sort((a, b) => a.question_number - b.question_number);
  return {
    errors,
    clean: {
      title, correct_marks: correct, wrong_marks: wrong, option_style: input.option_style === 'numbers' ? 'numbers' : 'letters',
      description: typeof input.description === 'string' ? input.description.trim().slice(0, 1000) : '',
      source_filename: typeof input.source_filename === 'string' ? input.source_filename.slice(0, 255) : '',
      section_count: shape.sections, questions_per_section: shape.perSection, section_seconds: ss,
      questions,
    },
  };
}
