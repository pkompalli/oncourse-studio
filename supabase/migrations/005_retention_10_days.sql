-- Migration 005: Shorten generation retention from 30 days to 10
--
-- The Supabase project hit `exceed_storage_size_quota` and service was
-- restricted. Generated sets are large (case studies and performance tasks carry
-- markdown exhibits), so the window is tightened to 10 days.
--
-- Note: this purge reclaims DATABASE space only. Generated images live in the
-- `question-images` storage bucket under questions/<job_id>/… and are removed by
-- the application when a job is deleted (see DELETE /jobs/:id) — the SQL purge
-- cannot reach them.
--
-- Re-runnable.

-- Keep the function's own default in step with the schedule.
alter function qb_delete_old_generations(int) set search_path = public;

select cron.unschedule('qb-delete-old-generations')
  where exists (select 1 from cron.job where jobname = 'qb-delete-old-generations');

select cron.schedule(
  'qb-delete-old-generations',
  '0 3 * * *',
  $$ select qb_delete_old_generations(10); $$
);

-- Verify:
--   select jobname, schedule, command from cron.job where jobname = 'qb-delete-old-generations';
--   select qb_delete_old_generations(10);   -- run once immediately to reclaim now
