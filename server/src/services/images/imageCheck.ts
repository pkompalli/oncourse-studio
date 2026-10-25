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
  /** Majority vote (checkImageVoted): e.g. "2/2 pass", "2/3 fail". */
  votes?: string;
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
// Marked figures are a quarter of NEET PG image items; what each marker touches is the whole question.
const READ_MARKED = 'You are an anatomist, radiologist and pathologist reading an exam figure with no question attached. First name the region, view and modality, and describe every abnormal finding with its location and character. Then, for EVERY arrow, letter, number or other marker (not a side marker such as R or L), name exactly the structure its tip touches (not what it is near). Then copy out every piece of text visible in the image, word for word. If a marker is ambiguous or touches nothing identifiable, say so.';

/**
 * Does the stem point at a marker? "\bX\b" alone matched the X of "X-ray", so every radiograph item was
 * read with the marker prompt, which described the markers and none of the findings: a classic
 * punched-out myeloma skull failed its check twice with the lesions plainly visible.
 */
export function stemRefersToMarker(stem: string): boolean {
  return /\b(marked|arrows?|arrowheads?|label(l)?ed|labels?|pointer|asterisk)\b|\b(structure|part|area|point|region|muscle|nerve|bone|vessel)s? [A-H]\b|\b[XYZ]\b(?!-?\s?rays?)/i.test(stem.replace(/\bX-?\s?rays?\b/gi, 'radiograph'));
}
const READ_DEFAULT = 'You are an expert examiner reading an exam figure with no question attached. Describe exactly what it shows — every label, axis, value, series, structure or finding that is visible — and what conclusion a reader would draw from it. If something is not visible, say so.';

export function readPromptFor(imageType: string, marked = false): string {
  const base = marked ? READ_MARKED : READ_PROMPT.find(([re]) => re.test(imageType))?.[1] ?? READ_DEFAULT;
  // A single "best interpretation" names the overall impression and drops a classic sign the image does
  // show (a snowman silhouette read as cardiomegaly, a spherocyte field as macrocytic); three ranked
  // interpretations keep it in view, still without the reader seeing the question.
  const ranked = ' Then give your top three interpretations, most likely first, each with the visible finding it rests on.';
  return marked ? `${base}${ranked}` : `${base}${ranked} Finally, copy out every piece of text visible in the image, word for word (none if there is none).`;
}

function keyText(q: Record<string, unknown>): string {
  const o = (q.options || {}) as Record<string, string>;
  const k = String(q.correct_option ?? '');
  return o[k] ? `${k}. ${o[k]}` : k;
}

