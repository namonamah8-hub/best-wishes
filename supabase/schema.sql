-- =====================================================================
-- BEST WISHES - database schema (PostgreSQL / Supabase)
-- Run this ONCE in Supabase: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE.
-- Option indexing convention: 0 = A, 1 = B, 2 = C, 3 = D  (everywhere)
-- =====================================================================
create extension if not exists pgcrypto;

create table if not exists candidates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  mobile      text not null unique,
  email       text not null,
  created_at  timestamptz not null default now()
);

create table if not exists papers (
  id                     uuid primary key default gen_random_uuid(),
  title                  text not null,
  description            text,
  source_filename        text,
  total_questions        int  not null default 100,
  section_count          int  not null default 4,
  questions_per_section  int  not null default 25,
  section_seconds        int  not null default 900,     -- 15 minutes
  correct_marks          numeric(6,2) not null default 1,
  wrong_marks            numeric(6,2) not null default 0, -- use negative for penalty e.g. -0.5
  created_at             timestamptz not null default now()
);

create table if not exists questions (
  id               uuid primary key default gen_random_uuid(),
  paper_id         uuid not null references papers(id) on delete cascade,
  question_number  int  not null,
  section          int  not null,
  question_text    text not null,
  option_a         text not null,
  option_b         text not null,
  option_c         text not null,
  option_d         text not null,
  correct_option   smallint not null check (correct_option between 0 and 3),
  image_path       text,          -- optional screenshot (table / equation / picture) stored in the private Storage bucket
  image_whole      boolean not null default true,  -- true: screenshot is the WHOLE question incl. options (hide text); false: screenshot supplements the text
  created_at       timestamptz not null default now(),
  unique (paper_id, question_number)
);
alter table questions add column if not exists image_path text;   -- (for databases created before image support)
alter table questions add column if not exists image_whole boolean not null default true;

-- Hindi version of each question (optional). Same question numbers, same correct answer.
-- How options are numbered on screen: letters A-D (classic) or numbers 1-4 (SSC-style papers).
alter table papers add column if not exists option_style text not null default 'letters' check (option_style in ('letters','numbers'));

alter table questions add column if not exists question_text_hi text;
alter table questions add column if not exists option_a_hi text;
alter table questions add column if not exists option_b_hi text;
alter table questions add column if not exists option_c_hi text;
alter table questions add column if not exists option_d_hi text;
alter table questions add column if not exists image_path_hi text;
alter table questions add column if not exists image_whole_hi boolean not null default true;
-- Language the candidate chose BEFORE starting (cannot change afterwards).
alter table attempts add column if not exists lang text not null default 'en' check (lang in ('en','hi'));
create index if not exists questions_paper_section_idx on questions(paper_id, section, question_number);

create table if not exists daily_papers (
  id          uuid primary key default gen_random_uuid(),
  exam_date   date not null,
  slot        smallint not null check (slot in (1, 2)),   -- max 2 papers/day. Change to allow more.
  paper_id    uuid not null references papers(id) on delete cascade,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (exam_date, slot),
  unique (exam_date, paper_id)
);
create index if not exists daily_papers_date_idx on daily_papers(exam_date);

create table if not exists attempts (
  id                uuid primary key default gen_random_uuid(),
  paper_id          uuid not null references papers(id),
  candidate_id      uuid not null references candidates(id),
  candidate_name    text not null,
  candidate_mobile  text not null,
  candidate_email   text not null,
  exam_date         date not null,
  started_at        timestamptz not null default now(),
  submitted_at      timestamptz,
  status            text not null default 'IN_PROGRESS'
                    check (status in ('IN_PROGRESS','COMPLETED','AUTO_SUBMITTED','ABANDONED')),
  score             numeric(8,2),
  correct_count     int,
  wrong_count       int,
  unanswered_count  int,
  section_stats     jsonb,      -- [{section,correct,wrong,unanswered}, ...]
  created_at        timestamptz not null default now(),
  unique (candidate_id, paper_id)   -- one attempt per candidate per paper
);
create index if not exists attempts_paper_idx  on attempts(paper_id);
create index if not exists attempts_status_idx on attempts(status);
create index if not exists attempts_date_idx   on attempts(exam_date);

