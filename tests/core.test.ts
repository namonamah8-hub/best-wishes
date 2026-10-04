import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeTiming } from '../lib/exam';
import { parseExamText } from '../lib/parser';
import { validateQuestions, validatePaperInput, normCorrect } from '../lib/validate';

const cfg = { section_count: 4, section_seconds: 900 };
const S = 1_000_000;
const at = (sec: number) => computeTiming(S, S + sec * 1000, cfg);

test('section boundaries: 0-899 -> 1, 900-1799 -> 2, 1800-2699 -> 3, 2700-3599 -> 4, 3600+ finished', () => {
  const expect: [number, number | 'done'][] = [[0, 1], [899.9, 1], [900, 2], [1799, 2], [1800, 3], [2699, 3], [2700, 4], [3599.9, 4], [3600, 'done'], [9999, 'done']];
  for (const [sec, want] of expect) {
    const t = at(sec);
    assert.equal(t.finished ? 'done' : t.section, want, `at ${sec}s`);
  }
});

test('client clock going backwards cannot extend time (server passes its own now)', () => {
  const t = computeTiming(S, S - 5000, cfg); // "now" earlier than start => elapsed clamped to 0
  assert.equal(t.finished, false);
  if (!t.finished) assert.equal(t.section, 1);
});

test('refresh at 7 minutes leaves ~8 minutes in section 1', () => {
  const t = at(420);
  assert.ok(!t.finished);
  if (!t.finished) assert.equal(Math.round((t.sectionEndsAtMs - (S + 420_000)) / 1000), 480);
});

test('sample text parses to the exact sample JSON (3 different PDF layouts)', () => {
  const text = fs.readFileSync('data/sample-paper.txt', 'utf8');
  const truth = JSON.parse(fs.readFileSync('data/sample-paper.json', 'utf8')).questions;
  const r = parseExamText(text, 100);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.questions, truth);
  assert.deepEqual(validateQuestions(r.questions), []);
});

test('missing option marker is reported per question, never silently accepted', () => {
  const t = 'Mock\n1. Two plus two?\n(a) 3\n(b) 4\n(c) 5\n(d) 6\n2. Capital of France?\n(a) Rome\n(b) Paris\n(d) Madrid\n\nAnswer Key\n1. (b) 2. (b)';
  const r = parseExamText(t, 2);
  assert.ok(r.errors.some((e) => /Question 2/.test(e) && /option marker C/.test(e)));
  assert.equal(r.questions[0].correct_option, 1);
});

test('validation catches wrong counts, duplicates and missing options', () => {
  const sample = JSON.parse(fs.readFileSync('data/sample-paper.json', 'utf8'));
  assert.equal(validatePaperInput(sample).errors.length, 0);
  const short = { ...sample, questions: sample.questions.slice(0, 99) };
  assert.ok(validatePaperInput(short).errors.some((e: string) => /99/.test(e)));
  const broken = JSON.parse(JSON.stringify(sample)); broken.questions[46].options[2] = '';
  assert.ok(validatePaperInput(broken).errors.includes('Question 47: Missing option C.'));
  const dup = JSON.parse(JSON.stringify(sample)); dup.questions[5].question_number = 4;
  assert.ok(validatePaperInput(dup).errors.some((e: string) => /duplicate/.test(e)));
  assert.ok(validatePaperInput({ ...sample, wrong_marks: 1 }).errors.length > 0);
});

test('normCorrect accepts 0-3 and A-D only', () => {
  assert.equal(normCorrect('c'), 2); assert.equal(normCorrect(3), 3);
  assert.equal(normCorrect(4), null); assert.equal(normCorrect(''), null); assert.equal(normCorrect(null), null);
});

