/**
 * Generic Question Renderer
 *
 * Renders any question format by inspecting content structure + display hints.
 * No hardcoded format logic — driven entirely by data.
 */

import { CheckCircle2 } from 'lucide-react';
import QuestionImage from './QuestionImage';
import type { Question, MediaItem } from '../../types';

interface Props {
  question: Question;
  showAnswer?: boolean;
  compact?: boolean;
}

// ── Helpers to extract content (flexible or legacy) ─────────

function getStem(q: Question): string {
  if (q.content?.stem) return q.content.stem as string;
  if (q.content?.case_narrative) return q.content.case_narrative as string;
  if (q.content?.assertion) return `Assertion: ${q.content.assertion}\nReason: ${q.content.reason}`;
  return q.question || '';
}

function getExplanation(q: Question): string | undefined {
  if (q.content?.explanation) return q.content.explanation as string;
  return q.explanation;
}

function getLayout(q: Question): string {
  return q.format?.display?.layout || detectLayout(q);
}

function detectLayout(q: Question): string {
  const c = q.content;
  if (!c) return 'stem_then_choices'; // legacy MCQ
  // Multi-format detection
  if (c.case_narrative || c.sub_questions) return 'case_with_sub_questions';
  if (c.blanks) return 'inline_dropdowns';
  if (c.row_headers && c.column_headers) return 'stem_then_grid';
  if (c.items && c.correct_order) return 'stem_then_sortable';
  if (c.items && c.option_list) return 'grouped_items';
  if (c.left && c.right) return 'two_column_match';
  if (c.assertion && c.reason) return 'assertion_block';
  if (c.answer && typeof (c.answer as Record<string, unknown>).value === 'boolean') return 'stem_then_boolean';
  if (c.stimulus) return 'stem_then_image_click'; // new hot_spot contract
  if (c.answer && (c.answer as Record<string, unknown>).region) return 'stem_then_image_click'; // legacy
  if (c.options) return 'stem_then_choices';
  if (c.answer && (c.answer as Record<string, unknown>).value !== undefined) return 'stem_then_input';
  if (c.answer && (c.answer as Record<string, unknown>).key_points) return 'stem_then_text';
  if (c.answer && (c.answer as Record<string, unknown>).text) return 'stem_then_input';
  return 'stem_then_text';
}

function getMedia(q: Question): MediaItem[] {
  if (q.media && q.media.length > 0) return q.media;
  if (q.image_url) return [{ type: q.image_type || 'image', url: q.image_url, description: q.image_description, source: q.image_source }];
  return [];
}

function getFormatLabel(q: Question): string {
  return q.format?.display?.compact_label || q.format?.slug || '';
}

// ── Option type from content ────────────────────────────────

interface ContentOption {
  key: string;
  text: string;
}

function getOptions(q: Question): ContentOption[] {
  // New format: content.options as array of {key, text}
  if (q.content?.options && Array.isArray(q.content.options)) {
    return q.content.options as ContentOption[];
  }
  // Legacy: options as Record<string, string>
  if (q.options && typeof q.options === 'object' && !Array.isArray(q.options)) {
    return Object.entries(q.options)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, text]) => ({ key, text }));
  }
  return [];
}

function getAnswerKeys(q: Question): string[] {
  const answer = q.content?.answer as Record<string, unknown> | undefined;
  if (answer?.key) return [answer.key as string];
  if (answer?.keys) return answer.keys as string[];
  if (q.correct_option) return [q.correct_option];
  return [];
}

// ── Layout Components ───────────────────────────────────────

function StemBlock({ stem, className }: { stem: string; className?: string }) {
  return <p className={`text-sm text-slate-700 whitespace-pre-wrap ${className || ''}`}>{stem}</p>;
}

function MediaBlock({ media }: { media: MediaItem[] }) {
  const validMedia = media.filter(m => m.url);
  if (validMedia.length === 0) return null;
  return (
    <div className="my-2 space-y-2">
      {validMedia.map((m, i) => (
        <div key={i}>
          <QuestionImage imageUrl={m.url} imageType={m.type} imageSource={m.source} />
          {m.description && <p className="text-xs text-teal-600 mt-1">{m.description}</p>}
        </div>
      ))}
    </div>
  );
}

