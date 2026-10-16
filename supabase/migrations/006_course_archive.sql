-- Migration 006: Archive flag for courses
--
-- The studio had accumulated old and duplicate courses (three "USMLE STEP2" rows, two "NEET PG", three
-- NCLEX variants) without generation guidelines or format contracts, so a job started on the wrong one
-- generated and reviewed against defaults. Archived courses stay in the table, with their reason, and
-- are left out of the course list (GET /courses; ?include_archived=1 shows them).
--
-- Re-runnable.

alter table qb_courses add column if not exists archived_at timestamptz;
alter table qb_courses add column if not exists archived_reason text;
