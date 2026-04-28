import { create } from 'zustand';
import type { Course, Job, Question, Lesson, StepId, ContentMode, QBankMode } from '../types';

export type AppView = 'home' | 'pipeline';
export type ContentTab = 'qbank' | 'lessons' | 'flashcards';

interface AppState {
  // Top-level view
  view: AppView;
  setView: (view: AppView) => void;
  activeTab: ContentTab;
  setActiveTab: (tab: ContentTab) => void;
  goHome: () => void;

  // Navigation
  currentStep: StepId;
  completedSteps: Set<StepId>;
  setStep: (step: StepId) => void;
  completeStep: (step: StepId) => void;
  resetFrom: (step: StepId) => void;

  // Course
  course: Course | null;
  setCourse: (course: Course | null) => void;

  // Generation config
  contentMode: ContentMode;
  qbankMode: QBankMode;
  setContentMode: (mode: ContentMode) => void;
  setQBankMode: (mode: QBankMode) => void;

  // Active job
  job: Job | null;
  setJob: (job: Job | null) => void;

  // Content
  questions: Question[];
  lessons: Lesson[];
  setQuestions: (questions: Question[]) => void;
  setLessons: (lessons: Lesson[]) => void;
  updateQuestion: (id: string, updates: Partial<Question>) => void;
  updateLesson: (id: string, updates: Partial<Lesson>) => void;
}

const STEP_ORDER: StepId[] = ['structure', 'generate', 'review', 'audit', 'export'];

export const useAppStore = create<AppState>((set) => ({
  // Top-level view
  view: 'home',
  setView: (view) => set({ view }),
  activeTab: 'qbank',
  setActiveTab: (tab) => set({ activeTab: tab }),
  goHome: () => set({
    view: 'home',
    currentStep: 'structure',
    completedSteps: new Set(),
    job: null,
    questions: [],
    lessons: [],
    course: null,
  }),

  // Navigation
  currentStep: 'structure',
  completedSteps: new Set(),
  setStep: (step) => set({ currentStep: step }),
  completeStep: (step) => set((state) => {
    const next = new Set(state.completedSteps);
    next.add(step);
    return { completedSteps: next };
  }),
  resetFrom: (step) => set((state) => {
    const idx = STEP_ORDER.indexOf(step);
    const next = new Set<StepId>();
    for (const s of state.completedSteps) {
      if (STEP_ORDER.indexOf(s) < idx) next.add(s);
    }
    return { completedSteps: next, currentStep: step };
  }),

  // Course
  course: null,
  setCourse: (course) => set({ course }),

  // Generation config
  contentMode: 'qbank',
  qbankMode: 'mock_exam',
  setContentMode: (mode) => set({ contentMode: mode }),
  setQBankMode: (mode) => set({ qbankMode: mode }),

  // Active job
  job: null,
  setJob: (job) => set({ job }),

  // Content
  questions: [],
  lessons: [],
  setQuestions: (questions) => set({ questions }),
  setLessons: (lessons) => set({ lessons }),
  updateQuestion: (id, updates) => set((state) => ({
    questions: state.questions.map((q) => q.id === id ? { ...q, ...updates } : q),
  })),
  updateLesson: (id, updates) => set((state) => ({
    lessons: state.lessons.map((l) => l.id === id ? { ...l, ...updates } : l),
  })),
}));