/** Read the image with no context, then judge whether that read supports what the question needs. */
export async function checkImage(q: Record<string, unknown>, imageBytes: Buffer, mimeType = 'image/png'): Promise<ImageCheck> {
  const imageType = String(q.image_type || '');
  const markers = (Array.isArray(q.image_markers) ? q.image_markers : []) as Array<{ label: string; target: string }>;
  const dataUrl = `data:${mimeType};base64,${imageBytes.toString('base64')}`;
  const read = (await orCall(MODELS.VALIDATOR, '', [
    { type: 'text', text: readPromptFor(imageType, markers.length > 0 || stemRefersToMarker(String(q.question || ''))) },
    { type: 'image_url', image_url: { url: dataUrl } },
  ], { maxTokens: 1500 })).content.trim();

  const verdict = await orCall(MODELS.VALIDATOR, '', `An exam question depends on an image. An expert read the image WITHOUT seeing the question. Decide whether the image, as read, shows what a candidate needs to reach the keyed answer.

QUESTION: ${String(q.question || '').slice(0, 2500)}
KEYED ANSWER: ${keyText(q)}
THE IMAGE WAS MEANT TO SHOW: ${String(q.image_description || '').slice(0, 1500)}
${markers.length ? `EACH MARKER MUST POINT AT: ${markers.map((m) => `"${m.label}" → ${m.target}`).join('; ')}\n` : ''}OPTIONS: ${Object.entries((q.options || {}) as Record<string, string>).map(([k, v]) => `${k}. ${v}`).join(' | ')}

BLIND READ OF THE IMAGE:
${read.slice(0, 3000)}

Judge only the findings the keyed answer depends on (the diagnostic feature, the value read off a chart, the side or location that decides it). Ignore drawing style and incidental detail. A blind reader may name the condition differently; what matters is whether the decisive findings are present and nothing visible contradicts the key. The reader gives three ranked interpretations: the image passes when the key (or the finding it rests on) is among them, the decisive findings are described, and the reading does not rest on findings that contradict the key — not only when the key is ranked first. Fail if a decisive finding is absent or contradicted, or if the read supports a different answer option better than the key. Also fail if:
- a marker the question relies on touches a different structure from the one it must point at, or is missing;
- any text visible in the image names the correct answer or a wrong option, or captions the finding (marker letters, lead names, side markers and scale bars are fine).

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
  // A second, finding-by-finding look at the image (findings the key needs shuffled with decoys) was
  // tried for blind reads that miss a drawn sign, and removed: on its test it still failed a correct
  // snowman film and PASSED an ankle drawing whose arrow marked the anterior tibial artery for a
  // posterior-tibial key. Shown the findings beside the image, the reader agrees with them.
  return { pass, read, missing: pass ? [] : missing, checked_at: new Date().toISOString() };
}

/** Correction for the next attempt at a figure that failed the check. */
export function imageCheckFix(c: ImageCheck): string {
  return `A reader who saw only the previous image read it as: "${c.read.replace(/\s+/g, ' ').slice(0, 600)}". That is not what the question needs. The new image MUST clearly show: ${c.missing.join('; ')}. Make these decisive findings unmistakable, as in a textbook example of the condition.`;
}

/**
 * The blind check for an image the item already has (an imported live-bank image, or one drawn
 * earlier). The image type is rarely recorded for those, so the reading prompt is chosen from the
 * description and stem.
 */
export async function checkExistingImage(q: Record<string, unknown>): Promise<ImageCheck | null> {
  const url = String(q.image_url || '');
  if (!url) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get('content-type') || (/\.png$/i.test(url) ? 'image/png' : 'image/jpeg');
  const imageType = String(q.image_type || '') || `${String(q.image_description || '').slice(0, 300)} ${String(q.question || '')}`;
  return checkImageVoted({ ...q, image_type: imageType }, bytes, mime);
}

/** The change request for an image whose blind read does not support the key: replace it, saying why. */
export function blindImageIssue(c: ImageCheck): string {
  return `[IMAGE_INTEGRAL] Replace the image with one that clearly shows: ${c.missing.join('; ')}. Read without the question, the current image shows: "${c.read.replace(/\s+/g, ' ').slice(0, 500)}".`;
}

/**
 * The blind check by majority. One read is noisy: re-reading the same 34 saved images flipped 7
 * verdicts, failing a correct spherocyte smear one time and passing it the next. Two independent reads;
 * a third only when they disagree. A read the proxy drops is replaced, up to five calls in all; with no
 * verdict at all it throws, as checkImage does, so the caller's retry applies.
 */
export async function checkImageVoted(q: Record<string, unknown>, imageBytes: Buffer, mimeType = 'image/png'): Promise<ImageCheck> {
  const one = () => checkImage(q, imageBytes, mimeType).catch(() => null);
  const got: ImageCheck[] = (await Promise.all([one(), one()])).filter((c): c is ImageCheck => c !== null);
  let calls = 2;
  const decided = () => got.filter((c) => c.pass).length >= 2 || got.filter((c) => !c.pass).length >= 2;
  while (!decided() && calls < 5) { calls++; const c = await one(); if (c) got.push(c); }
  if (!got.length) throw new Error('image check returned no verdict');
  const passes = got.filter((c) => c.pass).length, fails = got.length - passes;
  const pass = passes > fails;
  const pick = got.find((c) => c.pass === pass)!;
  return { ...pick, pass, votes: `${pass ? passes : fails}/${got.length} ${pass ? 'pass' : 'fail'}` };
}
