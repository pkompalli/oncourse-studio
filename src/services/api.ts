const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// ── Courses ─────────────────────────────────────────────────

export const courses = {
  create: (data: { name: string; reference_doc?: string; input_method?: string }) =>
    request<{ course: unknown }>('/courses', { method: 'POST', body: JSON.stringify(data) }),

  list: () => request<{ courses: unknown[] }>('/courses'),

  get: (id: string) => request<{ course: unknown }>(`/courses/${id}`),

  refine: (id: string, data: { message: string; refine_type?: 'structure' | 'exam_format' }) =>
    request<{ course: unknown; chat_response: string }>(`/courses/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  delete: (id: string) =>
    request<{ success: boolean }>(`/courses/${id}`, { method: 'DELETE' }),

  analyzeExamFormat: (id: string, qbankMode?: string) =>
    request<{ course: unknown }>(`/courses/${id}/exam-format`, {
      method: 'POST',
      body: JSON.stringify({ qbank_mode: qbankMode }),
    }),

  interpretExamFormatFromText: (id: string, rawText: string) =>
    request<{ course: unknown }>(`/courses/${id}/exam-format-from-text`, {
      method: 'POST',
      body: JSON.stringify({ raw_text: rawText }),
    }),

  generateGuidelines: (id: string) =>
    request<{ course: unknown }>(`/courses/${id}/guidelines`, { method: 'POST' }),

  refineGuidelines: (id: string, message: string) =>
    request<{ course: unknown; chat_response: string }>(`/courses/${id}/guidelines`, {
      method: 'PUT',
      body: JSON.stringify({ message }),
    }),
};

// ── Jobs ────────────────────────────────────────────────────

export const jobs = {
  create: (data: { course_id: string; type: string; config: Record<string, unknown> }) =>
    request<{ job: unknown }>('/jobs', { method: 'POST', body: JSON.stringify(data) }),

  list: (courseId: string) =>
    request<{ jobs: unknown[] }>(`/jobs?course_id=${courseId}`),

  listAll: () =>
    request<{ jobs: unknown[] }>('/jobs'),

  get: (id: string) => request<{ job: unknown }>(`/jobs/${id}`),

  nextBatch: (id: string, phase?: string) =>
    request<{ status: string; batch_result?: unknown }>(`/jobs/${id}/next-batch`, {
      method: 'POST',
      body: JSON.stringify({ phase }),
    }),

  delete: (id: string) =>
    request<{ success: boolean }>(`/jobs/${id}`, { method: 'DELETE' }),

  retryImages: (id: string) =>
    request<{ totalProcessed: number; totalSuccess: number; totalFailed: number }>(`/jobs/${id}/retry-images`, { method: 'POST' }),

  reprocessFlagged: (id: string) =>
    request<{
      status: string; phase: string; step: string;
      total: number; processed: number; fixed: number;
      imageRetried: number; reApproved: number; stillFlagged: number;
      events: string[];
    }>(`/jobs/${id}/reprocess-flagged`, { method: 'POST' }),
};

// ── Questions ───────────────────────────────────────────────

export const questions = {
  list: (jobId: string) => request<{ questions: unknown[] }>(`/questions?job_id=${jobId}`),

  get: (id: string) => request<{ question: unknown }>(`/questions/${id}`),

  update: (id: string, data: Record<string, unknown>) =>
    request<{ question: unknown }>(`/questions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  approve: (id: string) =>
    request<{ question: unknown }>(`/questions/${id}/approve`, { method: 'POST' }),

  delete: (id: string) =>
    request<{ success: boolean }>(`/questions/${id}`, { method: 'DELETE' }),

  snapshots: (jobId: string, stage: string) =>
    request<{ snapshots: Array<{ question_id: string; data: Record<string, unknown> }> }>(`/questions/snapshots/${jobId}?stage=${stage}`),

  availableStages: (jobId: string) =>
    request<{ stages: string[] }>(`/questions/snapshots/${jobId}`),
};

// ── Formats ─────────────────────────────────────────────────

export const formats = {
  list: () => request<{ formats: unknown[] }>('/formats'),

  get: (id: string) => request<{ format: unknown }>(`/formats/${id}`),

  getBySlug: (slug: string) => request<{ format: unknown }>(`/formats/slug/${slug}`),

  create: (data: Record<string, unknown>) =>
    request<{ format: unknown }>('/formats', { method: 'POST', body: JSON.stringify(data) }),

  update: (id: string, data: Record<string, unknown>) =>
    request<{ format: unknown }>(`/formats/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  delete: (id: string) =>
    request<{ success: boolean }>(`/formats/${id}`, { method: 'DELETE' }),
};

// ── Export ───────────────────────────────────────────────────

export const exportApi = {
  create: (data: { job_id: string; format: string }) =>
    request<{ export: unknown }>('/export', { method: 'POST', body: JSON.stringify(data) }),
  json: (jobId: string) =>
    request<{ question_count: number; questions: unknown[]; exported_at: string }>(`/export/json/${jobId}`),
};
