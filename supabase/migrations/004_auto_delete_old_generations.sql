-- Migration 004: Auto-delete generated sets older than N days (default 10)
--
-- A "generated set" is a row in qb_jobs. This purges jobs whose created_at
-- is older than the retention window, along with everything hanging off
-- them: qb_questions, qb_question_snapshots, qb_exports.
-- Preserved: qb_courses, qb_question_formats.
--
-- Children are deleted explicitly in dependency order rather than relying
-- on FK ON DELETE CASCADE, because the live schema has diverged from the
-- repo migrations. qb_questions.replaced_by_id is a self-FK, so references
-- pointing into doomed rows are nulled first to avoid blocking the delete.
--
-- Scheduling uses pg_cron (runs in the `postgres` database on Supabase).

-- ── 1. Extension ────────────────────────────────────────────────
create extension if not exists pg_cron;

-- ── 2. Cleanup function ─────────────────────────────────────────
create or replace function qb_delete_old_generations(retention_days int default 10)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cutoff        timestamptz := now() - make_interval(days => retention_days);
  v_jobs        int;
  v_questions   int;
  v_snapshots   int;
  v_exports     int;
begin
  -- Count questions that will go (for the return payload / cron log)
  select count(*) into v_questions
    from qb_questions q join qb_jobs j on j.id = q.job_id
    where j.created_at < cutoff;

  -- Clear self-references pointing INTO doomed questions so the self-FK
  -- (replaced_by_id) can't block the delete, even from a surviving row.
  update qb_questions set replaced_by_id = null
    where replaced_by_id in (
      select q.id from qb_questions q join qb_jobs j on j.id = q.job_id
      where j.created_at < cutoff);

  -- Delete children in dependency order, then the jobs themselves.
  delete from qb_question_snapshots s
    using qb_jobs j where s.job_id = j.id and j.created_at < cutoff;
  get diagnostics v_snapshots = row_count;

  delete from qb_exports e
    using qb_jobs j where e.job_id = j.id and j.created_at < cutoff;
  get diagnostics v_exports = row_count;

  delete from qb_questions q
    using qb_jobs j where q.job_id = j.id and j.created_at < cutoff;

  delete from qb_jobs where created_at < cutoff;
  get diagnostics v_jobs = row_count;

  return jsonb_build_object(
    'ran_at',             now(),
    'retention_days',     retention_days,
    'cutoff',             cutoff,
    'deleted_jobs',       v_jobs,
    'deleted_questions',  v_questions,
    'deleted_snapshots',  v_snapshots,
    'deleted_exports',    v_exports
  );
end;
$$;

-- ── 3. Schedule: daily at 03:00 UTC ─────────────────────────────
-- Unschedule first so this migration is safely re-runnable.
select cron.unschedule('qb-delete-old-generations')
  where exists (select 1 from cron.job where jobname = 'qb-delete-old-generations');

select cron.schedule(
  'qb-delete-old-generations',
  '0 3 * * *',
  $$ select qb_delete_old_generations(10); $$
);
