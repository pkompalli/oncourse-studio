-- =============================================
-- QBank Studio — Storage Setup
-- Run this in the Supabase SQL Editor after setup.sql,
-- OR create the bucket manually in the Storage dashboard.
-- =============================================

-- Create a public storage bucket for AI-generated question images.
-- Note: The app also auto-creates this bucket on first use.
insert into storage.buckets (id, name, public)
values ('question-images', 'question-images', true)
on conflict (id) do nothing;
