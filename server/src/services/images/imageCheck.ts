/**
 * Does a generated image show what its question's answer depends on? Read blind, then compared.
 *
 * Reviewers see an image beside its stem, key and specification, and confirm the text instead of
 * reading the picture: in a USMLE Step 3 pilot both AI-drawn ECGs were approved by every stage ("the
 * ECG supports the keyed diagnosis") though one meant as WPW showed narrow QRS with no delta waves and
 * one meant as STEMI showed no ST elevation. Shown the image ALONE, the same model read them as atrial
 * flutter and as a WPW pattern — wrong readings, but both disagreed with the key, which is what a check
 * needs to see. So the read gets only the picture and its modality, and a second, text-only call
 * compares that read with what the question needs.
 */
import { orCall, MODELS } from '../llm/openrouter.js';

export interface ImageCheck {
  pass: boolean;
  /** What the blind reader saw. */
  read: string;
  /** Findings the answer depends on that the read did not show (or contradicted). */
  missing: string[];
  url?: string;
  checked_at: string;
}

const READ_PROMPT: Array<[RegExp, string]> = [
  [/\becg\b|\bekg\b|electrocardiogra|rhythm strip|telemetry/i,
    'You are a cardiologist reading an exam ECG with no clinical history. Read ONLY what is visible. Report rhythm; rate; P waves and their relation to QRS; PR interval (short/normal/long); QRS width and morphology (delta waves, bundle-branch pattern); ST segments lead by lead (elevation or depression and where); T waves; QT; and your single best interpretation. If a feature is not visible, say so.'],
  [/echo|ultraso|sonogra|doppler/i,
    'You are a cardiologist/sonographer reading an exam ultrasound with no clinical history. Read ONLY what is visible. Name each view; describe chamber sizes, wall thickness and motion, valves, any defect, effusion or mass, and any color-Doppler jet (where it arises and where it goes). Give your single best interpretation. If a feature is not visible, say so.'],
  [/radiograph|x-?ray|\bcxr\b|\bct\b|computed tomograph|\bmri\b|angiogra|mammogra|\bpet\b|scan\b/i,
    'You are a radiologist reading an exam image with no clinical history. Read ONLY what is visible. Name the modality and view/plane; describe every abnormal finding with its side, location, size and character, and relevant normal findings; give your single best interpretation. If a feature is not visible, say so.'],
  [/photo|skin|dermat|rash|lesion|wound|fundus|fundoscop|ophthalmoscop|otoscop|endoscop|colonoscop/i,
    'You are a clinician reading an exam clinical photograph with no history. Read ONLY what is visible: site, morphology, color, distribution, borders, and any other finding; give your single best interpretation. If a feature is not visible, say so.'],
  [/histolog|patholog|biopsy|smear|slide|stain/i,
    'You are a pathologist reading an exam slide with no history. Read ONLY what is visible: tissue, architecture, cells, stain features; give your single best interpretation. If a feature is not visible, say so.'],
];
const READ_DEFAULT = 'You are an expert examiner reading an exam figure with no question attached. Describe exactly what it shows — every label, axis, value, series, structure or finding that is visible — and what conclusion a reader would draw from it. If something is not visible, say so.';

export function readPromptFor(imageType: string): string {
  return READ_PROMPT.find(([re]) => re.test(imageType))?.[1] ?? READ_DEFAULT;
}

function keyText(q: Record<string, unknown>): string {
  const o = (q.options || {}) as Record<string, string>;
  const k = String(q.correct_option ?? '');
  return o[k] ? `${k}. ${o[k]}` : k;
}

/** Read the image with no context, then judge whether that read supports what the question needs. */
export async function checkImage(q: Record<string, unknown>, imageBytes: Buffer, mimeType = 'image/png'): Promise<ImageCheck> {
  const imageType = String(q.image_type || '');
  const dataUrl = `data:${mimeType};base64,${imageBytes.toString('base64')}`;
  const read = (await orCall(MODELS.VALIDATOR, '', [
    { type: 'text', text: readPromptFor(imageType) },
    { type: 'image_url', image_url: { url: dataUrl } },
  ], { maxTokens: 1500 })).content.trim();

  const verdict = await orCall(MODELS.VALIDATOR, '', `An exam question depends on an image. An expert read the image WITHOUT seeing the question. Decide whether the image, as read, shows what a candidate needs to reach the keyed answer.

QUESTION: ${String(q.question || '').slice(0, 2500)}
KEYED ANSWER: ${keyText(q)}
THE IMAGE WAS MEANT TO SHOW: ${String(q.image_description || '').slice(0, 1500)}

BLIND READ OF THE IMAGE:
${read.slice(0, 3000)}

Judge only the findings the keyed answer depends on (the diagnostic feature, the value read off a chart, the side or location that decides it). Ignore drawing style and incidental detail. A blind reader may name the condition differently; what matters is whether the decisive findings are present and nothing visible contradicts the key. Fail if a decisive finding is absent or contradicted, or if the read supports a different answer option better than the key.

Return JSON only: {"pass": true|false, "missing": ["each decisive finding the read did not show or contradicted, phrased as what the image must show"]}`, { maxTokens: 800, jsonMode: true }).then((r) => r.content);

  let pass = false, missing: string[] = [];
  try {
    const m = verdict.match(/\{[\s\S]*\}/);
    const v = JSON.parse(m ? m[0] : verdict);
    pass = v.pass === true;
    missing = Array.isArray(v.missing) ? v.missing.map(String).filter(Boolean) : [];
  } catch {
    missing = ['image check returned no verdict'];
  }
  return { pass, read, missing: pass ? [] : missing, checked_at: new Date().toISOString() };
}

/** Correction for the next attempt at a figure that failed the check. */
export function imageCheckFix(c: ImageCheck): string {
  return `A reader who saw only the previous image read it as: "${c.read.replace(/\s+/g, ' ').slice(0, 600)}". That is not what the question needs. The new image MUST clearly show: ${c.missing.join('; ')}. Make these decisive findings unmistakable, as in a textbook example of the condition.`;
}
