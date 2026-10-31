/**
 * Supabase / PostgREST caps every query at 1000 rows unless you page through it.
 * Any bulk `qb_questions` read without pagination silently drops rows past 1000 —
 * which was hiding whole subjects from the UI/export and making review & audit
 * skip questions past the first 1000 on large jobs.
 *
 * `fetchAllRows` re-issues the query in 1000-row windows until a short page comes
 * back, returning the full result set. Pass a builder that applies your filters
 * AND `.range(from, to)` at the end (order by a stable column for consistent
 * paging).
 *
 *   const rows = await fetchAllRows((from, to) =>
 *     supabase.from('qb_questions').select('*')
 *       .eq('job_id', jobId).order('question_number', { ascending: true })
 *       .range(from, to)
 *   );
 */
// 200, not PostgREST's 1000: a 500-question job read with select('*') carries every inline image, and
// several of those at once ran past the statement timeout. A timed-out page is retried before giving up.
const PAGE_SIZE = 200;

export async function fetchAllRows<T>(
  buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  for (;;) {
    let { data, error } = await buildQuery(from, from + PAGE_SIZE - 1);
    for (let attempt = 1; error && /statement timeout|terminated|fetch failed/i.test(error.message) && attempt <= 3; attempt++) {
      await new Promise((r) => setTimeout(r, attempt * 5000));
      ({ data, error } = await buildQuery(from, from + PAGE_SIZE - 1));
    }
    if (error) throw new Error(error.message);
    const rows = data || [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}
