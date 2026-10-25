-- 10,000 NEET PG questions from the live bank, sampled to the shape of the real exam.
--
-- Pool:      course 'Indian PG' (967d23a4…), validation_status = 'validated', tagged NEET-PG, NOT tagged PYQ,
--            and not an image-typed question whose image is missing.
-- Reference: the NEET PG papers of 2019–2025 (tags NEET-PG-2019 … NEET-PG-2025), 1.6K questions. Earlier
--            years are left out: 2012–2015 predate image questions (<1%) and the 2017 tag is an
--            image-only collection (98.6%), not a paper.
--
-- Quotas, in order:
--   subject     10,000 × the subject's share of the reference (largest remainder, sums to exactly 10,000)
--   image       subject quota × the subject's image share in the reference, capped at the pool's supply;
--               what the short subjects can't supply goes to subjects with spare image questions, in
--               proportion to their own image quota, so the overall image share still matches
--   difficulty  30/50/20 easy/medium/hard (the reference's overall mix), per (subject, image) stratum;
--               hard that a stratum can't supply goes to strata with spare hard questions (in proportion
--               to stratum size), and any remaining shortfall is filled from whatever the stratum has left
--   topic       within each cell, Sainte-Laguë order on the reference topic counts, so topics fill in
--               proportion to how often the exam asks them and a topic that runs dry spills to the next;
--               topics the reference never asked are used only when nothing else is left
-- Order is md5(id || ':neetpg10k'), so the sample is reproducible.
--
-- The pool's difficulty uses two scales; easy|1 → easy, medium|2 → medium, hard|3|4|5 → hard.
with
na as materialized (select question_id from question_tags where tag_id = '5f05a0f5-c10b-4927-9a43-322c5dc9efe1'),
py as materialized (select question_id from question_tags where tag_id = 'b9edb40a-9411-48b6-b336-c56601c01f1d'),
qa as materialized (select distinct question_id from question_assets),
ref as materialized (
  select distinct q.id, case when s.name = 'General Medicine' then 'Internal Medicine' else s.name end as subj, q.topic_id,
         (q.question_type = 'image' or qa.question_id is not null) as img
  from question_tags qt join tags t on t.id = qt.tag_id
  join questions q on q.id = qt.question_id join topics tp on tp.id = q.topic_id join subjects s on s.id = tp.subject_id
  left join qa on qa.question_id = q.id
  where t.name in ('NEET-PG-2019','NEET-PG-2020','NEET-PG-2021','NEET-PG-2022','NEET-PG-2023','NEET-PG-2024','NEET-PG-2025')
    and s.course_id = '967d23a4-3bc7-4653-a5c3-82e91420c615' and coalesce(q.validation_status, '') <> 'duplicate'),
pool as materialized (
  select q.id, case when s.name = 'General Medicine' then 'Internal Medicine' else s.name end as subj, q.topic_id,
         qa.question_id is not null as img,
         case when q.difficulty in ('easy','1') then 'e' when q.difficulty in ('hard','3','4','5') then 'h' else 'm' end as d,
         md5(q.id::text || ':neetpg10k') as r
  from questions q join topics tp on tp.id = q.topic_id join subjects s on s.id = tp.subject_id
  join na on na.question_id = q.id left join py on py.question_id = q.id left join qa on qa.question_id = q.id
  where s.course_id = '967d23a4-3bc7-4653-a5c3-82e91420c615' and q.validation_status = 'validated' and py.question_id is null
    and not (q.question_type = 'image' and qa.question_id is null)),
