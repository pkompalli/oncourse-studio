/**
 * Write the specification an exam image is drawn from, from the question itself.
 *
 * The image model draws what it is told. Generated items carry an image_description written by the
 * model that wrote the question; imported items do not: of 2,601 live NEET PG image items, 770 had no
 * description at all and none had an image type, so a redraw was prompted with little more than the
 * stem — "Which structure is held by forceps?". A quarter of them ask about a marked structure ("the
 * foramen marked X", "structure A"), and a drawing whose arrow lands on the wrong structure, or whose
 * labels name the answer, is worse than no image.
 *
 * The specification is written by a text model holding the stem, every option, the key and the
 * explanation, so it can name the decisive findings, where each marker must point, and what must
 * never appear. A blind read of the image being replaced (imageCheck.ts) is passed in when there is
 * one, so the writer knows what the old picture got wrong.
 */
import { orCall, MODELS } from '../llm/openrouter.js';

type Row = Record<string, unknown>;

export interface ImageSpec {
  /** Modality and view, e.g. "H&E photomicrograph, high power", "PA chest radiograph", "anatomical illustration, lateral view". */
  image_type: string;
  /** What the picture shows, decisive findings first, written to be drawn. */
  image_description: string;
  /** Every marker the stem refers to, and exactly what it must point at. */
  markers: Array<{ label: string; target: string }>;
  /** Text and features that must not appear (answer names, distractor names, captions). */
  must_not_show: string[];
  /** False when the question can be answered without the picture (the stem states the findings). */
  image_needed: boolean;
  /** Why the image is or is not needed, one sentence. */
  needed_reason: string;
}


function optionsOf(q: Row): string {
  const o = (q.options || {}) as Record<string, string>;
  const k = String(q.correct_option ?? '');
  return Object.keys(o).sort().map((L) => `${L}. ${o[L]}${L === k ? '   ← correct' : ''}`).join('\n');
}

export async function specifyImage(q: Row, opts: { course?: string; feedback?: string[]; previousRead?: string } = {}): Promise<ImageSpec | null> {
  const course = opts.course || String(q.course || 'the exam');
  const prompt = `You write the specification an illustrator uses to draw the image for a ${course} exam question. The image is part of the question: the candidate must read it to answer.

QUESTION: ${String(q.question || '').slice(0, 2500)}
OPTIONS:
${optionsOf(q)}
EXPLANATION: ${String(q.explanation || '').replace(/\s+/g, ' ').slice(0, 2500)}
${q.image_description ? `EXISTING DESCRIPTION OF THE IMAGE (may be wrong or incomplete): ${String(q.image_description).slice(0, 1500)}\n` : ''}${opts.previousRead ? `WHAT AN EXPERT SAW IN THE IMAGE BEING REPLACED (read without the question): ${opts.previousRead.replace(/\s+/g, ' ').slice(0, 1500)}\n` : ''}${opts.feedback?.length ? `PROBLEMS REVIEW FOUND WITH THE CURRENT IMAGE:\n${opts.feedback.map((f) => `- ${f}`).join('\n')}\n` : ''}
Write the specification:
• image_type: the modality and view exactly as a real exam would show it — e.g. "H&E photomicrograph, high power", "PA chest radiograph", "axial non-contrast CT head", "clinical photograph of the face", "fundus photograph", "12-lead ECG", "anatomical illustration (textbook line drawing), lateral view of the left hip bone", "photograph of a surgical instrument".
• image_description: what the picture shows, written to be DRAWN. Lead with the findings that decide the correct answer, described as a textbook example of it (location, side, size, colour, texture, pattern, number). Add what the picture must show so that each wrong option is ruled out. Anatomy: the region, the view, and the structures that must be visible around the target so it can be identified. Never write the diagnosis or the answer as text to appear in the image; describe what is seen.
• markers: a marker's "label" is exactly the token printed on the image — a single letter, number or short code as the stem uses it ("A", "X", "3"); for a plain arrow with no letter, use "arrow". If the stem refers to marked items (an arrow, "X", "Y", "A–D", "structure marked", "labelled"), list every marker with exactly what it points at. If the options are themselves labels ("Structure A", "B"), give each label its own structure, and the correct one must point at the structure the question asks for. Empty if the stem refers to no marker.
• must_not_show: text or features that would give the answer away or contradict it — the name of the correct answer and of each distractor, captions, titles, explanatory labels.
• image_needed: true if the candidate must read the image to answer; false if the stem already states every finding the answer needs, so the image is decoration. needed_reason: one sentence.

Return JSON only: {"image_type": "...", "image_description": "...", "markers": [{"label": "X", "target": "..."}], "must_not_show": ["..."], "image_needed": true, "needed_reason": "..."}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await orCall(MODELS.VALIDATOR, '', prompt, { maxTokens: 2000, jsonMode: true, temperature: 0.2 });
      const m = r.content.match(/\{[\s\S]*\}/);
      const v = JSON.parse(m ? m[0] : r.content);
      if (!v.image_type || !v.image_description) continue;
      return {
        image_type: String(v.image_type),
        image_description: String(v.image_description),
        markers: Array.isArray(v.markers) ? v.markers.filter((x: Row) => x && x.label && x.target).map((x: Row) => ({ label: String(x.label), target: String(x.target) })) : [],
        must_not_show: Array.isArray(v.must_not_show) ? v.must_not_show.map(String) : [],
        image_needed: v.image_needed !== false,
        needed_reason: String(v.needed_reason || ''),
      };
    } catch { /* one more attempt */ }
  }
  return null;
}

/** The specification as the fields buildImagePrompt and checkImage read. */
/** A marker label as it may be printed: a short token, or none for a plain arrow ("red arrow" was printed as words). */
export function markerToken(label: string): string | null {
  const t = label.trim().replace(/^["'(]+|["')]+$/g, '');
  return /^[A-Za-z0-9]{1,3}$/.test(t) && !/^(arrow|red|the)$/i.test(t) ? t : null;
}

export function applySpec(q: Row, s: ImageSpec): Row {
  s = { ...s, markers: s.markers.map((m) => ({ label: markerToken(m.label) ?? 'arrow', target: m.target })) };
  const markers = s.markers.length
    ? `\nMARKERS (draw each as a short arrow or leader line ending exactly on its target; print only the marker letter, and nothing at all for a plain arrow): ${s.markers.map((m) => (m.label === 'arrow' ? `a plain arrow → ${m.target}` : `"${m.label}" → ${m.target}`)).join('; ')}.`
    : '';
  const banned = s.must_not_show.length ? `\nMUST NOT APPEAR anywhere in the image: ${s.must_not_show.join('; ')}.` : '';
  return { ...q, image_type: s.image_type, image_description: `${s.image_description}${markers}${banned}`, image_markers: s.markers };
}