function ChoicesBlock({ options, answerKeys, showAnswer }: { options: ContentOption[]; answerKeys: string[]; showAnswer: boolean }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 mt-2">
      {options.map((opt) => {
        const isCorrect = answerKeys.includes(opt.key);
        return (
          <div
            key={opt.key}
            className={`text-xs p-2 rounded flex items-start gap-1.5 ${
              showAnswer && isCorrect
                ? 'bg-green-100 border border-green-200 text-green-800 font-medium'
                : 'bg-white text-slate-600 border border-slate-100'
            }`}
          >
            <span className="font-semibold shrink-0">{opt.key}.</span>
            <span>{opt.text}</span>
            {showAnswer && isCorrect && <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0 ml-auto mt-0.5" />}
          </div>
        );
      })}
    </div>
  );
}

function BooleanAnswerBlock({ answer, showAnswer }: { answer: Record<string, unknown>; showAnswer: boolean }) {
  if (!showAnswer) return null;
  const value = answer.value as boolean;
  return (
    <div className="mt-2">
      <span className={`inline-block text-xs px-3 py-1.5 rounded-full font-semibold ${
        value ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
      }`}>
        {value ? 'TRUE' : 'FALSE'}
      </span>
    </div>
  );
}

function MatchBlock({ left, right, pairs, showAnswer }: {
  left: ContentOption[];
  right: ContentOption[];
  pairs?: Record<string, string>;
  showAnswer: boolean;
}) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-4">
      <div className="space-y-1.5">
        <div className="text-xs font-semibold text-slate-500 mb-1">Column A</div>
        {left.map((item) => (
          <div key={item.key} className="text-xs p-2 bg-blue-50 border border-blue-100 rounded">
            <span className="font-semibold">{item.key}.</span> {item.text}
            {showAnswer && pairs && (
              <span className="ml-2 text-blue-600 font-medium">→ {pairs[item.key]}</span>
            )}
          </div>
        ))}
      </div>
      <div className="space-y-1.5">
        <div className="text-xs font-semibold text-slate-500 mb-1">Column B</div>
        {right.map((item) => (
          <div key={item.key} className="text-xs p-2 bg-amber-50 border border-amber-100 rounded">
            <span className="font-semibold">{item.key}.</span> {item.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function AssertionBlock({ assertion, reason }: { assertion: string; reason: string }) {
  return (
    <div className="space-y-2 mt-1">
      <div className="text-xs p-2 bg-blue-50 border border-blue-100 rounded">
        <span className="font-semibold text-blue-700">Assertion:</span>{' '}
        <span className="text-slate-700">{assertion}</span>
      </div>
      <div className="text-xs p-2 bg-amber-50 border border-amber-100 rounded">
        <span className="font-semibold text-amber-700">Reason:</span>{' '}
        <span className="text-slate-700">{reason}</span>
      </div>
    </div>
  );
}

function GroupedItemsBlock({ theme, optionList, items, showAnswer }: {
  theme: string;
  optionList: ContentOption[];
  items: Array<{ stem: string; answer: { key: string } }>;
  showAnswer: boolean;
}) {
  return (
    <div className="mt-2 space-y-3">
      <div className="text-xs font-semibold text-slate-500">Theme: {theme}</div>
      <div className="p-2 bg-slate-50 rounded border border-slate-100">
        <div className="text-xs font-semibold text-slate-500 mb-1">Options:</div>
        <div className="grid grid-cols-2 gap-1">
          {optionList.map((opt) => (
            <div key={opt.key} className="text-xs text-slate-600">
              <span className="font-semibold">{opt.key}.</span> {opt.text}
            </div>
          ))}
        </div>
      </div>
      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className="text-xs p-2 bg-white border border-slate-100 rounded">
            <span className="font-semibold text-slate-400">Scenario {i + 1}:</span>{' '}
            <span className="text-slate-700">{item.stem}</span>
            {showAnswer && (
              <span className="ml-2 text-green-600 font-semibold">→ {item.answer.key}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SortableItemsBlock({ items, correctOrder, showAnswer }: {
  items: string[];
  correctOrder: number[];
  showAnswer: boolean;
}) {
  const displayItems = showAnswer && correctOrder.length > 0
    ? correctOrder.map((idx) => items[idx - 1] || items[idx] || `Item ${idx}`)
    : items;

  return (
    <div className="mt-2 space-y-1.5">
      <div className="text-xs font-semibold text-slate-500 mb-1">
        {showAnswer ? 'Correct Order:' : 'Items to arrange:'}
      </div>
      {displayItems.map((item, i) => (
        <div key={i} className={`text-xs p-2 rounded flex items-center gap-2 ${
          showAnswer ? 'bg-green-50 border border-green-100' : 'bg-white border border-slate-100'
        }`}>
          <span className={`font-semibold shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${
            showAnswer ? 'bg-green-200 text-green-800' : 'bg-slate-200 text-slate-600'
          }`}>{i + 1}</span>
          <span className="text-slate-700">{item}</span>
        </div>
      ))}
    </div>
  );
}

function HotSpotBlock({ content, showAnswer }: { content: Record<string, unknown>; showAnswer: boolean }) {
  const stimulus = content.stimulus as Record<string, unknown> | undefined;
  const answer = content.answer as Record<string, unknown> | undefined;
  const rationale = (content.rationale as Record<string, string>) || {};
  const scoring = content.scoring as string | undefined;

  // New contract: stimulus with targets/regions + answer.correct_ids
  if (stimulus) {
    const stimType = stimulus.type as string;
    const correctIds = (answer?.correct_ids as string[]) || [];
    const title = (stimulus.title as string) || '';

    if (stimType === 'text_targets') {
      const targets = (stimulus.targets as Array<{ id: string; text: string }>) || [];
      return (
        <div className="mt-2 space-y-1.5">
          {title && <div className="text-xs font-semibold text-slate-500 mb-1">{title}</div>}
          {scoring && <div className="text-[10px] text-slate-400 mb-1">Scoring: {scoring}</div>}
          {targets.map((t) => {
            const isCorrect = correctIds.includes(t.id);
            return (
              <div
                key={t.id}
                className={`text-xs p-2 rounded border cursor-default ${
                  showAnswer && isCorrect
                    ? 'bg-green-100 border-green-200 text-green-800 font-medium'
                    : 'bg-white border-slate-100 text-slate-600'
                }`}
              >
                <span className="font-semibold text-slate-400 mr-1.5">{t.id}</span>
                {t.text}
                {showAnswer && isCorrect && <CheckCircle2 className="w-3.5 h-3.5 text-green-600 inline ml-1.5" />}
                {showAnswer && rationale[t.id] && (
                  <p className="text-[10px] text-slate-400 mt-0.5 italic">{rationale[t.id]}</p>
                )}
              </div>
            );
          })}
        </div>
      );
    }

    if (stimType === 'image_regions') {
      const regions = (stimulus.regions as Array<{ id: string; shape: string; bbox: number[] }>) || [];
      if (!showAnswer) return null;
      return (
        <div className="mt-2 p-2 bg-green-50 border border-green-100 rounded">
          <div className="text-xs font-semibold text-green-700 mb-1">Correct Region(s):</div>
          {regions.map((r) => {
            const isCorrect = correctIds.includes(r.id);
            return (
              <div key={r.id} className={`text-xs ${isCorrect ? 'text-green-700 font-semibold' : 'text-slate-500'}`}>
                {r.id}{isCorrect ? ' ✓' : ''}
                {showAnswer && rationale[r.id] && (
                  <span className="font-normal text-slate-400 ml-1">— {rationale[r.id]}</span>
                )}
              </div>
            );
          })}
        </div>
      );
    }
  }

  // Legacy fallback: answer.region
  if (!showAnswer || !answer) return null;
  const region = answer?.region;
  let regionText = 'Not specified';
  if (typeof region === 'string') {
    regionText = region;
  } else if (region && typeof region === 'object') {
    const r = region as Record<string, unknown>;
    const parts = [r.label, r.landmark, r.quadrant_or_zone].filter(Boolean);
    regionText = parts.join(' — ') || 'Not specified';
  }
  return (
    <div className="mt-2 p-2 bg-green-50 border border-green-100 rounded">
      <div className="text-xs font-semibold text-green-700 mb-1">Correct Region:</div>
      <p className="text-xs text-slate-700">{regionText}</p>
    </div>
  );
}

function MatrixGridBlock({ rowHeaders, columnHeaders, correctCells, showAnswer }: {
  rowHeaders: string[];
  columnHeaders: string[];
  correctCells: Array<{ row: number; col: number }>;
  showAnswer: boolean;
}) {
  const isCorrect = (r: number, c: number) =>
    correctCells.some((cell) => cell.row === r && cell.col === c);

  return (
    <div className="mt-2 overflow-x-auto">
      <table className="text-xs border-collapse">
        <thead>
          <tr>
            <th className="p-1.5 border border-slate-200 bg-slate-50" />
            {columnHeaders.map((col, ci) => (
              <th key={ci} className="p-1.5 border border-slate-200 bg-slate-50 text-slate-600 font-semibold">{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowHeaders.map((row, ri) => (
            <tr key={ri}>
              <td className="p-1.5 border border-slate-200 bg-slate-50 font-semibold text-slate-600">{row}</td>
              {columnHeaders.map((_, ci) => {
                const correct = isCorrect(ri, ci);
                return (
                  <td key={ci} className={`p-1.5 border border-slate-200 text-center ${
                    showAnswer && correct ? 'bg-green-100 text-green-700 font-bold' : 'bg-white'
                  }`}>
                    {showAnswer && correct ? '✓' : ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClozeDropdownBlock({ stem, blanks, showAnswer }: {
  stem: string;
  blanks: Array<{ id: string; options: string[]; correct: string }>;
  showAnswer: boolean;
}) {
  return (
    <div className="mt-1">
      <StemBlock stem={stem} />
      <div className="mt-2 space-y-1.5">
        {blanks.map((blank, i) => (
          <div key={i} className="text-xs p-2 bg-white border border-slate-100 rounded">
            <span className="font-semibold text-slate-500">Blank {blank.id || i + 1}:</span>
            <span className="ml-2 text-slate-600">{(blank.options || []).join(' | ')}</span>
            {showAnswer && (
              <span className="ml-2 text-green-600 font-semibold">→ {blank.correct}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SubQuestionAnswer({ sq, showAnswer }: { sq: Record<string, unknown>; showAnswer: boolean }) {
  const formatType = (sq.format_type as string) || '';
  const rawOptions = sq.options as Array<string | { key: string; text: string }> | undefined;
  const answer = sq.answer as Record<string, unknown> | undefined;
  const correctAnswer = (sq.correct_answer as string) || (answer?.key as string) || '';
  const correctAnswers = (sq.correct_answers as string[]) || (correctAnswer ? [correctAnswer] : []);

  // Normalize options
  const parsedOptions = rawOptions?.map((opt) => {
    if (typeof opt === 'string') {
      const m = opt.match(/^([A-H])\.\s*/);
      if (m) return { key: m[1], text: opt.substring(m[0].length) };
      return { key: '', text: opt };
    }
    return opt;
  });

  // Ordered response
  if (formatType === 'ordered_response') {
    const items = (sq.items as string[]) || [];
    const correctOrder = (sq.correct_order as number[]) || (answer?.correct_order as number[]) || [];
    const displayItems = showAnswer && correctOrder.length > 0
      ? correctOrder.map((idx) => items[idx - 1] || items[idx] || `Item ${idx}`)
      : items;
    return (
      <div className="mt-1 space-y-1 ml-2">
        <div className="text-[10px] font-semibold text-slate-400">
          {showAnswer ? 'Correct Order:' : 'Items to arrange:'}
        </div>
        {displayItems.map((item, i) => (
          <div key={i} className={`flex items-center gap-1.5 ${showAnswer ? 'text-green-700' : 'text-slate-600'}`}>
            <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-semibold ${
              showAnswer ? 'bg-green-200 text-green-800' : 'bg-slate-200 text-slate-600'
            }`}>{i + 1}</span>
            <span>{item}</span>
          </div>
        ))}
      </div>
    );
  }

  // Hot spot — new stimulus contract
  if (formatType === 'hot_spot') {
    const stimulus = sq.stimulus as Record<string, unknown> | undefined;
    const correctIds = (answer?.correct_ids as string[]) || (sq.correct_ids as string[]) || [];
    const sqRationale = (sq.rationale as Record<string, string>) || {};

    // New contract with stimulus.targets
    if (stimulus && stimulus.type === 'text_targets') {
      const targets = (stimulus.targets as Array<{ id: string; text: string }>) || [];
      return (
        <div className="mt-1 space-y-0.5 ml-2">
          {targets.map((t) => {
            const isCorrect = correctIds.includes(t.id);
            return (
              <div key={t.id} className={`text-xs ${showAnswer && isCorrect ? 'text-green-700 font-semibold' : 'text-slate-600'}`}>
                <span className="text-slate-400 mr-1">{t.id}</span> {t.text}
                {showAnswer && isCorrect && ' ✓'}
              </div>
            );
          })}
          {showAnswer && Object.keys(sqRationale).length > 0 && (
            <div className="mt-1 text-[10px] text-slate-400 italic">
              {correctIds.map(id => sqRationale[id]).filter(Boolean).join('; ')}
            </div>
          )}
        </div>
      );
    }

    // Legacy fallback: answer.region
    if (!showAnswer || !answer) return null;
    const region = answer.region;
    let regionText = 'Not specified';
    if (typeof region === 'string') {
      regionText = region;
    } else if (region && typeof region === 'object') {
      const r = region as Record<string, unknown>;
      const parts = [r.label, r.landmark, r.quadrant_or_zone].filter(Boolean);
      regionText = parts.join(' — ') || 'Not specified';
    }
    return (
      <div className="mt-1 ml-2 p-1.5 bg-green-50 border border-green-100 rounded">
        <span className="font-semibold text-green-700">Region: </span>
        <span className="text-slate-700">{regionText}</span>
      </div>
    );
  }

  // Fill blank
  if (formatType === 'fill_blank') {
    if (!showAnswer || !answer) return null;
    const value = answer.value as string | undefined;
    const unit = answer.unit as string | undefined;
    const text = value ? `${value}${unit ? ` ${unit}` : ''}` : (answer.text as string) || '';
    return (
      <div className="mt-1 ml-2 p-1.5 bg-green-50 border border-green-100 rounded">
        <span className="font-semibold text-green-700">Answer: </span>
        <span className="text-slate-700">{text}</span>
      </div>
    );
  }

  // Cloze dropdown
  if (formatType === 'cloze_dropdown') {
    const blanks = (sq.blanks as Array<{ id: string; options: string[]; correct: string }>) || [];
    if (blanks.length === 0) return null;
    return (
      <div className="mt-1 space-y-1 ml-2">
        {blanks.map((blank, bi) => (
          <div key={bi} className="p-1.5 bg-white border border-slate-100 rounded">
            <span className="font-semibold text-slate-500">Blank {blank.id || bi + 1}:</span>
            <span className="ml-1 text-slate-600">{(blank.options || []).join(' | ')}</span>
            {showAnswer && <span className="ml-1 text-green-600 font-semibold">→ {blank.correct}</span>}
          </div>
        ))}
      </div>
    );
  }

  // Matrix grid
  if (formatType === 'matrix_grid') {
    const rowHeaders = (sq.row_headers as string[]) || [];
    const columnHeaders = (sq.column_headers as string[]) || [];
    const correctCells = (sq.correct_cells as Array<{ row: number; col: number }>) || (answer?.correct_cells as Array<{ row: number; col: number }>) || [];
    if (rowHeaders.length === 0) return null;
    const isCorrect = (r: number, c: number) => correctCells.some((cell) => cell.row === r && cell.col === c);
    return (
      <div className="mt-1 ml-2 overflow-x-auto">
        <table className="text-[10px] border-collapse">
          <thead>
            <tr>
              <th className="p-1 border border-slate-200 bg-slate-50" />
              {columnHeaders.map((col, ci) => (
                <th key={ci} className="p-1 border border-slate-200 bg-slate-50 text-slate-600">{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowHeaders.map((row, ri) => (
              <tr key={ri}>
                <td className="p-1 border border-slate-200 bg-slate-50 font-semibold text-slate-600">{row}</td>
                {columnHeaders.map((_, ci) => (
                  <td key={ci} className={`p-1 border border-slate-200 text-center ${
                    showAnswer && isCorrect(ri, ci) ? 'bg-green-100 text-green-700 font-bold' : 'bg-white'
                  }`}>
                    {showAnswer && isCorrect(ri, ci) ? '✓' : ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // Default: MCQ / SATA with options
  if (parsedOptions && parsedOptions.length > 0) {
    return (
      <div className="space-y-0.5 ml-2">
        {parsedOptions.map((opt, oi) => {
          const isCorrect = correctAnswers.includes(opt.key);
          return (
            <div key={opt.key || oi} className={showAnswer && isCorrect
              ? 'text-green-700 font-semibold'
              : 'text-slate-600'
            }>
              {opt.key ? `${opt.key}. ` : ''}{opt.text}
              {showAnswer && isCorrect && ' ✓'}
            </div>
          );
        })}
      </div>
    );
  }

  // Fallback: show raw answer if available
  if (showAnswer && answer) {
    const text = answer.text || answer.value || answer.key;
    if (text) return <div className="mt-1 ml-2 text-green-700 font-semibold">Answer: {String(text)}</div>;
  }

  return null;
}

function CaseStudyBlock({ narrative, subQuestions, showAnswer }: {
  narrative: string;
  subQuestions: Array<Record<string, unknown>>;
  showAnswer: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="text-xs p-3 bg-blue-50 border border-blue-100 rounded">
        <div className="font-semibold text-blue-700 mb-1">Case Narrative:</div>
        <p className="text-slate-700 whitespace-pre-wrap">{narrative}</p>
      </div>
      {subQuestions.map((sq, i) => {
        const sqStem = (sq.stem as string) || (sq.question as string) || '';
        const formatType = (sq.format_type as string) || '';
        const rationale = (sq.rationale as string) || '';
        const cjmmStep = (sq.cjmm_step as string) || '';

        return (
          <div key={i} className="text-xs p-2 bg-white border border-slate-100 rounded">
            <div className="font-semibold text-slate-500 mb-1">
              Sub-question {i + 1}:
              {formatType && <span className="ml-1 font-normal text-slate-400">({formatType})</span>}
              {cjmmStep && <span className="ml-1 font-normal text-purple-400 text-[10px]">[{cjmmStep}]</span>}
            </div>
            <p className="text-slate-700 mb-1">{sqStem}</p>
            <SubQuestionAnswer sq={sq} showAnswer={showAnswer} />
            {showAnswer && rationale && (
              <p className="text-[10px] text-slate-400 mt-1.5 italic">{rationale}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TextAnswerBlock({ answer, showAnswer }: { answer: Record<string, unknown>; showAnswer: boolean }) {
  if (!showAnswer) return null;
  // Fill-blank format: value + unit
  const value = answer.value as string | undefined;
  const unit = answer.unit as string | undefined;
  const acceptableRange = answer.acceptable_range as string | undefined;
  const text = value ? `${value}${unit ? ` ${unit}` : ''}` : (answer.text as string);
  const keyPoints = answer.key_points as string[] | undefined;
  const alternatives = answer.alternatives as string[] | undefined;

  return (
    <div className="mt-2 p-2 bg-green-50 border border-green-100 rounded">
      <div className="text-xs font-semibold text-green-700 mb-1">Answer:</div>
      <p className="text-xs text-slate-700">{text}</p>
      {acceptableRange && (
        <p className="text-xs text-slate-500 mt-0.5">Acceptable range: {acceptableRange}</p>
      )}
      {keyPoints && keyPoints.length > 0 && (
        <div className="mt-1.5">
          <div className="text-xs font-semibold text-green-600">Key Points:</div>
          <ul className="text-xs text-slate-600 list-disc list-inside">
            {keyPoints.map((kp, i) => <li key={i}>{kp}</li>)}
          </ul>
        </div>
      )}
      {alternatives && alternatives.length > 0 && (
        <div className="text-xs text-slate-400 mt-1">
          Also accepted: {alternatives.join(', ')}
        </div>
      )}
    </div>
  );
}

// ── Main Renderer ───────────────────────────────────────────

export default function QuestionRenderer({ question: q, showAnswer = true, compact = false }: Props) {
  const layout = getLayout(q);
  const stem = getStem(q);
  const explanation = getExplanation(q);
  const media = getMedia(q);
  const formatLabel = getFormatLabel(q);
  const content = q.content || {};
  const answer = content.answer as Record<string, unknown> | undefined;

  return (
    <div className={compact ? '' : 'space-y-2'}>
      {/* Format badge */}
      {formatLabel && !compact && (
        <span className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 font-medium">
          {formatLabel}
        </span>
      )}

      {/* Media (before stem for image-based questions) */}
      <MediaBlock media={media} />

      {/* Layout-specific rendering */}
      {layout === 'case_with_sub_questions' ? (
        <CaseStudyBlock
          narrative={(content.case_narrative as string) || stem}
          subQuestions={(content.sub_questions as Array<Record<string, unknown>>) || []}
          showAnswer={showAnswer}
        />
      ) : layout === 'inline_dropdowns' && content.blanks ? (
        <ClozeDropdownBlock
          stem={stem}
          blanks={content.blanks as Array<{ id: string; options: string[]; correct: string }>}
          showAnswer={showAnswer}
        />
      ) : layout === 'stem_then_grid' ? (
        <>
          <StemBlock stem={stem} />
          <MatrixGridBlock
            rowHeaders={(content.row_headers as string[]) || []}
            columnHeaders={(content.column_headers as string[]) || []}
            correctCells={(content.correct_cells as Array<{ row: number; col: number }>) || []}
            showAnswer={showAnswer}
          />
        </>
      ) : layout === 'stem_then_sortable' ? (
        <>
          <StemBlock stem={stem} />
          <SortableItemsBlock
            items={(content.items as string[]) || []}
            correctOrder={(content.correct_order as number[]) || []}
            showAnswer={showAnswer}
          />
        </>
      ) : layout === 'stem_then_image_click' ? (
        <>
          <StemBlock stem={stem} />
          <HotSpotBlock content={content} showAnswer={showAnswer} />
        </>
      ) : layout === 'assertion_block' && content.assertion ? (
        <>
          <AssertionBlock assertion={content.assertion as string} reason={content.reason as string} />
          <ChoicesBlock options={getOptions(q)} answerKeys={getAnswerKeys(q)} showAnswer={showAnswer} />
        </>
      ) : layout === 'two_column_match' && content.left ? (
        <>
          <StemBlock stem={stem} />
          <MatchBlock
            left={content.left as ContentOption[]}
            right={content.right as ContentOption[]}
            pairs={showAnswer ? (answer?.pairs as Record<string, string>) : undefined}
            showAnswer={showAnswer}
          />
        </>
      ) : layout === 'grouped_items' && content.items ? (
        <GroupedItemsBlock
          theme={content.theme as string || ''}
          optionList={content.option_list as ContentOption[] || []}
          items={content.items as Array<{ stem: string; answer: { key: string } }>}
          showAnswer={showAnswer}
        />
      ) : layout === 'stem_then_boolean' && answer ? (
        <>
          <StemBlock stem={stem} />
          <BooleanAnswerBlock answer={answer} showAnswer={showAnswer} />
        </>
      ) : layout === 'stem_then_input' || layout === 'stem_then_text' ? (
        <>
          <StemBlock stem={stem} />
          {showAnswer && answer && <TextAnswerBlock answer={answer} showAnswer={showAnswer} />}
        </>
      ) : (
        /* Default: stem_then_choices (MCQ and similar) */
        <>
          <StemBlock stem={stem} />
          <ChoicesBlock options={getOptions(q)} answerKeys={getAnswerKeys(q)} showAnswer={showAnswer} />
        </>
      )}

      {/* Explanation */}
      {showAnswer && explanation && !compact && (
        <p className="text-xs text-slate-500 mt-2 bg-white p-2 rounded border border-slate-100">{explanation}</p>
      )}
    </div>
  );
}

/**
 * Utility: extract stem text for display in compact lists (truncated).
 * Works with both legacy and flexible format questions.
 */
export function getQuestionPreview(q: Question, maxLen = 120): string {
  const stem = getStem(q);
  return stem.length > maxLen ? stem.slice(0, maxLen) + '...' : stem;
}

/**
 * Utility: get subject/topic from tags or legacy columns.
 */
export function getQuestionSubject(q: Question): string {
  return (q.tags?.subject as string) || q.subject || '';
}

export function getQuestionTopic(q: Question): string {
  return (q.tags?.topic as string) || q.topic || '';
}

export function hasMedia(q: Question): boolean {
  return getMedia(q).length > 0;
}