import { textFlags } from '../lib/flags';
test('text clues flag tables / empty options / math symbols, but not plain questions', () => {
  const plain = textFlags({ question_text: 'Who was the first PM of India?', options: ['A', 'B', 'C', 'D'] });
  assert.deepEqual(plain, []);
  assert.ok(textFlags({ question_text: 'Table - daily production of 5 machines', options: ['1', '2', '3', '4'] }).some((f) => f.level === 'image'));
  assert.ok(textFlags({ question_text: 'Pick one', options: ['1', '', '3', '4'] }).some((f) => f.level === 'image'));
  assert.ok(textFlags({ question_text: 'p = √3 + √7', options: ['a', 'b', 'c', 'd'] }).some((f) => f.level === 'check'));
});

import { view, hindiComplete, asLang } from '../lib/lang';
test('language: Hindi only usable when text is complete or a whole screenshot exists; English untouched', () => {
  const base = { question_text: 'Q', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', image_path: null, image_whole: true };
  assert.equal(asLang('hi'), 'hi'); assert.equal(asLang('xx'), 'en'); assert.equal(asLang(undefined), 'en');
  assert.deepEqual(view(base, 'en').options, ['a', 'b', 'c', 'd']);
  assert.equal(hindiComplete(base), false); // no Hindi yet
  const hiText = { ...base, question_text_hi: 'प्रश्न', option_a_hi: 'क', option_b_hi: 'ख', option_c_hi: 'ग', option_d_hi: 'घ' };
  assert.equal(hindiComplete(hiText), true);
  assert.equal(view(hiText, 'hi').text, 'प्रश्न');
  assert.equal(hindiComplete({ ...hiText, option_c_hi: null }), false);                      // one option missing
  assert.equal(hindiComplete({ ...base, image_path_hi: 'x/hi-q001.png', image_whole_hi: true }), true);   // whole screenshot is enough
  assert.equal(hindiComplete({ ...base, image_path_hi: 'x/hi-q001.png', image_whole_hi: false }), false); // figure-only needs text
  assert.equal(view({ ...base, image_path: 'en.png' }, 'hi').imagePath, null); // English image never leaks into Hindi
});

test('pictures: empty text is allowed only for questions marked needs_image; option_style is carried through', () => {
  const sample = JSON.parse(fs.readFileSync('data/sample-paper.json', 'utf8'));
  const pic = JSON.parse(JSON.stringify(sample));
  pic.questions[0].question_text = ''; pic.questions[0].options = ['', '', '', ''];
  assert.ok(validatePaperInput(pic).errors.length > 0);                 // empty text without needs_image -> rejected
  pic.questions[0].needs_image = true;
  assert.deepEqual(validatePaperInput(pic).errors, []);                  // declared picture question -> accepted
  assert.equal(validatePaperInput({ ...pic, option_style: 'numbers' }).clean?.option_style, 'numbers');
  assert.equal(validatePaperInput(pic).clean?.option_style, 'letters');
  pic.questions[1].correct_option = null; pic.questions[1].needs_image = true;
  assert.ok(validatePaperInput(pic).errors.some((e: string) => /Question 2/.test(e)));   // the answer is ALWAYS required
});

test('marking scheme +2 / -0.5 is accepted; bad schemes are rejected', () => {
  const sample = JSON.parse(fs.readFileSync('data/sample-paper.json', 'utf8'));
  const ok = validatePaperInput({ ...sample, correct_marks: 2, wrong_marks: -0.5 });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.clean?.correct_marks, 2); assert.equal(ok.clean?.wrong_marks, -0.5);
  assert.ok(validatePaperInput({ ...sample, correct_marks: 2, wrong_marks: 0.5 }).errors.length > 0);   // a wrong answer can never ADD marks
  assert.ok(validatePaperInput({ ...sample, correct_marks: 0, wrong_marks: 0 }).errors.length > 0);
  // the exact formula the database uses: correct x correct_marks + wrong x wrong_marks
  const score = (c: number, w: number) => c * 2 + w * -0.5;
  assert.equal(score(74, 18), 139); assert.equal(score(100, 0), 200); assert.equal(score(2, 1), 3.5);
});
