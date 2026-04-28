-- QBank Studio V2 — Initial Schema
-- Tables prefixed with qb_ to avoid conflicts with existing tables

CREATE TABLE qb_courses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  name TEXT NOT NULL,
  exam_type TEXT,
  structure JSONB NOT NULL DEFAULT '{}',
  exam_format JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE qb_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID REFERENCES qb_courses(id) ON DELETE CASCADE,
  user_id UUID,
  type TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  status TEXT DEFAULT 'pending',
  phase TEXT,
  progress JSONB DEFAULT '{}',
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE qb_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES qb_jobs(id) ON DELETE CASCADE,
  course_id UUID REFERENCES qb_courses(id) ON DELETE CASCADE,

  question_number INTEGER,
  question TEXT NOT NULL,
  options JSONB NOT NULL,
  correct_option TEXT NOT NULL,
  explanation TEXT,

  subject TEXT NOT NULL,
  topic TEXT NOT NULL,
  course TEXT NOT NULL,
  blooms_level TEXT,
  difficulty INTEGER,

  is_image_question BOOLEAN DEFAULT false,
  image_url TEXT,
  image_type TEXT,
  image_description TEXT,
  image_search_terms TEXT[],
  image_source TEXT,

  status TEXT DEFAULT 'generated',
  quality_score INTEGER,
  validator_score INTEGER,
  adversarial_score INTEGER,
  audit_trail JSONB DEFAULT '[]',

  attempt_number INTEGER DEFAULT 1,
  replaced_by_id UUID REFERENCES qb_questions(id),
  original_id UUID REFERENCES qb_questions(id),

  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE qb_lessons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES qb_jobs(id) ON DELETE CASCADE,
  course_id UUID REFERENCES qb_courses(id) ON DELETE CASCADE,

  subject TEXT NOT NULL,
  topic TEXT NOT NULL,
  chapter TEXT,
  course TEXT NOT NULL,
  lesson_type TEXT,
  content TEXT NOT NULL,

  status TEXT DEFAULT 'generated',
  quality_score INTEGER,
  validator_score INTEGER,
  adversarial_score INTEGER,
  audit_trail JSONB DEFAULT '[]',

  attempt_number INTEGER DEFAULT 1,
  replaced_by_id UUID REFERENCES qb_lessons(id),
  original_id UUID REFERENCES qb_lessons(id),

  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE qb_exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES qb_jobs(id) ON DELETE CASCADE,
  user_id UUID,
  format TEXT NOT NULL,
  file_path TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_qb_questions_job_id ON qb_questions(job_id);
CREATE INDEX idx_qb_questions_status ON qb_questions(status);
CREATE INDEX idx_qb_questions_subject ON qb_questions(subject);
CREATE INDEX idx_qb_lessons_job_id ON qb_lessons(job_id);
CREATE INDEX idx_qb_jobs_user_id ON qb_jobs(user_id);
CREATE INDEX idx_qb_jobs_status ON qb_jobs(status);
CREATE INDEX idx_qb_courses_user_id ON qb_courses(user_id);

-- Enable Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE qb_jobs;
ALTER PUBLICATION supabase_realtime ADD TABLE qb_questions;
ALTER PUBLICATION supabase_realtime ADD TABLE qb_lessons;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION qb_update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER qb_courses_updated_at BEFORE UPDATE ON qb_courses
  FOR EACH ROW EXECUTE FUNCTION qb_update_updated_at();

CREATE TRIGGER qb_jobs_updated_at BEFORE UPDATE ON qb_jobs
  FOR EACH ROW EXECUTE FUNCTION qb_update_updated_at();