rs as (select subj, count(*) as n, count(*) filter (where img) as ni from ref where subj in (select subj from pool) group by 1),
sq as (select subj, n, ni, 10000.0 * n / sum(n) over () as exact from rs),
sq1 as (select *, floor(exact)::int as fl, row_number() over (order by exact - floor(exact) desc, subj) as rk from sq),
sq2 as (select subj, n, ni, fl + case when rk <= 10000 - sum(fl) over () then 1 else 0 end as q from sq1),
sup as materialized (select subj, img, d, count(*) as c from pool group by 1, 2, 3),
si0 as (select s.subj, s.q, round(s.q * s.ni::numeric / s.n)::int as qi_target, coalesce(sum(sup.c), 0)::int as simg
        from sq2 s left join sup on sup.subj = s.subj and sup.img group by 1, 2, 3),
si1 as materialized (select *, least(qi_target, simg) as qi0 from si0),
img_def as materialized (select sum(qi_target - qi0) as n from si1),
img_slot as (select subj, row_number() over (order by case when qi_target = 0 then 1e9 + g else (g - 0.5) / qi_target end, subj) as k
             from si1, generate_series(1, simg - qi0) g),
img_extra as materialized (select x.subj, count(*) as n from img_slot x, img_def d where x.k <= d.n group by 1),
si as materialized (select si1.*, qi0 + coalesce(e.n, 0)::int as qi from si1 left join img_extra e using (subj)),
strata as materialized (select subj, true as img, qi as q from si union all select subj, false, q - qi from si),
dq as (select st.subj, st.img, st.q,
              coalesce(max(c) filter (where d = 'e'), 0) as e, coalesce(max(c) filter (where d = 'm'), 0) as m,
              coalesce(max(c) filter (where d = 'h'), 0) as h
       from strata st left join sup on sup.subj = st.subj and sup.img = st.img group by 1, 2, 3),
dq1 as materialized (select *, least(round(q * 0.20)::int, h) as qh0 from dq),
hard_def as materialized (select sum(round(q * 0.20)::int - qh0) as n from dq1),
hard_slot as (select subj, img, row_number() over (order by (g - 0.5) / q, subj, img) as k
              from dq1, generate_series(1, h - qh0) g where q > 0),
hard_extra as materialized (select x.subj, x.img, count(*) as n from hard_slot x, hard_def d where x.k <= d.n group by 1, 2),
dq2 as (select dq1.*, qh0 + coalesce(e.n, 0)::int as qh from dq1 left join hard_extra e using (subj, img)),
dq3 as (select *, least(q - qh - round(q * 0.30)::int, m) as qm0 from dq2),
dq4 as (select *, least(q - qh - qm0, e) as qe from dq3),
cell as materialized (select subj, img, 'h' as d, qh as n from dq4
         union all select subj, img, 'm', least(q - qh - qe, m) from dq4
         union all select subj, img, 'e', qe from dq4),
tw as (select topic_id, count(*) as w from ref group by 1),
keyed as materialized (select p.*, coalesce(tw.w, 0) as w,
                 case when coalesce(tw.w, 0) > 0
                      then (row_number() over (partition by p.subj, p.img, p.d, p.topic_id order by p.r) - 0.5) / tw.w
                      else 1e9 + row_number() over (partition by p.subj, p.img, p.d, p.topic_id order by p.r) end as key
          from pool p left join tw using (topic_id)),
pick1 as materialized (select kk.* from (select keyed.*, row_number() over (partition by subj, img, d order by key, r) as rn from keyed) kk
          join cell c on c.subj = kk.subj and c.img = kk.img and c.d = kk.d where kk.rn <= c.n),
short as (select st.subj, st.img, st.q - count(p.id) as n from strata st left join pick1 p on p.subj = st.subj and p.img = st.img group by 1, 2, st.q),
pick as (select id, subj, topic_id, img, d from pick1
         union all
         select kk.id, kk.subj, kk.topic_id, kk.img, kk.d
         from (select k.*, row_number() over (partition by k.subj, k.img order by k.key, k.r) as rn
               from keyed k left join pick1 p1 on p1.id = k.id where p1.id is null) kk
         join short s on s.subj = kk.subj and s.img = kk.img where kk.rn <= s.n)
