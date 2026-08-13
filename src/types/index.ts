// ── Course Structure ────────────────────────────────────────

export interface Chapter {
  name: string;
  nice_refs?: string[];
}

export interface Topic {
  name: string;
  high_yield?: boolean;
  is_high_yield?: boolean;
  chapters: Chapter[];
}

export interface Subject {
  name: string;
  description?: string;
  topics: Topic[];
}

export interface CourseStructure {
  course: string;
  exam_type?: string;
  domain_characteristics?: string;
  subjects: Subject[];
}

export interface Course {
  id: string;
  user_id?: string;
  name: string;
  exam_type?: string;
  structure: CourseStructure;
  exam_format?: ExamFormat;
  generation_guidelines?: GenerationGuidelines;
  created_at: string;
  updated_at: string;
}

// ── Generation Guidelines ─────────────────────────────────

export interface GenerationGuidelines {
  subject_distribution: Record<string, { questions: number; percentage: number }>;
  format_distribution: Array<{ format: string; percentage: number; count: number; description: string }>;
  stem_guidelines: {
    style: string;
    min_words?: number;
    max_words?: number;
    vignette_required: boolean;
    clinical_scenario_depth: string;
  };
  distractor_guidelines: {
    quality_rules: string[];
    homogeneity: string;
    common_errors_to_use: string[];
  };
  explanation_guidelines: {
    required: boolean;
    min_sentences?: number;
    must_justify_correct: boolean;
    must_address_distractors: boolean;
  };
  difficulty_distribution: Record<string, number>;
  blooms_distribution: Record<string, number>;
  image_guidelines: {
    percentage: number;
    types: string[];
    when_required: string;
  };
  answer_key_balance: string;
  coverage_rules: string[];
  anti_patterns: string[];
  custom_rules: string[];
  [key: string]: unknown;
}

// ── Exam Format ─────────────────────────────────────────────

export interface SubjectDistribution {
  questions: number;
  percentage: number;
  image_pct: number;
}

export interface ExamFormat {
  question_format?: {
    type?: string;
    num_options?: number;
    avg_stem_words?: number;
    uses_vignettes?: boolean;
    image_questions_percentage?: number;
  };
  blooms_distribution?: Record<string, number>;
  difficulty_distribution?: Record<string, number>;
  image_percentage_by_subject?: Record<string, number>;
  domain_characteristics?: Record<string, unknown>;
  // Mock exam specs
  total_questions?: number;
  time_minutes?: number;
  num_options?: number;
  negative_marking?: string;
  scoring_note?: string;
  subject_distribution?: Record<string, SubjectDistribution>;
  image_questions_total?: number;
  exam_notes?: string;
}

// ── Job ─────────────────────────────────────────────────────

export type JobType = 'mock_exam' | 'topic_qbank' | 'lessons';
export type JobStatus = 'pending' | 'generating' | 'reviewing' | 'auditing' | 'complete' | 'failed';

export interface Job {
  id: string;
  course_id: string;
  user_id?: string;
  type: JobType;
  config: Record<string, unknown>;
  status: JobStatus;
  phase?: string;
  progress: {
    completed?: number;
    total?: number;
    current_subject?: string;
    message?: string;
    token_usage?: Record<string, { prompt_tokens: number; completion_tokens: number; total_tokens: number; calls: number }>;
  };
  error?: string;
  created_at: string;
  updated_at: string;
}

// ── Question Format ─────────────────────────────────────────

export interface FormatFieldDef {
  key: string;
  type: string;
  required?: boolean;
  label: string;
  item?: Record<string, string>;
  item_fields?: FormatFieldDef[];
  shape?: Record<string, unknown>;
}

export interface QuestionFormat {
  id: string;
  name: string;
  slug: string;
  description?: string;
  schema: { fields: FormatFieldDef[] };
  example: Record<string, unknown>;
  display: {
    layout: string;
    answer_display: string;
    compact_label: string;
  };
  prompt_guide?: string;
  source: 'builtin' | 'user_defined' | 'ai_discovered';
  created_at: string;
  updated_at: string;
}

// ── Question ────────────────────────────────────────────────

export type QuestionStatus = 'generated' | 'reviewed' | 'audited' | 'approved' | 'flagged' | 'replaced' | 'manual_review';

export interface AuditEntry {
  phase: string;
  score?: number;
  changes?: string[];
  reason?: string;
  timestamp: string;
}

export interface MediaItem {
  type: string;       // "image", "xray", "ct", "histology", etc.
  url: string;
  description?: string;
  source?: string;
  search_terms?: string[];
}

export interface QuestionTags {
  subject?: string;
  topic?: string;
  blooms?: string;
  difficulty?: number;
  [key: string]: unknown;  // extensible
}

export interface Question {
  id: string;
  job_id: string;
  course_id: string;
  question_number?: number;

  // ── Flexible format system ──
  format_id?: string;
  format?: QuestionFormat;     // joined from qb_question_formats
  content?: Record<string, unknown>;  // self-describing, shape matches format.schema
  tags?: QuestionTags;
  media?: MediaItem[];

  // ── Legacy columns (backward compat, will be removed) ──
  question: string;
  options: Record<string, string>;
  correct_option: string;
  explanation?: string;
  subject: string;
  topic: string;
  course: string;
  blooms_level?: string;
  difficulty?: number;
  is_image_question: boolean;
  image_url?: string;
  image_type?: string;
  image_description?: string;
  image_search_terms?: string[];
  image_source?: string;

  // ── Scoring & status ──
  status: QuestionStatus;
  quality_score?: number;
  combined_score?: number;
  validator_score?: number;
  adversarial_score?: number;
  audit_trail: AuditEntry[];
  attempt_number: number;
  replaced_by_id?: string;
  original_id?: string;
  created_at: string;
}

// ── Lesson ──────────────────────────────────────────────────

export type LessonStatus = 'generated' | 'reviewed' | 'audited' | 'approved' | 'flagged' | 'replaced' | 'manual_review';

export interface Lesson {
  id: string;
  job_id: string;
  course_id: string;
  subject: string;
  topic: string;
  chapter?: string;
  course: string;
  lesson_type?: string;
  content: string;
  status: LessonStatus;
  quality_score?: number;
  validator_score?: number;
  adversarial_score?: number;
  audit_trail: AuditEntry[];
  attempt_number: number;
  replaced_by_id?: string;
  original_id?: string;
  created_at: string;
}

// ── App State ───────────────────────────────────────────────

export type StepId = 'structure' | 'guidelines' | 'generate' | 'review' | 'audit' | 'export';

export type ContentMode = 'qbank' | 'lessons';
export type QBankMode = 'mock_exam' | 'topic_wise';

export interface StepConfig {
  id: StepId;
  number: number;
  label: string;
  description: string;
}

export const STEPS: StepConfig[] = [
  { id: 'structure',  number: 1, label: 'Structure',   description: 'Define course structure' },
  { id: 'guidelines', number: 2, label: 'Guidelines',  description: 'Generation guidelines' },
  { id: 'generate',   number: 3, label: 'Generate',    description: 'Generate content' },
  { id: 'review',     number: 4, label: 'Review',      description: 'Automated review' },
  { id: 'audit',      number: 5, label: 'Audit',       description: 'Quality gate' },
  { id: 'export',     number: 6, label: 'Export',       description: 'Export & save' },
];
