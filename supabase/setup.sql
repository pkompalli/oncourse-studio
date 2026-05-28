-- =============================================
-- QBank Studio — Full Database Schema
-- Run this in the Supabase SQL Editor for a new project.
-- =============================================

-- 1. COURSES
create table qb_courses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  exam_type text,
  structure jsonb default '{}'::jsonb,
  exam_format jsonb,
  created_at timestamptz default now()
);

-- 2. JOBS
create table qb_jobs (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references qb_courses(id) on delete cascade,
  type text not null,
  config jsonb default '{}'::jsonb,
  status text default 'pending',
  progress jsonb default '{}'::jsonb,
  error text,
  created_at timestamptz default now()
);

-- 3. QUESTIONS
create table qb_questions (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references qb_jobs(id) on delete cascade,
  course_id uuid references qb_courses(id) on delete set null,
  question_number integer,
  question text not null,
  options jsonb not null,
  correct_option text not null,
  explanation text default '',
  subject text default '',
  topic text default '',
  course text default '',
  blooms_level text default '',
  difficulty integer default 1,
  is_image_question boolean default false,
  image_url text,
  image_type text,
  image_description text,
  image_search_terms jsonb default '[]'::jsonb,
  image_source text,
  status text default 'generated',
  validator_score numeric,
  adversarial_score numeric,
  quality_score numeric,
  combined_score numeric,
  audit_trail jsonb default '[]'::jsonb,
  attempt_number integer default 1,
  replaced_by_id uuid references qb_questions(id),
  created_at timestamptz default now()
);

-- 4. QUESTION SNAPSHOTS
create table qb_question_snapshots (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references qb_questions(id) on delete cascade,
  job_id uuid not null references qb_jobs(id) on delete cascade,
  stage text not null,
  data jsonb not null,
  created_at timestamptz default now(),
  unique (question_id, stage)
);

-- 5. EXPORTS
create table qb_exports (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references qb_jobs(id) on delete cascade,
  format text not null,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

-- =============================================
-- Indexes
-- =============================================
create index idx_qb_jobs_course_id on qb_jobs(course_id);
create index idx_qb_questions_job_id on qb_questions(job_id);
create index idx_qb_questions_replaced_by on qb_questions(replaced_by_id);
create index idx_qb_question_snapshots_job_stage on qb_question_snapshots(job_id, stage);
