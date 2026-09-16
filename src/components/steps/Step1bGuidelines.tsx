import { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../../store/appStore';
import { courses } from '../../services/api';
import type { Course, GenerationGuidelines } from '../../types';
import { Loader2, CheckCircle2, Send, ChevronDown, ChevronUp, FileText, ArrowRight, RefreshCw } from 'lucide-react';

export default function Step1bGuidelines() {
  const { course, setCourse, completeStep, setStep, setView, setJob, setQuestions, resetFrom } = useAppStore();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Chat refinement
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Section expansion
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set([
    'subject_distribution', 'format_distribution', 'stem_guidelines',
    'distractor_guidelines', 'coverage_rules',
  ]));

  const guidelines = course?.generation_guidelines as GenerationGuidelines | undefined;

  // Auto-generate on mount if no guidelines
  useEffect(() => {
    if (course && !course.generation_guidelines && !loading) {
      handleGenerate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [course?.id]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const handleGenerate = async () => {
    if (!course) return;
    setLoading(true);
    setError('');
    try {
      const res = await courses.generateGuidelines(course.id);
      setCourse(res.course as Course);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate guidelines');
    } finally {
      setLoading(false);
    }
  };

  const handleChatSend = async () => {
    if (!course || !chatInput.trim()) return;
    const userMsg = chatInput.trim();
    setChatInput('');
    setChatMessages((prev) => [...prev, { role: 'user', text: userMsg }]);
    setChatLoading(true);
    try {
      const res = await courses.refineGuidelines(course.id, userMsg);
      setCourse(res.course as Course);
      setChatMessages((prev) => [...prev, { role: 'assistant', text: res.chat_response }]);
    } catch (e) {
      setChatMessages((prev) => [...prev, { role: 'assistant', text: `Error: ${e instanceof Error ? e.message : 'Failed'}` }]);
    } finally {
      setChatLoading(false);
    }
  };

  const handleApproveAndProceed = () => {
    if (!course) return;
    setJob(null);
    setQuestions([]);
    resetFrom('generate');
    completeStep('guidelines');
    setStep('generate');
    setView('pipeline');
  };

  const toggleSection = (key: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // Loading state
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
        <p className="text-slate-600 font-medium">Generating guidelines from exam format...</p>
        <p className="text-sm text-slate-400">This takes a few seconds</p>
      </div>
    );
  }

  if (error && !guidelines) {
    return (
      <div className="space-y-4">
        <div className="p-4 rounded-xl border border-red-200 bg-red-50 text-red-700 text-sm">{error}</div>
        <button onClick={handleGenerate} className="px-4 py-2 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700">
          Retry
        </button>
      </div>
    );
  }

  if (!guidelines) return null;

  return (
    <div className="space-y-6 pb-24">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
            <FileText className="w-5 h-5 text-indigo-600" />
            Generation Guidelines
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Review the rules that will guide question generation and validation. Modify via chat below.
          </p>
        </div>
        <button
          onClick={handleGenerate}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Regenerate
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-lg border border-red-200 bg-red-50 text-red-700 text-sm">{error}</div>
      )}

      {/* Guidelines sections */}
      <div className="space-y-3">
        {/* Subject Distribution */}
        <GuidelineSection
          title="Subject Distribution"
          sectionKey="subject_distribution"
          expanded={expandedSections.has('subject_distribution')}
          onToggle={toggleSection}
        >
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {Object.entries(guidelines.subject_distribution || {}).map(([subj, dist]) => (
              <div key={subj} className="p-2.5 bg-slate-50 rounded-lg border border-slate-100">
                <div className="text-sm font-medium text-slate-700 truncate">{subj}</div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {dist.questions} Qs ({dist.percentage}%)
                </div>
              </div>
            ))}
          </div>
        </GuidelineSection>

        {/* Format Distribution */}
        <GuidelineSection
          title="Format Distribution"
          sectionKey="format_distribution"
          expanded={expandedSections.has('format_distribution')}
          onToggle={toggleSection}
        >
          <div className="space-y-2">
            {(guidelines.format_distribution || []).map((fmt, i) => (
              <div key={i} className="flex items-center gap-3 p-2.5 bg-slate-50 rounded-lg border border-slate-100">
                <span className="text-xs font-mono px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded shrink-0">
                  {fmt.format}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-slate-700">{fmt.description}</div>
                </div>
                <span className="text-sm font-medium text-slate-600 shrink-0">
                  {fmt.count} ({fmt.percentage}%)
                </span>
              </div>
            ))}
          </div>
        </GuidelineSection>

        {/* Stem Guidelines */}
        <GuidelineSection
          title="Question Stem Guidelines"
          sectionKey="stem_guidelines"
          expanded={expandedSections.has('stem_guidelines')}
          onToggle={toggleSection}
        >
          <div className="grid grid-cols-2 gap-3">
            <KVItem label="Style" value={guidelines.stem_guidelines?.style} />
            <KVItem label="Vignette Required" value={guidelines.stem_guidelines?.vignette_required ? 'Yes' : 'No'} />
            <KVItem label="Scenario Depth" value={guidelines.stem_guidelines?.scenario_depth ?? guidelines.stem_guidelines?.clinical_scenario_depth} />
            <KVItem label="Word Range" value={
              guidelines.stem_guidelines?.min_words && guidelines.stem_guidelines?.max_words
                ? `${guidelines.stem_guidelines.min_words}–${guidelines.stem_guidelines.max_words}`
                : guidelines.stem_guidelines?.max_words ? `Up to ${guidelines.stem_guidelines.max_words}` : 'No limit'
            } />
          </div>
        </GuidelineSection>

        {/* Distractor Guidelines */}
        <GuidelineSection
          title="Distractor Quality Rules"
          sectionKey="distractor_guidelines"
          expanded={expandedSections.has('distractor_guidelines')}
          onToggle={toggleSection}
        >
          <div className="space-y-3">
            <div>
              <div className="text-xs font-medium text-slate-500 mb-1">Homogeneity</div>
              <p className="text-sm text-slate-700">{guidelines.distractor_guidelines?.homogeneity}</p>
            </div>
            <div>
              <div className="text-xs font-medium text-slate-500 mb-1">Quality Rules</div>
              <ul className="space-y-1">
                {(guidelines.distractor_guidelines?.quality_rules || []).map((r, i) => (
                  <li key={i} className="text-sm text-slate-700 flex gap-2">
                    <span className="text-indigo-400 shrink-0">-</span>
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-xs font-medium text-slate-500 mb-1">Common Error Types to Use</div>
              <ul className="space-y-1">
                {(guidelines.distractor_guidelines?.common_errors_to_use || []).map((r, i) => (
                  <li key={i} className="text-sm text-slate-700 flex gap-2">
                    <span className="text-amber-400 shrink-0">-</span>
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </GuidelineSection>

        {/* Explanation Guidelines */}
        <GuidelineSection
          title="Explanation Guidelines"
          sectionKey="explanation_guidelines"
          expanded={expandedSections.has('explanation_guidelines')}
          onToggle={toggleSection}
        >
          <div className="grid grid-cols-2 gap-3">
            <KVItem label="Required" value={guidelines.explanation_guidelines?.required ? 'Yes' : 'No'} />
            <KVItem label="Min Sentences" value={guidelines.explanation_guidelines?.min_sentences} />
            <KVItem label="Must Justify Correct" value={guidelines.explanation_guidelines?.must_justify_correct ? 'Yes' : 'No'} />
            <KVItem label="Must Address Distractors" value={guidelines.explanation_guidelines?.must_address_distractors ? 'Yes' : 'No'} />
          </div>
        </GuidelineSection>

        {/* Difficulty & Blooms */}
        <GuidelineSection
          title="Difficulty & Bloom's Distribution"
          sectionKey="distributions"
          expanded={expandedSections.has('distributions')}
          onToggle={toggleSection}
        >
          <div className="grid grid-cols-2 gap-6">
            <div>
              <div className="text-xs font-medium text-slate-500 mb-2">Difficulty</div>
              {Object.entries(guidelines.difficulty_distribution || {}).map(([level, pct]) => (
                <div key={level} className="flex items-center justify-between text-sm py-1">
                  <span className="text-slate-700 capitalize">{level}</span>
                  <span className="font-mono text-slate-600">{pct}%</span>
                </div>
              ))}
            </div>
            <div>
              <div className="text-xs font-medium text-slate-500 mb-2">Bloom's Level</div>
              {Object.entries(guidelines.blooms_distribution || {}).map(([level, pct]) => (
                <div key={level} className="flex items-center justify-between text-sm py-1">
                  <span className="text-slate-700 capitalize">{level}</span>
                  <span className="font-mono text-slate-600">{pct}%</span>
                </div>
              ))}
            </div>
          </div>
        </GuidelineSection>

        {/* Image Guidelines */}
        <GuidelineSection
          title="Image Guidelines"
          sectionKey="image_guidelines"
          expanded={expandedSections.has('image_guidelines')}
          onToggle={toggleSection}
        >
          <div className="space-y-2">
            <KVItem label="Overall Image %" value={`${guidelines.image_guidelines?.percentage || 0}%`} />
            <KVItem label="When Required" value={guidelines.image_guidelines?.when_required} />
            <div className="text-xs font-medium text-slate-500 mt-2 mb-1">Image Types</div>
            <div className="flex flex-wrap gap-1.5">
              {(guidelines.image_guidelines?.types || []).map((t, i) => (
                <span key={i} className="text-xs px-2 py-0.5 bg-purple-100 text-purple-700 rounded-full">{t}</span>
              ))}
            </div>
          </div>
        </GuidelineSection>

        {/* Answer Key Balance */}
        <GuidelineSection
          title="Answer Key Balance"
          sectionKey="answer_key_balance"
          expanded={expandedSections.has('answer_key_balance')}
          onToggle={toggleSection}
        >
          <p className="text-sm text-slate-700">{guidelines.answer_key_balance}</p>
        </GuidelineSection>

        {/* Coverage Rules */}
        <GuidelineSection
          title="Coverage Rules"
          sectionKey="coverage_rules"
          expanded={expandedSections.has('coverage_rules')}
          onToggle={toggleSection}
        >
          <ul className="space-y-1.5">
            {(guidelines.coverage_rules || []).map((r, i) => (
              <li key={i} className="text-sm text-slate-700 flex gap-2">
                <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0 mt-0.5" />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </GuidelineSection>

        {/* Anti-patterns */}
        <GuidelineSection
          title="Anti-Patterns (What NOT to Do)"
          sectionKey="anti_patterns"
          expanded={expandedSections.has('anti_patterns')}
          onToggle={toggleSection}
        >
          <ul className="space-y-1.5">
            {(guidelines.anti_patterns || []).map((r, i) => (
              <li key={i} className="text-sm text-red-700 flex gap-2">
                <span className="text-red-400 shrink-0">-</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </GuidelineSection>

        {/* Custom Rules */}
        {(guidelines.custom_rules || []).length > 0 && (
          <GuidelineSection
            title="Exam-Specific Rules"
            sectionKey="custom_rules"
            expanded={expandedSections.has('custom_rules')}
            onToggle={toggleSection}
          >
            <ul className="space-y-1.5">
              {(guidelines.custom_rules || []).map((r, i) => (
                <li key={i} className="text-sm text-slate-700 flex gap-2">
                  <span className="text-indigo-400 shrink-0">-</span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </GuidelineSection>
        )}
      </div>

      {/* Chat refinement */}
      <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
          <h3 className="text-sm font-medium text-slate-700">Refine Guidelines</h3>
          <p className="text-xs text-slate-400 mt-0.5">Ask to modify any section — e.g., "increase SATA to 20%", "add rule about no negative stems"</p>
        </div>

        {chatMessages.length > 0 && (
          <div className="max-h-48 overflow-y-auto p-4 space-y-3">
            {chatMessages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] px-3 py-2 rounded-lg text-sm ${
                  msg.role === 'user'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-100 text-slate-700'
                }`}>
                  {msg.text}
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
        )}

        <div className="flex items-center gap-2 p-3 border-t border-slate-100">
          <input
            type="text"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleChatSend()}
            placeholder="e.g., Make 30% of questions image-based..."
            className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
            disabled={chatLoading}
          />
          <button
            onClick={handleChatSend}
            disabled={chatLoading || !chatInput.trim()}
            className="p-2 bg-indigo-600 text-white rounded-lg disabled:opacity-50 hover:bg-indigo-700"
          >
            {chatLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Approve button */}
      <div className="fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur border-t border-slate-200 px-6 py-4 z-50">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <p className="text-sm text-slate-500">
            {Object.keys(guidelines.subject_distribution || {}).length} subjects,{' '}
            {(guidelines.format_distribution || []).length} formats configured
          </p>
          <button
            onClick={handleApproveAndProceed}
            className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors shadow-lg"
          >
            Approve & Proceed to Generate
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Reusable section component ──

function GuidelineSection({
  title, sectionKey, expanded, onToggle, children,
}: {
  title: string;
  sectionKey: string;
  expanded: boolean;
  onToggle: (key: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <button
        onClick={() => onToggle(sectionKey)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50 transition-colors"
      >
        <span className="text-sm font-medium text-slate-700">{title}</span>
        {expanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>
      {expanded && <div className="px-4 pb-4 border-t border-slate-100 pt-3">{children}</div>}
    </div>
  );
}

function KVItem({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="p-2 bg-slate-50 rounded-lg">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-sm font-medium text-slate-700 mt-0.5">{String(value ?? '-')}</div>
    </div>
  );
}
