-- Question Snapshots — preserves question state at each pipeline stage
--
-- Stages: generated, post_validator, post_adversarial, post_audit, post_replace

CREATE TABLE qb_question_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id UUID NOT NULL REFERENCES qb_questions(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES qb_jobs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_qb_snapshots_job_stage ON qb_question_snapshots(job_id, stage);
CREATE INDEX idx_qb_snapshots_question ON qb_question_snapshots(question_id);

-- Unique constraint: one snapshot per question per stage
CREATE UNIQUE INDEX idx_qb_snapshots_unique ON qb_question_snapshots(question_id, stage);
