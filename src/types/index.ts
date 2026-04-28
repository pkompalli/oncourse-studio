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
  created_at: string;
  updated_at: string;
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
  };
  error?: string;
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

export interface Question {
  id: string;
  job_id: string;
  course_id: string;
  question_number?: number;
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

export type StepId = 'structure' | 'generate' | 'review' | 'audit' | 'export';

export type ContentMode = 'qbank' | 'lessons';
export type QBankMode = 'mock_exam' | 'topic_wise';

export interface StepConfig {
  id: StepId;
  number: number;
  label: string;
  description: string;
}

export const STEPS: StepConfig[] = [
  { id: 'structure', number: 1, label: 'Structure', description: 'Define course structure' },
  { id: 'generate',  number: 2, label: 'Generate',  description: 'Generate content' },
  { id: 'review',    number: 3, label: 'Review',     description: 'Automated review' },
  { id: 'audit',     number: 4, label: 'Audit',      description: 'Quality gate' },
  { id: 'export',    number: 5, label: 'Export',      description: 'Export & save' },
];
