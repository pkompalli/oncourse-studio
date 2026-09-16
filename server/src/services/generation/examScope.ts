/**
 * Exam scoping — when a course spans multiple exams (Course > Exam > Subject >
 * Topic > Chapter) the user selects ONE exam on the structure page. That choice
 * is stored as `structure.selected_exam`. Downstream work (exam-format analysis,
 * guidelines, generation) should then operate on just that exam: its subjects,
 * and a course name qualified with the exam so the LLM analyzes the right thing.
 *
 * Non-destructive: the full parsed structure (all exams) stays intact, so the
 * user can re-select a different exam later without re-uploading.
 */
// Sentinel stored in structure.selected_exam / job config when the user picks
// "All exams" on the structure page — i.e. build the whole course, no scoping.
export const ALL_EXAMS = '__all__';

export function scopeCourseToExam(course: Record<string, unknown>): {
  courseName: string;
  structure: Record<string, unknown>;
  selectedExam: string | null;
} {
  const structure = (course.structure || {}) as Record<string, unknown>;
  const baseName = (course.name as string) || 'Course';
  const selected = (structure.selected_exam as string) || null;

  // No exam chosen, or "All exams" → no scoping (use the full structure).
  if (!selected || selected === ALL_EXAMS) return { courseName: baseName, structure, selectedExam: null };

  const allSubjects = (structure.subjects as Array<Record<string, unknown>>) || [];
  const scoped = allSubjects.filter((s) => (s.exam as string) === selected);
  const examMeta = ((structure.exams as Array<Record<string, unknown>>) || []).find((e) => (e.name as string) === selected);
  const code = examMeta?.code as string | undefined;
  const label = code ? `${selected} (${code})` : selected;

  return {
    courseName: `${baseName} — ${label}`,
    // Fall back to the full list if nothing matched, so we never analyze an empty course.
    structure: { ...structure, subjects: scoped.length > 0 ? scoped : allSubjects },
    selectedExam: selected,
  };
}
