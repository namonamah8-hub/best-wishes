/**
 * "Does this question need a screenshot?" clues based on TEXT only (used when no layout info is available).
 * The offline checker (scripts/pdf_to_paper.py) looks at the real PDF layout (tables, pictures, stacked
 * fractions) and is far more reliable; its flags are merged with these in the admin import screen.
 *   level 'image' = very likely needs a screenshot  -> import is blocked until you attach one or confirm "text is fine"
 *   level 'check' = look at it                       -> shown in amber, does not block
 */
export type Flag = { level: 'image' | 'check'; reason: string };

export function textFlags(q: { question_text: string; options: string[] }): Flag[] {
  const out: Flag[] = [];
  const t = q.question_text || '';
  const all = [t, ...(q.options || [])].join('\n');
  if (/\b(table|figure|diagram|graph|chart|pie|histogram|venn|caselet|image|picture|following data|data given|given data|shown in the)\b/i.test(t))
    out.push({ level: 'image', reason: 'mentions a table / figure / graph / data set' });
  if (!t.trim()) out.push({ level: 'image', reason: 'question text is empty (the question may be a picture)' });
  if ((q.options || []).some((o) => !o || !o.trim())) out.push({ level: 'image', reason: 'an option is empty (options may be pictures)' });
  if (/\uFFFD/.test(all)) out.push({ level: 'image', reason: 'unreadable characters (broken font / equation)' });
  if (/[\uE000-\uF8FF]/.test(all)) out.push({ level: 'image', reason: 'private-use characters (equation font)' });
  if (/[∑∫∏∠△∥⊥≈≠≤≥∞∂√∛∜]/.test(all)) out.push({ level: 'check', reason: 'contains math symbols - verify the text' });
  if (/[⁰¹²³⁴⁵⁶⁷⁸⁹ⁿ½¼¾⅓⅔⅛]/.test(all)) out.push({ level: 'check', reason: 'contains superscripts / fraction characters - verify' });
  if (/\^|\\frac|\\sqrt|_\{/.test(all)) out.push({ level: 'check', reason: 'contains formula markup' });
  const lines = t.split('\n').map((l) => l.trim());
  if (lines.filter((l) => /^[\d.+\-×÷=()/]{1,6}$/.test(l)).length >= 2) out.push({ level: 'image', reason: 'stacked numbers on their own lines (fraction / equation)' });
  return out;
}
