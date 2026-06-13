import { useState, useRef, useEffect } from 'react';
import { useAppStore } from '../../store/appStore';
import { courses } from '../../services/api';
import type { Course, CourseStructure, Subject } from '../../types';
import {
  Sparkles, Upload, ClipboardPaste, BookOpen, ClipboardList, Layers, FileText,
  ChevronDown, ChevronUp, Loader2, BarChart3, Check, ArrowRight, ArrowLeft, X,
} from 'lucide-react';
import StructureChat from '../common/StructureChat';

type InputMethod = 'ai' | 'upload' | 'paste';
type Phase = 'structure' | 'exam_format';

// ── Exam Format Display ─────────────────────────────────────

interface SubjectDist {
  questions: number;
  percentage: number;
  image_pct: number;
}

function ExamFormatDisplay({ examFormat }: { examFormat: Record<string, unknown> }) {
  const qf = examFormat.question_format as Record<string, unknown> | undefined;
  const blooms = examFormat.blooms_distribution as Record<string, number> | undefined;
  const difficulty = examFormat.difficulty_distribution as Record<string, number> | undefined;
  const subjectDist = examFormat.subject_distribution as Record<string, SubjectDist> | undefined;
  const totalQ = examFormat.total_questions as number | undefined;
  const timeMins = examFormat.time_minutes as number | undefined;
  const negMarking = examFormat.negative_marking as string | undefined;
  const totalImgQ = examFormat.image_questions_total as number | undefined;

  return (
    <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
      {/* Overview Row */}
      <div className="px-5 py-4 grid grid-cols-2 md:grid-cols-4 gap-4">
        {totalQ != null && (
          <div>
            <div className="text-xs text-slate-500">Total Questions</div>
            <div className="text-lg font-bold text-slate-800">{totalQ}</div>
          </div>
        )}
        {timeMins != null && (
          <div>
            <div className="text-xs text-slate-500">Duration</div>
            <div className="text-lg font-bold text-slate-800">{timeMins} min</div>
          </div>
        )}
        {qf?.num_options != null && (
          <div>
            <div className="text-xs text-slate-500">Options per Q</div>
            <div className="text-lg font-bold text-slate-800">{qf.num_options as number}</div>
          </div>
        )}
        {totalImgQ != null && (
          <div>
            <div className="text-xs text-slate-500">Image Questions</div>
            <div className="text-lg font-bold text-slate-800">{totalImgQ}</div>
          </div>
        )}
      </div>

      {/* Question Format */}
      {qf && (
        <div className="px-5 py-3">
          <div className="text-xs font-medium text-slate-500 mb-2">Question Format</div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="px-2 py-1 bg-indigo-50 text-indigo-700 rounded">{(qf.type as string || '').replace(/_/g, ' ')}</span>
            {qf.uses_vignettes && <span className="px-2 py-1 bg-amber-50 text-amber-700 rounded">Clinical Vignettes</span>}
            {qf.avg_stem_words && <span className="px-2 py-1 bg-slate-100 text-slate-600 rounded">~{qf.avg_stem_words as number} words/stem</span>}
            {qf.image_questions_percentage != null && <span className="px-2 py-1 bg-emerald-50 text-emerald-700 rounded">{qf.image_questions_percentage as number}% image Qs</span>}
          </div>
          {negMarking && <div className="text-xs text-slate-500 mt-2">Marking: {negMarking}</div>}
        </div>
      )}

      {/* Bloom's + Difficulty */}
      {(blooms || difficulty) && (
        <div className="px-5 py-3 grid grid-cols-2 gap-6">
          {blooms && (
            <div>
              <div className="text-xs font-medium text-slate-500 mb-2">Bloom&apos;s Distribution</div>
              <div className="space-y-1">
                {Object.entries(blooms).map(([k, v]) => (
                  <div key={k} className="flex items-center gap-2">
                    <div className="w-24 text-xs text-slate-600 truncate">{k.replace(/^\d+_/, '')}</div>
                    <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full bg-indigo-400 rounded-full" style={{ width: `${v}%` }} />
                    </div>
                    <div className="text-xs text-slate-500 w-8 text-right">{v}%</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {difficulty && (
            <div>
              <div className="text-xs font-medium text-slate-500 mb-2">Difficulty Distribution</div>
              <div className="space-y-1">
                {Object.entries(difficulty).map(([k, v]) => {
                  const color = k === 'easy' ? 'bg-green-400' : k === 'medium' ? 'bg-amber-400' : 'bg-red-400';
                  return (
                    <div key={k} className="flex items-center gap-2">
                      <div className="w-16 text-xs text-slate-600 capitalize">{k}</div>
                      <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                        <div className={`h-full ${color} rounded-full`} style={{ width: `${v}%` }} />
                      </div>
                      <div className="text-xs text-slate-500 w-8 text-right">{v}%</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Subject Distribution Table */}
      {subjectDist && (
        <div className="px-5 py-3">
          <div className="text-xs font-medium text-slate-500 mb-2">Subject Distribution</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="py-1 pr-3">Subject</th>
                  <th className="py-1 pr-3 text-right">Questions</th>
                  <th className="py-1 pr-3 text-right">%</th>
                  <th className="py-1 text-right">Image %</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(subjectDist).map(([name, dist]) => (
                  <tr key={name} className="border-t border-slate-50">
                    <td className="py-1.5 pr-3 text-slate-700">{name}</td>
                    <td className="py-1.5 pr-3 text-right font-medium text-slate-800">{dist.questions}</td>
                    <td className="py-1.5 pr-3 text-right text-slate-500">{dist.percentage}%</td>
                    <td className="py-1.5 text-right text-slate-500">{dist.image_pct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────

export default function Step1Structure() {
  const { course, setCourse, completeStep, setStep, setView, setJob, setQuestions, resetFrom, contentMode, setContentMode, qbankMode, setQBankMode } = useAppStore();

  // Phase within Step 1
  const [phase, setPhase] = useState<Phase>('structure');

  // Structure phase state
  const [courseName, setCourseName] = useState('');
  const [inputMethod, setInputMethod] = useState<InputMethod>('ai');
  const [pasteContent, setPasteContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [structurePreview, setStructurePreview] = useState<CourseStructure | null>(null);
  const [expandedSubjects, setExpandedSubjects] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Recent courses (auto-loaded)
  const [recentCourses, setRecentCourses] = useState<Course[]>([]);

  // Exam format phase state
  const [examFormatMethod, setExamFormatMethod] = useState<InputMethod>('ai');
  const [examFormatPaste, setExamFormatPaste] = useState('');
  const [examFormatLoading, setExamFormatLoading] = useState(false);
  const examFormatFileRef = useRef<HTMLInputElement>(null);

  const needsExamFormat = contentMode === 'qbank';

  // ── Auto-load recent courses on mount ──
  useEffect(() => {
    courses.list().then((res) => {
      setRecentCourses(res.courses as Course[]);
    }).catch(() => { /* silently fail */ });
  }, []);

  const selectRecentCourse = (c: Course) => {
    setCourse(c);
    setStructurePreview(c.structure);
    setCourseName(c.name);
  };

  const deleteRecentCourse = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await courses.delete(id);
      setRecentCourses((prev) => prev.filter((c) => c.id !== id));
    } catch {
      /* silently fail */
    }
  };

  // ── File upload ──
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setPasteContent(ev.target?.result as string);
    reader.readAsText(file);
  };

  const handleExamFormatFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setExamFormatPaste(ev.target?.result as string);
    reader.readAsText(file);
  };

  // ── Generate structure ──
  const generateStructure = async () => {
    if (!courseName.trim()) { setError('Course name is required'); return; }
    setLoading(true);
    setError('');
    try {
      const res = await courses.create({
        name: courseName.trim(),
        reference_doc: (inputMethod === 'paste' || inputMethod === 'upload') ? pasteContent || undefined : undefined,
        input_method: inputMethod,
      });
      const newCourse = res.course as Course;
      setCourse(newCourse);
      setStructurePreview(newCourse.structure);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate structure');
    } finally {
      setLoading(false);
    }
  };

  // ── Approve structure ──
  const approveStructure = () => {
    if (!course) return;
    if (needsExamFormat) {
      // Move to exam format phase
      setPhase('exam_format');
      setError('');
    } else {
      // Skip exam format, go straight to generate
      setJob(null);
      setQuestions([]);
      resetFrom('generate');
      completeStep('structure');
      setStep('generate');
      setView('pipeline');
    }
  };

  // ── Analyze exam format (AI) ──
  const analyzeExamFormat = async () => {
    if (!course) return;
    setExamFormatLoading(true);
    setError('');
    try {
      const res = await courses.analyzeExamFormat(course.id, qbankMode);
      const updated = res.course as Course;
      setCourse(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to analyze exam format');
    } finally {
      setExamFormatLoading(false);
    }
  };

  // ── Save pasted/uploaded exam format ──
  const saveExamFormatFromInput = async () => {
    if (!course || !examFormatPaste.trim()) return;
    setExamFormatLoading(true);
    setError('');
    try {
      // Try parsing as JSON
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(examFormatPaste.trim());
      } catch {
        setError('Invalid JSON. Please paste valid exam format JSON.');
        setExamFormatLoading(false);
        return;
      }
      // Save via refine endpoint with a special message
      const res = await courses.refine(course.id, {
        message: `Replace the entire exam format with this: ${JSON.stringify(parsed)}`,
        refine_type: 'exam_format',
      });
      setCourse(res.course as Course);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save exam format');
    } finally {
      setExamFormatLoading(false);
    }
  };

  // ── Use existing exam format from a recent course ──
  const useRecentExamFormat = async (c: Course) => {
    if (!course || !c.exam_format) return;
    setExamFormatLoading(true);
    setError('');
    try {
      const res = await courses.refine(course.id, {
        message: `Replace the entire exam format with this: ${JSON.stringify(c.exam_format)}`,
        refine_type: 'exam_format',
      });
      setCourse(res.course as Course);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to apply exam format');
    } finally {
      setExamFormatLoading(false);
    }
  };

  // ── Approve exam format & proceed ──
  const approveExamFormatAndProceed = () => {
    if (course) {
      setJob(null);
      setQuestions([]);
      resetFrom('generate');
      completeStep('structure');
      setStep('generate');
      setView('pipeline');
    }
  };

  // ── Toggle subject expand ──
  const toggleSubject = (name: string) => {
    setExpandedSubjects((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const inputMethodOptions: { id: InputMethod; label: string; icon: React.ReactNode; desc: string }[] = [
    { id: 'ai', label: 'AI Generate', icon: <Sparkles className="w-5 h-5" />, desc: 'LLM creates from exam name' },
    { id: 'upload', label: 'Upload File', icon: <Upload className="w-5 h-5" />, desc: 'Upload JSON or Markdown' },
    { id: 'paste', label: 'Paste Content', icon: <ClipboardPaste className="w-5 h-5" />, desc: 'Paste structure JSON' },
  ];

  const examFormatMethodOptions: { id: InputMethod; label: string; icon: React.ReactNode; desc: string }[] = [
    { id: 'ai', label: 'AI Analyze', icon: <Sparkles className="w-5 h-5" />, desc: 'AI determines exam format & specs' },
    { id: 'upload', label: 'Upload File', icon: <Upload className="w-5 h-5" />, desc: 'Upload exam format JSON' },
    { id: 'paste', label: 'Paste JSON', icon: <ClipboardPaste className="w-5 h-5" />, desc: 'Paste exam format specs' },
  ];

  // ════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════

  return (
    <div className="space-y-8">
      {/* Phase Indicator (when in exam_format phase) */}
      {phase === 'exam_format' && (
        <div className="flex items-center gap-3 text-sm">
          <button
            onClick={() => setPhase('structure')}
            className="flex items-center gap-1 text-indigo-600 hover:text-indigo-800 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Structure
          </button>
          <span className="text-slate-400">|</span>
          <span className="text-slate-500">
            <Check className="w-4 h-4 inline text-green-500 mr-1" />
            Structure approved for <strong className="text-slate-700">{course?.name}</strong>
          </span>
        </div>
      )}

      {/* ══════════ PHASE 1: STRUCTURE ══════════ */}
      {phase === 'structure' && (
        <>
          {/* Content Mode Selection */}
          <section>
            <h2 className="text-lg font-semibold text-slate-800 mb-4">What do you want to create?</h2>
            <div className="grid grid-cols-2 gap-4">
              <button
                onClick={() => setContentMode('qbank')}
                className={`p-6 rounded-xl border-2 text-left transition-all ${
                  contentMode === 'qbank' ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-slate-300 bg-white'
                }`}
              >
                <ClipboardList className={`w-8 h-8 mb-3 ${contentMode === 'qbank' ? 'text-indigo-600' : 'text-slate-400'}`} />
                <h3 className="font-semibold text-slate-800">Question Bank</h3>
                <p className="text-sm text-slate-500 mt-1">Generate MCQs for exams and practice</p>
              </button>
              <button
                onClick={() => setContentMode('lessons')}
                className={`p-6 rounded-xl border-2 text-left transition-all ${
                  contentMode === 'lessons' ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-slate-300 bg-white'
                }`}
              >
                <BookOpen className={`w-8 h-8 mb-3 ${contentMode === 'lessons' ? 'text-indigo-600' : 'text-slate-400'}`} />
                <h3 className="font-semibold text-slate-800">Lessons</h3>
                <p className="text-sm text-slate-500 mt-1">Generate lesson content for study material</p>
              </button>
            </div>
          </section>

          {/* QBank Mode */}
          {contentMode === 'qbank' && (
            <section>
              <h2 className="text-lg font-semibold text-slate-800 mb-4">QBank Type</h2>
              <div className="grid grid-cols-2 gap-4">
                <button
                  onClick={() => setQBankMode('mock_exam')}
                  className={`p-4 rounded-xl border-2 text-left transition-all ${
                    qbankMode === 'mock_exam' ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-slate-300 bg-white'
                  }`}
                >
                  <FileText className={`w-6 h-6 mb-2 ${qbankMode === 'mock_exam' ? 'text-indigo-600' : 'text-slate-400'}`} />
                  <h3 className="font-medium text-slate-800">Mock Exam</h3>
                  <p className="text-xs text-slate-500 mt-1">Full exam paper across all subjects</p>
                </button>
                <button
                  onClick={() => setQBankMode('topic_wise')}
                  className={`p-4 rounded-xl border-2 text-left transition-all ${
                    qbankMode === 'topic_wise' ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-slate-300 bg-white'
                  }`}
                >
                  <Layers className={`w-6 h-6 mb-2 ${qbankMode === 'topic_wise' ? 'text-indigo-600' : 'text-slate-400'}`} />
                  <h3 className="font-medium text-slate-800">Topic-wise</h3>
                  <p className="text-xs text-slate-500 mt-1">Select specific subjects and topics</p>
                </button>
              </div>
            </section>
          )}

          {/* Recent Courses — auto-loaded */}
          {recentCourses.length > 0 && !structurePreview && (
            <section>
              <h2 className="text-lg font-semibold text-slate-800 mb-3">Recent Courses</h2>
              <div className="space-y-2">
                {recentCourses.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => selectRecentCourse(c)}
                    className="relative w-full text-left p-4 bg-white rounded-lg border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50 transition-all cursor-pointer"
                  >
                    <div className="flex items-center justify-between pr-8">
                      <div>
                        <div className="font-medium text-slate-800">{c.name}</div>
                        <div className="text-xs text-slate-400 mt-1">
                          {c.structure?.subjects?.length || 0} subjects &middot; Created {new Date(c.created_at).toLocaleDateString()}
                        </div>
                      </div>
                      {c.exam_format && (
                        <span className="text-xs px-2 py-1 bg-green-50 text-green-700 rounded border border-green-200">
                          Has Exam Format
                        </span>
                      )}
                    </div>
                    <button
                      onClick={(e) => deleteRecentCourse(e, c.id)}
                      className="absolute top-3 right-3 p-1 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                      title="Delete"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Course Structure Input */}
          <section>
            <h2 className="text-lg font-semibold text-slate-800 mb-4">
              {recentCourses.length > 0 ? 'Or Create New' : 'Course Structure'}
            </h2>
            <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-5">
              {/* Course Name */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Course / Exam Name</label>
                <input
                  type="text"
                  value={courseName}
                  onChange={(e) => setCourseName(e.target.value)}
                  placeholder="e.g., NEET PG 2025, USMLE Step 1, UKMLA AKT"
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                />
              </div>

              {/* Input Method Tabs */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">How to create the structure?</label>
                <div className="grid grid-cols-3 gap-3">
                  {inputMethodOptions.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => setInputMethod(m.id)}
                      className={`p-3 rounded-lg border-2 text-left transition-all ${
                        inputMethod === m.id ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-slate-300 bg-white'
                      }`}
                    >
                      <div className={`mb-1 ${inputMethod === m.id ? 'text-indigo-600' : 'text-slate-400'}`}>{m.icon}</div>
                      <div className="text-sm font-medium text-slate-800">{m.label}</div>
                      <div className="text-xs text-slate-500">{m.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* AI Generate hint */}
              {inputMethod === 'ai' && (
                <div className="p-4 bg-indigo-50 rounded-lg border border-indigo-100">
                  <p className="text-sm text-indigo-700">
                    The AI will use its knowledge of official curricula and exam syllabi to generate a complete course structure
                    with subjects, topics, and high-yield tags for <strong>{courseName || 'your exam'}</strong>.
                  </p>
                </div>
              )}

              {/* Upload File */}
              {inputMethod === 'upload' && (
                <div>
                  <input ref={fileInputRef} type="file" accept=".json,.md,.txt" onChange={handleFileUpload} className="hidden" />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full p-8 border-2 border-dashed border-slate-300 rounded-lg hover:border-indigo-400 hover:bg-indigo-50 transition-all flex flex-col items-center gap-2"
                  >
                    <Upload className="w-8 h-8 text-slate-400" />
                    <span className="text-sm text-slate-600">Click to upload JSON or Markdown file</span>
                    <span className="text-xs text-slate-400">Supports .json, .md, .txt</span>
                  </button>
                  {pasteContent && <p className="text-sm text-green-600 mt-2">File loaded ({pasteContent.length} characters)</p>}
                </div>
              )}

              {/* Paste Content */}
              {inputMethod === 'paste' && (
                <textarea
                  value={pasteContent}
                  onChange={(e) => setPasteContent(e.target.value)}
                  placeholder={'Paste your course structure as JSON:\n[\n  { "Subject": "Anatomy", "Topics": [{ "Topic": "Upper Limb", "Chapters": ["Bones", "Muscles"] }] }\n]\n\nOr paste syllabus text and the AI will structure it.'}
                  rows={10}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none font-mono text-sm resize-none"
                />
              )}

              {error && phase === 'structure' && <p className="text-sm text-red-600">{error}</p>}

              {/* Actions */}
              <div className="flex gap-3">
                <button
                  onClick={generateStructure}
                  disabled={loading}
                  className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                >
                  {loading ? (
                    <><Loader2 className="w-4 h-4 animate-spin" />{inputMethod === 'ai' ? 'Generating structure...' : 'Processing...'}</>
                  ) : (
                    <><Sparkles className="w-4 h-4" />{inputMethod === 'ai' ? 'Generate Structure' : 'Create Course'}</>
                  )}
                </button>
              </div>
            </div>
          </section>

          {/* Structure Preview */}
          {structurePreview && structurePreview.subjects?.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-slate-800">Course Structure Preview</h2>
                <div className="text-sm text-slate-500">
                  {structurePreview.subjects.length} subjects &middot;{' '}
                  {structurePreview.subjects.reduce((sum, s) => sum + (s.topics?.length || 0), 0)} topics
                </div>
              </div>

              <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
                {structurePreview.subjects.map((subject: Subject) => (
                  <div key={subject.name}>
                    <button
                      onClick={() => toggleSubject(subject.name)}
                      className="w-full px-5 py-3 flex items-center justify-between hover:bg-slate-50 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-semibold text-slate-800">{subject.name}</span>
                        <span className="text-xs text-slate-400">{subject.topics?.length || 0} topics</span>
                        {subject.description && (
                          <span className="text-xs text-slate-400 hidden lg:inline">— {subject.description}</span>
                        )}
                      </div>
                      {expandedSubjects.has(subject.name)
                        ? <ChevronUp className="w-4 h-4 text-slate-400" />
                        : <ChevronDown className="w-4 h-4 text-slate-400" />
                      }
                    </button>
                    {expandedSubjects.has(subject.name) && subject.topics && (
                      <div className="px-5 pb-3 grid grid-cols-2 lg:grid-cols-3 gap-2">
                        {subject.topics.map((topic) => (
                          <div
                            key={topic.name}
                            className={`text-xs px-3 py-2 rounded-lg ${
                              (topic.high_yield || topic.is_high_yield)
                                ? 'bg-amber-50 border border-amber-200 text-amber-800'
                                : 'bg-slate-50 text-slate-600'
                            }`}
                          >
                            {topic.name}
                            {(topic.high_yield || topic.is_high_yield) && (
                              <span className="ml-1 text-amber-500 font-medium">HY</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Chat Refinement — Course Structure */}
              {course && (
                <div className="mt-4">
                  <StructureChat
                    course={course}
                    refineType="structure"
                    onCourseUpdated={(updated) => {
                      setCourse(updated);
                      setStructurePreview(updated.structure);
                    }}
                  />
                </div>
              )}

              {/* Approve Structure */}
              <div className="mt-4 flex gap-3">
                <button
                  onClick={approveStructure}
                  className="flex items-center gap-2 px-6 py-2.5 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 transition-colors"
                >
                  <Check className="w-4 h-4" />
                  {needsExamFormat ? 'Approve Structure & Set Exam Format' : 'Approve & Proceed to Generate'}
                  <ArrowRight className="w-4 h-4" />
                </button>
                <button
                  onClick={() => { setStructurePreview(null); setCourse(null); }}
                  className="px-6 py-2.5 border border-slate-300 text-slate-700 rounded-lg font-medium hover:bg-slate-50 transition-colors"
                >
                  Regenerate
                </button>
              </div>
            </section>
          )}
        </>
      )}

      {/* ══════════ PHASE 2: EXAM FORMAT (mock exam only) ══════════ */}
      {phase === 'exam_format' && course && (
        <>
          {/* Recent Exam Formats — auto-shown */}
          {!course.exam_format && recentCourses.filter((c) => c.exam_format).length > 0 && (
            <section>
              <h2 className="text-lg font-semibold text-slate-800 mb-3">Recent Exam Formats</h2>
              <div className="space-y-2">
                {recentCourses.filter((c) => c.exam_format).map((c) => {
                  const ef = c.exam_format as Record<string, unknown>;
                  return (
                    <div
                      key={c.id}
                      onClick={() => useRecentExamFormat(c)}
                      className="relative w-full text-left p-4 bg-white rounded-lg border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50 transition-all cursor-pointer"
                    >
                      <div className="pr-8">
                        <div className="font-medium text-slate-800">{c.name}</div>
                        <div className="text-xs text-slate-400 mt-1">
                          {(ef.total_questions as number) || '?'} questions &middot;{' '}
                          {Object.keys((ef.subject_distribution as Record<string, unknown>) || {}).length} subjects &middot;{' '}
                          Created {new Date(c.created_at).toLocaleDateString()}
                        </div>
                      </div>
                      <button
                        onClick={(e) => deleteRecentCourse(e, c.id)}
                        className="absolute top-3 right-3 p-1 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                        title="Delete"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Exam Format Input */}
          <section>
            <h2 className="text-lg font-semibold text-slate-800 mb-4 flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-indigo-600" />
              {recentCourses.some((c) => c.exam_format) && !course.exam_format ? 'Or Create New Exam Format' : 'Exam Format & Distribution'}
            </h2>
            <p className="text-sm text-slate-500 mb-4">
              Define the exam format for <strong>{course.name}</strong> — question count, subject distribution, image percentages, difficulty, and more.
            </p>

            {/* If exam format not yet set, show input methods */}
            {!course.exam_format && (
              <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-5">
                {/* Method Tabs */}
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">How to set exam format?</label>
                  <div className="grid grid-cols-3 gap-3">
                    {examFormatMethodOptions.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => setExamFormatMethod(m.id)}
                        className={`p-3 rounded-lg border-2 text-left transition-all ${
                          examFormatMethod === m.id ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-slate-300 bg-white'
                        }`}
                      >
                        <div className={`mb-1 ${examFormatMethod === m.id ? 'text-indigo-600' : 'text-slate-400'}`}>{m.icon}</div>
                        <div className="text-sm font-medium text-slate-800">{m.label}</div>
                        <div className="text-xs text-slate-500">{m.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* AI Analyze hint */}
                {examFormatMethod === 'ai' && (
                  <div className="p-4 bg-indigo-50 rounded-lg border border-indigo-100">
                    <p className="text-sm text-indigo-700">
                      The AI will analyze the official exam blueprint for <strong>{course.name}</strong> to determine
                      total questions, per-subject distribution, image question percentages, Bloom&apos;s taxonomy levels,
                      difficulty distribution, and marking scheme.
                    </p>
                  </div>
                )}

                {/* Upload File */}
                {examFormatMethod === 'upload' && (
                  <div>
                    <input ref={examFormatFileRef} type="file" accept=".json" onChange={handleExamFormatFileUpload} className="hidden" />
                    <button
                      onClick={() => examFormatFileRef.current?.click()}
                      className="w-full p-8 border-2 border-dashed border-slate-300 rounded-lg hover:border-indigo-400 hover:bg-indigo-50 transition-all flex flex-col items-center gap-2"
                    >
                      <Upload className="w-8 h-8 text-slate-400" />
                      <span className="text-sm text-slate-600">Click to upload exam format JSON</span>
                    </button>
                    {examFormatPaste && <p className="text-sm text-green-600 mt-2">File loaded ({examFormatPaste.length} characters)</p>}
                  </div>
                )}

                {/* Paste JSON */}
                {examFormatMethod === 'paste' && (
                  <textarea
                    value={examFormatPaste}
                    onChange={(e) => setExamFormatPaste(e.target.value)}
                    placeholder={'Paste exam format JSON:\n{\n  "total_questions": 200,\n  "time_minutes": 210,\n  "num_options": 4,\n  "subject_distribution": { ... },\n  "blooms_distribution": { ... },\n  "difficulty_distribution": { "easy": 20, "medium": 50, "hard": 30 }\n}'}
                    rows={12}
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none font-mono text-sm resize-none"
                  />
                )}

                {error && phase === 'exam_format' && <p className="text-sm text-red-600">{error}</p>}

                {/* Actions */}
                <div className="flex gap-3">
                  <button
                    onClick={examFormatMethod === 'ai' ? analyzeExamFormat : saveExamFormatFromInput}
                    disabled={examFormatLoading || (examFormatMethod !== 'ai' && !examFormatPaste.trim())}
                    className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                  >
                    {examFormatLoading ? (
                      <><Loader2 className="w-4 h-4 animate-spin" />Analyzing exam format...</>
                    ) : (
                      <><Sparkles className="w-4 h-4" />{examFormatMethod === 'ai' ? 'Analyze Exam Format' : 'Save Exam Format'}</>
                    )}
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* Exam Format Preview (once analyzed/saved) */}
          {course.exam_format && (
            <section>
              <ExamFormatDisplay examFormat={course.exam_format as Record<string, unknown>} />

              {/* Chat Refinement — Exam Format */}
              <div className="mt-4">
                <StructureChat
                  course={course}
                  refineType="exam_format"
                  onCourseUpdated={(updated) => setCourse(updated)}
                />
              </div>

              {/* Approve & Proceed */}
              <div className="mt-4 flex gap-3">
                <button
                  onClick={approveExamFormatAndProceed}
                  className="flex items-center gap-2 px-6 py-2.5 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 transition-colors"
                >
                  <Check className="w-4 h-4" />
                  Approve & Proceed to Generate
                  <ArrowRight className="w-4 h-4" />
                </button>
                <button
                  onClick={() => {
                    // Reset exam format to re-analyze
                    setCourse({ ...course, exam_format: undefined });
                  }}
                  className="px-6 py-2.5 border border-slate-300 text-slate-700 rounded-lg font-medium hover:bg-slate-50 transition-colors"
                >
                  Re-analyze
                </button>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