create table if not exists answers (
  id               uuid primary key default gen_random_uuid(),
  attempt_id       uuid not null references attempts(id) on delete cascade,
  question_id      uuid not null references questions(id) on delete cascade,
  selected_option  smallint check (selected_option between 0 and 3),  -- NULL = cleared
  answered_at      timestamptz not null default now(),
  unique (attempt_id, question_id)
);
create index if not exists answers_attempt_idx on answers(attempt_id);

-- ---------------------------------------------------------------------
-- SECURITY: Row Level Security ON with NO policies = the public/anon key
-- can read or write NOTHING. Only the server (service_role key) can.
-- ---------------------------------------------------------------------
alter table candidates   enable row level security;
alter table papers       enable row level security;
alter table questions    enable row level security;
alter table daily_papers enable row level security;
alter table attempts     enable row level security;
alter table answers      enable row level security;

-- ---------------------------------------------------------------------
-- DATABASE-LEVEL TIMER ENFORCEMENT (last line of defence).
-- Even if API code had a bug, an answer can NEVER be inserted/changed
-- when the attempt is closed, the exam time is over, or the question is
-- not in the section that is open right now (judged with the DB clock).
-- ---------------------------------------------------------------------
create or replace function guard_answer() returns trigger
language plpgsql as $$
declare
  a attempts; p papers; q questions; el double precision; cur int;
begin
  select * into a from attempts  where id = new.attempt_id;
  select * into p from papers    where id = a.paper_id;
  select * into q from questions where id = new.question_id;
  if a.id is null or q.id is null then raise exception 'INVALID_REFERENCE'; end if;
  if a.status <> 'IN_PROGRESS' then raise exception 'ATTEMPT_CLOSED'; end if;
  if q.paper_id <> a.paper_id then raise exception 'WRONG_PAPER'; end if;
  el := extract(epoch from (now() - a.started_at));
  if el >= p.section_count * p.section_seconds then raise exception 'EXAM_EXPIRED'; end if;
  cur := floor(el / p.section_seconds)::int + 1;
  if q.section <> cur then raise exception 'SECTION_LOCKED'; end if;
  new.answered_at := now();
  return new;
end $$;

drop trigger if exists answers_guard on answers;
create trigger answers_guard before insert or update on answers
  for each row execute function guard_answer();

-- ---------------------------------------------------------------------
-- ATOMIC, IDEMPOTENT SUBMISSION + SERVER-SIDE SCORING
-- One transaction: locks the attempt row, counts, scores, closes it.
-- Calling it again on a closed attempt just returns the stored result.
-- ---------------------------------------------------------------------
create or replace function finalize_attempt(p_attempt uuid, p_status text)
returns attempts language plpgsql as $$
declare
  a attempts; p papers;
  v_c int; v_w int; v_u int; v_stats jsonb; v_sub timestamptz;
begin
  if p_status not in ('COMPLETED','AUTO_SUBMITTED') then raise exception 'INVALID_STATUS'; end if;
  select * into a from attempts where id = p_attempt for update;
  if not found then raise exception 'ATTEMPT_NOT_FOUND'; end if;
  if a.status <> 'IN_PROGRESS' then return a; end if;     -- idempotent
  select * into p from papers where id = a.paper_id;

  with q as (
    select qu.section, qu.correct_option, an.selected_option
    from questions qu
    left join answers an on an.question_id = qu.id and an.attempt_id = a.id
    where qu.paper_id = a.paper_id
  ), s as (
    select section,
      count(*) filter (where selected_option is not null and selected_option = correct_option)  as cor,
      count(*) filter (where selected_option is not null and selected_option <> correct_option) as wro,
      count(*) filter (where selected_option is null)                                           as una
    from q group by section
  )
  select coalesce(sum(cor),0), coalesce(sum(wro),0), coalesce(sum(una),0),
         coalesce(jsonb_agg(jsonb_build_object('section',section,'correct',cor,'wrong',wro,'unanswered',una) order by section),'[]'::jsonb)
    into v_c, v_w, v_u, v_stats from s;

  v_sub := least(now(), a.started_at + make_interval(secs => (p.section_count * p.section_seconds)::double precision));

  update attempts set
    status = p_status, submitted_at = v_sub,
    correct_count = v_c, wrong_count = v_w, unanswered_count = v_u,
    section_stats = v_stats,
    score = v_c * p.correct_marks + v_w * p.wrong_marks
  where id = a.id
  returning * into a;
  return a;
