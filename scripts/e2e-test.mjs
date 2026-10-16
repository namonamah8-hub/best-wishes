#!/usr/bin/env node
/**
 * End-to-end + security test against a RUNNING copy of the app (local or deployed).
 *   BASE_URL=http://localhost:3000 ADMIN_USERNAME=admin ADMIN_PASSWORD=... node scripts/e2e-test.mjs
 *
 * It imports a throw-away paper with 10-second sections (40 s total), puts it in TODAY's slot 2,
 * and exercises the real timer, locking, auto-submit, scoring (+1 / -0.5) and API abuse cases.
 * Run it on a test/staging database: it REPLACES whatever is in today's slot 2. Takes ~50 seconds.
 */
import fs from 'node:fs';

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const USER = process.env.ADMIN_USERNAME || 'admin';
const PASS = process.env.ADMIN_PASSWORD;
if (!PASS) { console.error('Set ADMIN_PASSWORD'); process.exit(1); }

let passed = 0, failed = 0;
const ok = (c, name) => { c ? (passed++, console.log('  PASS', name)) : (failed++, console.log('  FAIL', name)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Session {
  jar = {};
  async call(method, path, body) {
    const r = await fetch(BASE + path, {
      method, redirect: 'manual',
      headers: { 'Content-Type': 'application/json', Cookie: Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of r.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); this.jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  }
}

const sample = JSON.parse(fs.readFileSync(new URL('../data/sample-paper.json', import.meta.url), 'utf8'));
const truth = sample.questions;
const wrongOf = (c) => (c + 1) % 4;

const admin = new Session();
console.log('Admin');
ok((await admin.call('POST', '/api/admin/login', { username: USER, password: 'wrong' })).status === 401, 'wrong admin password rejected');
ok((await new Session().call('GET', '/api/admin/papers')).status === 401, 'admin API without login -> 401');
ok((await admin.call('POST', '/api/admin/login', { username: USER, password: PASS })).status === 200, 'admin login');

const bad = { ...sample, questions: sample.questions.slice(0, 99) };
const badRes = await admin.call('POST', '/api/admin/papers', bad);
ok(badRes.status === 422 && badRes.json.details?.length > 0, 'invalid paper (99 questions) rejected with a useful report');

const title = `TIMER TEST ${Date.now()}`;
const imp = await admin.call('POST', '/api/admin/papers', { ...sample, title, section_seconds: 10, wrong_marks: -0.5 });
ok(imp.status === 201 && imp.json.questions === 100, 'valid paper imported (100 questions, 10s sections, -0.5 marking)');
const paperId = imp.json.id;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata' }).format(new Date());
ok((await admin.call('POST', '/api/admin/schedule', { date: today, slot: 3, paperId })).status === 400, 'third slot on a day is refused');
ok((await admin.call('POST', '/api/admin/schedule', { date: today, slot: 2, paperId })).status === 201, 'paper scheduled for today (slot 2)');

console.log('Candidate');
const cand = new Session();
ok((await cand.call('POST', '/api/attempts', { paperId })).status === 401, 'cannot start without registering');
const mobile = '9' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
ok((await cand.call('POST', '/api/register', { name: 'Test Candidate', mobile, email: 't@example.com' })).status === 200, 'register (name, mobile, email)');
ok((await new Session().call('POST', '/api/register', { name: 'X', mobile: '123', email: 'bad' })).status === 400, 'bad registration rejected');
const daily = await cand.call('GET', '/api/daily');
ok(daily.json.papers.some((p) => p.id === paperId), "paper shows in today's list");

const start = await cand.call('POST', '/api/attempts', { paperId });
const attemptId = start.json.attemptId;
ok(start.status === 201 && attemptId, 'attempt created');
ok((await cand.call('POST', '/api/attempts', { paperId })).json.attemptId === attemptId, 'second start returns the SAME attempt (no duplicate)');

let state = (await cand.call('GET', `/api/attempts/${attemptId}`)).json;
const fetchedAt = Date.now(), first = state; // waits below are relative to SERVER time
const waitServer = (serverMs, margin) => sleep(Math.max(0, serverMs - first.serverNow - (Date.now() - fetchedAt) + margin));
ok(state.section === 1 && state.questions.length === 25 && state.questions[0].number === 1, 'section 1 shows questions 1-25 only');
ok(!/correct_option|correct/i.test(JSON.stringify(state)), 'correct answers are NOT sent to the browser');

const idOf = {}; // question number -> id (only section 1 is visible now; others learned later)
state.questions.forEach((q) => (idOf[q.number] = q.id));
const ans = (qid, o) => cand.call('POST', `/api/attempts/${attemptId}/answer`, { questionId: qid, selectedOption: o });

console.log('Answers + abuse');
ok((await ans(idOf[1], 1)).status === 200, 'save Q1 = B');
ok((await ans(idOf[1], truth[0].correct_option)).status === 200, 'change Q1 to the correct option');
ok((await ans(idOf[2], wrongOf(truth[1].correct_option))).status === 200, 'Q2 = a wrong option');
state = (await cand.call('GET', `/api/attempts/${attemptId}`)).json;
ok(state.answers[idOf[1]] === truth[0].correct_option, 'refresh restores the saved (changed) answer');
ok((await ans('00000000-0000-0000-0000-000000000000', 1)).status === 400, 'unknown question id rejected');
ok((await ans('not-a-uuid', 1)).status === 400, 'malformed question id rejected');
ok((await ans(idOf[3], 9)).status === 400, 'invalid option rejected');
ok((await new Session().call('GET', `/api/attempts/${attemptId}`)).status === 401, 'no cookie -> 401');
const other = new Session();
await other.call('POST', '/api/register', { name: 'Other Person', mobile: '9' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0'), email: 'o@example.com' });
ok((await other.call('GET', `/api/attempts/${attemptId}`)).status === 404, "another candidate cannot read my attempt");
ok((await other.call('POST', `/api/attempts/${attemptId}/answer`, { questionId: idOf[3], selectedOption: 0 })).status === 404, "another candidate cannot write my answers");
ok((await cand.call('GET', `/api/results/${attemptId}`)).status === 403, 'result/correct answers refused before submission');

console.log('Timer: waiting for section 2 (10 s)...');
await waitServer(first.sectionEndsAt, 600);
state = (await cand.call('GET', `/api/attempts/${attemptId}`)).json;
ok(state.section === 2 && state.questions[0].number === 26, 'after 10 s the server moves to section 2 (Q26-50)');
ok(state.sections[0].state === 'locked', 'section 1 is locked');
const r = await ans(idOf[1], wrongOf(truth[0].correct_option));
ok(r.status === 403 && r.json.error === 'SECTION_LOCKED', 'modifying a section-1 answer after expiry -> 403');
const q26 = state.questions[0].id;
ok((await ans(q26, truth[25].correct_option)).status === 200, 'Q26 answered correctly in section 2');
ok((await ans(state.questions[1].id, null)).status === 200, 'clearing an answer in the open section works');

console.log('Timer: waiting for automatic submission at 40 s...');
await waitServer(first.examEndsAt, 800);
const fin = (await cand.call('GET', `/api/attempts/${attemptId}`)).json;
ok(fin.finished === true && fin.status === 'AUTO_SUBMITTED', 'exam auto-submitted at the deadline');
ok((await ans(q26, 0)).status === 403, 'no answers accepted after the exam ended');
const sub = await cand.call('POST', `/api/attempts/${attemptId}/submit`);
const sub2 = await cand.call('POST', `/api/attempts/${attemptId}/submit`);
ok(sub.status === 200 && sub2.status === 200 && sub.json.status === 'AUTO_SUBMITTED', 'submit is idempotent');

const res = (await cand.call('GET', `/api/results/${attemptId}`)).json;
const a = res.attempt;
ok(a.correct === 2 && a.wrong === 1 && a.unanswered === 97, `counts: 2 correct, 1 wrong, 97 unanswered (got ${a.correct}/${a.wrong}/${a.unanswered})`);
ok(a.score === 1.5, `score = 2 x (+1) + 1 x (-0.5) = 1.5 (got ${a.score})`);
ok(res.wrongAnswers.length === 1 && res.wrongAnswers[0].number === 2, 'wrong-answer analysis lists Q2');
ok(a.sections.length === 4 && a.sections[0].correct === 1 && a.sections[0].wrong === 1, 'section-wise stats stored');
ok((await other.call('GET', `/api/results/${attemptId}`)).status === 403, "a candidate who has NOT finished this test cannot open my paper (403)");
const board = (await cand.call('GET', `/api/leaderboard?paper=${paperId}`)).json;
ok(board.rows.some((x) => x.id === attemptId) && !/mobile|email/i.test(JSON.stringify(board)), 'attempt shows on the results board without private details');

const detail = await admin.call('GET', `/api/admin/results/${attemptId}`);
ok(detail.status === 200 && detail.json.rows.length === 100, 'admin sees question-by-question detail');
const csv = await fetch(`${BASE}/api/admin/results?format=csv`, { headers: { Cookie: Object.entries(admin.jar).map(([k, v]) => `${k}=${v}`).join('; ') } });
ok(csv.status === 200 && (await csv.text()).includes('Test Candidate'), 'admin CSV export works');

console.log(`\n${passed} passed, ${failed} failed`);
console.log('Cleanup: remove the paper "' + title + '" from Admin > Schedule (and Papers if you wish).');
process.exit(failed ? 1 : 0);