end $$;

-- Auto-submit every attempt whose total exam time is over (called by the app).
create or replace function finalize_expired() returns int
language plpgsql as $$
declare r record; n int := 0;
begin
  for r in
    select a.id from attempts a join papers p on p.id = a.paper_id
    where a.status = 'IN_PROGRESS'
      and a.started_at + make_interval(secs => (p.section_count * p.section_seconds)::double precision) <= now()
  loop
    perform finalize_attempt(r.id, 'AUTO_SUBMITTED');
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- ATOMIC PAPER IMPORT (paper + all questions in ONE transaction)
-- ---------------------------------------------------------------------
create or replace function import_paper(p jsonb) returns uuid
language plpgsql as $$
declare pid uuid; spq int := coalesce((p->>'questions_per_section')::int, 25);
begin
  insert into papers(title, description, source_filename, total_questions, section_count,
                     questions_per_section, section_seconds, correct_marks, wrong_marks, option_style)
  values (p->>'title', p->>'description', p->>'source_filename',
          jsonb_array_length(p->'questions'),
          coalesce((p->>'section_count')::int, 4), spq,
          coalesce((p->>'section_seconds')::int, 900),
          coalesce((p->>'correct_marks')::numeric, 1),
          coalesce((p->>'wrong_marks')::numeric, 0),
          coalesce(nullif(p->>'option_style', ''), 'letters'))
  returning id into pid;

  insert into questions(paper_id, question_number, section, question_text,
                        option_a, option_b, option_c, option_d, correct_option, image_path)
  select pid, (q->>'question_number')::int, ((q->>'question_number')::int - 1) / spq + 1,
         q->>'question_text', q->'options'->>0, q->'options'->>1, q->'options'->>2, q->'options'->>3,
         (q->>'correct_option')::smallint, nullif(q->>'image_path', '')
  from jsonb_array_elements(p->'questions') q;
  return pid;
end $$;

-- Attach the Hindi text of a paper in one transaction (matched by question number).
create or replace function apply_hindi(p_paper uuid, p jsonb) returns int
language plpgsql as $$
declare n int;
begin
  update questions qu set
    question_text_hi = nullif(btrim(e.item->>'question_text'), ''),
    option_a_hi = nullif(btrim(e.item->'options'->>0), ''),
    option_b_hi = nullif(btrim(e.item->'options'->>1), ''),
    option_c_hi = nullif(btrim(e.item->'options'->>2), ''),
    option_d_hi = nullif(btrim(e.item->'options'->>3), '')
  from jsonb_array_elements(p) as e(item)
  where qu.paper_id = p_paper and qu.question_number = (e.item->>'question_number')::int;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- PRIVATE Storage bucket for question images (tables / equations / pictures).
-- Private = nobody can open files directly; the app serves an image only to a
-- candidate whose section is open right now (see /api/attempts/:id/image/:qid).
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public) values ('question-images', 'question-images', false)
on conflict (id) do nothing;

-- The app talks to these functions with the service-role key only.
revoke all on function finalize_attempt(uuid, text) from public, anon, authenticated;
revoke all on function finalize_expired()           from public, anon, authenticated;
revoke all on function import_paper(jsonb)          from public, anon, authenticated;
revoke all on function apply_hindi(uuid, jsonb)     from public, anon, authenticated;
