/**
 * Image generation service — ported from V1's OpenAI image pipeline.
 *
 * V1 flow (app.py lines 2327-2400):
 *   - _build_openai_safe_prompt() — safety-filter-aware prompt
 *   - generate_image_with_openrouter() — direct OpenAI images API (gpt-image-2.5-flare)
 *
 * Uses direct OpenAI API (not OpenRouter) because OpenRouter doesn't
 * expose /v1/images/generations.
 */

import OpenAI from 'openai';
import { supabase } from '../../db/supabase.js';
import { fetchAllRows } from '../../db/pagination.js';
import crypto from 'crypto';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-flare';

const openaiClient = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

if (openaiClient) {
  console.log(`OpenAI image client initialised (model: ${OPENAI_IMAGE_MODEL})`);
} else {
  console.warn('OPENAI_API_KEY not set — image generation disabled');
}

// ── Ensure Supabase storage bucket ──

let bucketReady = false;
async function ensureBucket() {
  if (bucketReady) return;
  const { data: buckets } = await supabase.storage.listBuckets();
  const exists = buckets?.some((b) => b.name === 'question-images');
  if (!exists) {
    const { error } = await supabase.storage.createBucket('question-images', { public: true });
    if (error && !error.message.includes('already exists')) {
      console.error('Failed to create storage bucket:', error.message);
      return;
    }
    console.log('Created storage bucket: question-images');
  }
  bucketReady = true;
}

// ── Prompt builder (V1 app.py lines 2327-2353) ──

// Diagram-type images (flowcharts, graphs, tables, pathways…) are useless
// without labels; clinical/photographic images (x-ray, histology, rash) render
// garbled text and should stay label-free. Decide per image.
function imageNeedsLabels(imageType: string, description: string): boolean {
  return /flow[\s_-]?chart|diagram|graph|chart|algorithm|pathway|cycle|process|schematic|table|timeline|tree\b|flow|circuit|network|hierarchy|matrix|plot|axis|ladder|map\b/i
    .test(`${imageType} ${description}`);
}

const STIMULUS_CHARS = 4000;
const FIGURE_TASK_CHARS = 1500;

/**
 * The stimulus a figure must be consistent with — read from wherever THIS format
 * keeps it, plus the sub-questions that are answered by reading the figure.
 *
 * This used to be `question || content.stem`, an mcq_single-shaped assumption. No
 * grouped format stores its scenario in `stem`: a case_study keeps it in
 * case_narrative, a passage_set in passage, a TBS in exhibits[], a
 * constructed_response in vignette. For those, `question` holds only a pointer
 * ("Use the Armand Family Portfolio vignette and Figure 1 to answer Questions
 * 1-4."), so the generator received a sentence with no data in it and invented
 * plausible numbers — which then contradicted the narrative and the answer key.
 */
/**
 * Does this description actually carry the figure's DATA, or is it a label?
 *
 * The point of preferring image_description is to send ~400 characters instead of
 * ~2600. That trade is only safe while the short text still contains the numbers —
 * "a scatter plot of portfolio risk and return" is smaller AND useless, and a figure
 * drawn from it contradicts the answer key exactly as before. So a description is
 * trusted only when it carries at least as many distinct numeric values as the
 * stimulus it would replace; otherwise we fall back to the full stimulus and pay the
 * tokens. Non-quantitative figures (anatomy, a photograph) have no numbers in either,
 * so they pass trivially — which is correct, there is nothing to lose.
 */
function carriesFigureData(desc: string, stimulus: string): boolean {
  const nums = (t: string) => new Set((t.match(/-?\d+(?:[.,]\d+)?/g) || []));
  const inStimulus = nums(stimulus);
  if (inStimulus.size === 0) return true;
  const inDesc = nums(desc);
  return inDesc.size >= inStimulus.size;
}

function stimulusForImage(q: Record<string, unknown>): { stem: string; figureTasks: string } {
  const c = (q.content as Record<string, unknown> | undefined) || {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');

  const exhibits = Array.isArray(c.exhibits)
    ? (c.exhibits as Array<Record<string, unknown>>)
        .map((e) => [str(e.label), str(e.title), str(e.content)].filter(Boolean).join(' — '))
        .filter(Boolean).join('\n\n')
    : '';

  // Longest wins where several are present: a case_study carrying both a pointer
  // `question` and a full case_narrative must use the narrative.
  const full = [
    str(c.stem), str(c.case_narrative), str(c.passage), str(c.vignette),
    str(c.source_material), str(c.prompt), exhibits, str(q.question),
  ].sort((a, b) => b.length - a.length)[0] || '';

  // Prefer the authored figure spec: the model that WROTE the scenario produced it
  // while holding the numbers, so it is extraction at the source rather than a
  // lossy summary made after the fact — and it is a fraction of the size. Guarded,
  // because a spec that dropped the values is worse than the long version.
  const desc = str(q.image_description) || str(c.image_description);
  const stem = desc && carriesFigureData(desc, full) ? desc : full;

  // Sub-questions (or labelled parts) are what the reader measures off the figure.
  const subs = Array.isArray(c.sub_questions) ? (c.sub_questions as Array<Record<string, unknown>>)
    : Array.isArray(c.parts) ? (c.parts as Array<Record<string, unknown>>) : [];
  const figureTasks = subs
    .map((sq, i) => `${i + 1}. ${str(sq.stem) || str(sq.question) || str(sq.prompt)}`)
    .filter((l) => l.length > 3).join('\n');

  return { stem, figureTasks };
}

/** Whatever the model gave us for a "list of terms", as a list of non-empty strings. */
export function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x ?? '').trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/\s*[;,]\s*/).map((s) => s.trim()).filter(Boolean);
  return [];
}

export function buildImagePrompt(questionData: Record<string, unknown>, fixInstructions?: string): string {
  const imageType = (questionData.image_type as string) || '';
  const imageDesc = (questionData.image_description as string) || '';
  const courseName = (questionData.course as string) || 'the exam';

  // Pull the actual scenario from the question so the image depicts THIS
  // question, not a generic template. Prefer explicit description, then the
  // search terms, then the type as a last resort.
  const { stem, figureTasks } = stimulusForImage(questionData);
  // The model returns image_search_terms as an array OR as a single string, and a cast
  // cannot tell the difference: `(x as string[]) || []` leaves a string intact and .join()
  // then throws. That throw happened BEFORE the try block in generateImageWithOpenAI, so it
  // propagated to Promise.allSettled and was counted as a failure with nothing logged —
  // five CFA images "failed immediately" with no error anywhere, looking like a connection
  // fault. Coerce instead of casting.
  const searchTerms = toStringArray(questionData.image_search_terms);
  const descParts = [imageDesc, searchTerms.join('; ')].filter(Boolean);
  const subject = descParts.join(' — ') || imageType || 'illustration';
  const needsLabels = imageNeedsLabels(imageType, subject);

  let prompt = `Create a clear ${needsLabels ? 'fully-labeled ' : ''}educational illustration for a ${courseName} examination question.

IMAGE NEEDED: ${subject}${imageType && imageType !== subject ? `\nIMAGE TYPE: ${imageType}` : ''}`;

  if (stem) {
    prompt += `\n\nQUESTION CONTEXT (the image must accurately depict the SPECIFIC scenario below — not a generic placeholder):\n${stem.slice(0, STIMULUS_CHARS)}`;
    // The figure IS the data for these items: a chart whose plotted values disagree
    // with the stimulus silently invalidates the answer key, and no text-only check
    // can see it. Two CFA case studies failed exactly this way — one plotted a
    // portfolio at 10% return against a narrative that said 8%, breaking the
    // dominance the key depended on.
    prompt += `\n\nDATA FIDELITY (critical): every number, label, series and data point you draw MUST be taken verbatim from the context above. Do NOT invent, round, re-scale or "improve" any value. If the context gives values, plot exactly those; anything a reader measures off this image must agree with the text.`;
    if (figureTasks) {
      prompt += `\n\nThe following questions are answered by READING THIS FIGURE, so the quantities they ask for must be plotted accurately and be legible:\n${figureTasks.slice(0, FIGURE_TASK_CHARS)}`;
    }
    prompt += `\n\nIMPORTANT: Depict only the SCENARIO/SETUP. Do NOT draw, name, or hint at the correct answer, the solution, or the recommended procedure — the image sets up the question and must not give the answer away. Do not render the answer options.`;
  }

  prompt += `\n\nStyle: clean, professional, textbook-quality. Generate ONLY the precise image needed — no decorative borders, no surrounding infographic elements.`;

  if (needsLabels) {
    prompt += `
- This is a ${imageType || 'diagram'}: EVERY node, box, arrow, axis, column, and step MUST carry concise, correct, legible text taken from the question context above. Empty or unlabeled shapes are unacceptable.
- Spell all labels correctly in clear English; keep each label short (a few words). The reader must be able to follow the logic from the labels alone.`;
  } else {
    prompt += `
- Do not depict identifiable real people — use diagrams, illustrations, or schematic representations.
- Avoid captions, watermarks, or decorative text; include only the structural/labelling text genuinely needed to answer.`;
  }

  if (fixInstructions) {
    prompt += `\n\nADDITIONAL REQUIREMENTS FROM REVIEW:\n${fixInstructions}`;
  }

  return prompt;
}

// ── Generate image with OpenAI (V1 app.py lines 2356-2400) ──

async function generateImageWithOpenAI(
  questionData: Record<string, unknown>,
  fixInstructions?: string
): Promise<{ imageBytes: Buffer; mimeType: string } | { safetyRefused: true; message: string } | null> {
  if (!openaiClient) return null;

  const prompt = buildImagePrompt(questionData, fixInstructions);
  const imageType = (questionData.image_type as string) || '';

  try {
    console.log(`    [openai-img] Generating with ${OPENAI_IMAGE_MODEL}: ${imageType.slice(0, 80)}`);

    // Bound each image call — without this a single hung request stalls its whole
    // concurrency slot indefinitely (a major reason the pipeline never finished).
    const IMAGE_CALL_TIMEOUT_MS = 120_000;
    const response = await openaiClient.images.generate(
      {
        model: OPENAI_IMAGE_MODEL,
        prompt,
        n: 1,
        size: '1024x1024',
        ...({ output_format: 'png' } as Record<string, unknown>),
      },
      { timeout: IMAGE_CALL_TIMEOUT_MS, maxRetries: 1 }
    );

    const b64Data = (response.data?.[0] as Record<string, unknown>)?.b64_json as string | undefined;
    if (!b64Data) {
      console.warn(`    [openai-img] ${OPENAI_IMAGE_MODEL} returned empty image data`);
      return null;
    }

    const imageBytes = Buffer.from(b64Data, 'base64');
    if (imageBytes.length < 1000) {
      console.warn(`    [openai-img] ${OPENAI_IMAGE_MODEL} returned near-empty image (${imageBytes.length} bytes)`);
      return null;
    }

    return { imageBytes, mimeType: 'image/png' };
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : String(e);
    console.error(`    [openai-img] Generation error: ${msg}`);
    if (isSafetyRefusal(msg)) {
      console.warn('    [openai-img] refused on content policy — not retryable');
      return { safetyRefused: true, message: msg };
    }
    return null;
  }
}

/**
 * Did the image API refuse this prompt on content policy, as opposed to failing?
 *
 * The distinction decides whether retrying is worth anything. A timeout, a rate limit or a 5xx is
 * worth another attempt; a refusal is the same answer every time. NCLEX needed a term newborn in
 * respiratory distress and got "400 Your request was rejected by the safety system" — then got it
 * again, with a fresh request id, after the prompt was re-framed from a photograph to a clinical
 * atlas illustration. A distressed infant with central cyanosis is what the filter is for.
 *
 * Deliberately narrow. Matching loosely would send a transient blip down the fallback path and
 * quietly convert a question that only needed one more attempt.
 */
function isSafetyRefusal(message: string): boolean {
  const m = message.toLowerCase();
  return /rejected by the safety system/.test(m)
    || /content[_ ]policy[_ ]violation/.test(m)
    || (/\b400\b/.test(m) && /safety|moderation|content policy/.test(m));
}

// ── Upload to Supabase Storage ──

async function uploadImageToStorage(
  imageBytes: Buffer,
  mimeType: string,
  jobId: string,
  questionId: string
): Promise<string | null> {
  await ensureBucket();

  const ext = mimeType.includes('png') ? 'png' : mimeType.includes('gif') ? 'gif' : 'jpg';
  const hash = crypto.createHash('md5').update(imageBytes).digest('hex').slice(0, 12);
  const path = `questions/${jobId}/${questionId}_${hash}.${ext}`;

  const { error } = await supabase.storage
    .from('question-images')
    .upload(path, imageBytes, { contentType: mimeType, upsert: true });

  if (error) {
    console.error(`    Storage upload failed: ${error.message}`);
    return null;
  }

  const { data: urlData } = supabase.storage
    .from('question-images')
    .getPublicUrl(path);

  return urlData?.publicUrl || null;
}

/**
 * Rewrite a question to state the findings its refused image was specified to show.
 *
 * Reached only when the image API refuses on content policy, which is not recoverable by trying
 * again. The alternative is what happened before this existed: the question stays flagged as
 * "image-based question missing required image, making it unusable" and is dropped from every
 * export, taking a clinically sound item and its correct key with it.
 *
 * image_description is the specification of what the picture would have contained, so the findings
 * are read out of it rather than invented — that is what lets the existing options, key and
 * explanation stand unchanged. The rewrite is deliberately conservative: only the sentence
 * referring to the image is replaced, and the question, its options and its answer are untouched.
 *
 * A described finding is a real item style in every one of these exams. An image question whose
 * image cannot exist is not.
 *
 * Returns whether the stem was rewritten. On failure the row is left exactly as it was, so review
 * still flags it and nothing is silently half-converted.
 */
async function describeFindingsInsteadOfImage(question: Record<string, unknown>): Promise<boolean> {
  const qId = question.id as string;
  const content = JSON.parse(JSON.stringify((question.content as Record<string, unknown>) ?? {}));
  const stem = String(content.stem ?? content.question ?? '');
  const spec = String(question.image_description ?? '');
  if (!stem || !spec) return false;

  const prompt = `A question was written to show an image, but the image cannot be generated: the image API refuses this subject on content policy. Rewrite the question so it can be answered WITHOUT the image, by stating the findings the image was specified to show.

THE IMAGE SPECIFICATION (what the picture would have contained):
${spec.slice(0, 2000)}

THE CURRENT TEXT (it refers to an image the candidate will not have):
${stem}

RULES
• State the findings from the specification as observed clinical or factual detail, in prose, as an examiner would describe them. Take them FROM the specification — invent nothing.
• Include every finding a candidate needs to reach the existing answer and to rule out the wrong options. Omit purely presentational detail: figure titles, axis ranges, grid colours, drawing instructions, calibration marks.
• Remove every reference to a displayed image, figure, photograph, strip or exhibit.
• Change NOTHING else. Keep the question being asked, its wording, and any [Blank N] markers exactly as they are.
• Keep the same tense and register as the original.

Return ONLY the rewritten text, with no preamble, no quotes and no explanation.`;

  try {
    const { orCall, MODELS } = await import('../llm/openrouter.js');
    const response = await orCall(MODELS.FIXER, '', prompt, { maxTokens: 1500, temperature: 0.2 });
    const rewritten = String(response.content || '').trim().replace(/^["']|["']$/g, '');

    // Guard the obvious ways this can come back useless. A stem that still points at an image, or
    // that lost a cloze marker, is worse than the flagged original.
    if (rewritten.length < 40) return false;
    if (/\b(shown in the (image|figure|photograph)|displayed|the image below|see figure)\b/i.test(rewritten)) return false;
    const blanksBefore = (stem.match(/\[Blank \d+\]/g) || []).length;
    const blanksAfter = (rewritten.match(/\[Blank \d+\]/g) || []).length;
    if (blanksBefore !== blanksAfter) return false;

    if (content.stem !== undefined) content.stem = rewritten; else content.question = rewritten;
    if (content.question_type === 'image') content.question_type = 'text';

    const patch: Record<string, unknown> = {
      content,
      // The legacy column is what reviewers and the export read for an MCQ. Rewriting only
      // content.stem left `question` still saying "shown in the image on the left".
      ...(String(question.question ?? '') === stem || !question.question ? { question: rewritten } : {}),
      is_image_question: false,
      image_url: null,
      image_type: null,
      // image_description is KEPT: it is the provenance of the findings now in the stem, and
      // is_image_question false already stops anything trying to generate from it again.
      image_source: 'Described in stem — image refused by the image safety system',
    };
    // A row already flagged for the missing image has to go back for scoring, or the rewrite sits
    // behind a stale flag that says "image-based question missing required image" and stays out of
    // every export. During normal generation the row is already 'generated' and this is a no-op;
    // it matters when retry-images is run against a job that has finished.
    if (question.status === 'flagged') patch.status = 'generated';

    const { error } = await supabase.from('qb_questions').update(patch).eq('id', qId);
    if (error) { console.error(`    [img-fallback] update failed: ${error.message}`); return false; }
    return true;
  } catch (e) {
    console.error(`    [img-fallback] rewrite failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

// ── Generate and store image for a single question ──

async function generateAndStoreImage(
  question: Record<string, unknown>,
  jobId: string,
  fixInstructions?: string,
  opts: { duringReview?: boolean } = {}
): Promise<boolean> {
  const qId = question.id as string;
  const qNum = question.question_number as number;

  const result = await generateImageWithOpenAI(question, fixInstructions);
  if (result && 'safetyRefused' in result) {
    // A REPLACEMENT was refused, and the question still has the image it had. Keep it: the
    // fallback below is for a question whose image never existed, and run here it removed a real
    // clinical photograph from an imported item (977c011f) and left the stem pointing at nothing.
    if (question.image_url) {
      console.warn(`    ✗ Replacement image refused on content policy for Q${qNum} — keeping the existing image`);
      return false;
    }
    // The image is never going to exist, so stop asking for it and make the question answerable
    // without one. Only reached on a refusal: every other failure falls through to the retry
    // path below, because those are worth another attempt and this is not.
    const converted = await describeFindingsInsteadOfImage(question);
    console.warn(`    ✗ Image refused on content policy for Q${qNum}${converted ? ' — findings described in the stem instead' : ' — and the stem could not be rewritten, left for review'}`);
    return false;
  }
  if (!result) {
    console.warn(`    ✗ Image generation failed for Q${qNum}`);
    return false;
  }

  const publicUrl = await uploadImageToStorage(result.imageBytes, result.mimeType, jobId, qId);
  if (!publicUrl) {
    return false;
  }

  // Update image URL, media array, and clear stale structural-failure scores if present
  const imageSource = `AI Generated (${OPENAI_IMAGE_MODEL})`;
  const updateData: Record<string, unknown> = {
    image_url: publicUrl,
    image_source: imageSource,
  };

  // Update media array — set url and source on the first media entry, or create one
  const existingMedia = (question.media as Array<Record<string, unknown>>) || [];
  if (existingMedia.length > 0) {
    const updatedMedia = existingMedia.map((m, i) => i === 0 ? { ...m, url: publicUrl, source: imageSource } : m);
    updateData.media = updatedMedia;
  } else {
    updateData.media = [{
      type: (question.image_type as string) || 'image',
      url: publicUrl,
      source: imageSource,
      description: (question.image_description as string) || null,
      search_terms: (question.image_search_terms as string[]) || [],
    }];
  }

  // If this question was previously scored low (image-related failure), reset its scores so it is
  // re-evaluated in audit — but only outside a review pass. Inside one, the validator has just
  // scored the question low BECAUSE of the image, and the reset erased that score and its trail
  // mid-review, along with every repair recorded before it, so audit had nothing to verify.
  // The trail is history and is never cleared.
  const prevQuality = question.quality_score as number | null;
  const prevValidator = question.validator_score as number | null;
  const prevScore = prevQuality ?? prevValidator;
  if (!opts.duringReview && prevScore !== null && prevScore <= 6) {
    updateData.validator_score = null;
    updateData.adversarial_score = null;
    updateData.quality_score = null;
    updateData.combined_score = null;
    updateData.status = 'reviewed';
  }

  await supabase
    .from('qb_questions')
    .update(updateData)
    .eq('id', qId);

  console.log(`    ✓ Image generated for Q${qNum}`);
  return true;
}

// ── Process all image questions for a job (initial generation) ──

export async function processAllImageQuestions(jobId: string): Promise<{
  totalProcessed: number;
  totalSuccess: number;
  totalFailed: number;
}> {
  if (!openaiClient) {
    console.warn('Skipping image generation — OPENAI_API_KEY not configured');
    return { totalProcessed: 0, totalSuccess: 0, totalFailed: 0 };
  }

  // Fetch image questions that don't have images yet (paginated — a large job can
  // have >1000 image questions).
  const imageQuestions = await fetchAllRows<Record<string, unknown>>((from, to) =>
    supabase
      .from('qb_questions')
      .select('*')
      .eq('job_id', jobId)
      .eq('is_image_question', true)
      .is('image_url', null)
      .is('replaced_by_id', null)
      .order('id', { ascending: true })
      .range(from, to)
  );

  if (!imageQuestions || imageQuestions.length === 0) {
    return { totalProcessed: 0, totalSuccess: 0, totalFailed: 0 };
  }

  const totalImages = imageQuestions.length;
  console.log(`\n🎨 Image pipeline: generating ${totalImages} images with ${OPENAI_IMAGE_MODEL}\n`);

  let totalSuccess = 0;
  let totalFailed = 0;

  // Process 3 at a time to avoid rate limits
  const CONCURRENCY = Number(process.env.IMAGE_CONCURRENCY) || 8;
  for (let i = 0; i < totalImages; i += CONCURRENCY) {
    const batch = imageQuestions.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((q) => generateAndStoreImage(q, jobId))
    );
    for (let k = 0; k < results.length; k++) {
      const r = results[k];
      if (r.status === 'fulfilled' && r.value) { totalSuccess++; continue; }
      totalFailed++;
      // A REJECTED promise used to be counted and discarded, so anything thrown before
      // generateImageWithOpenAI's try block vanished without a trace. Say what happened.
      if (r.status === 'rejected') {
        const q = batch[k] as Record<string, unknown>;
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        console.error(`    ✗ Q${q?.question_number}: image generation threw — ${msg.slice(0, 160)}`);
      }
    }

    // Update job progress after each batch
    const processed = Math.min(i + CONCURRENCY, totalImages);
    await supabase
      .from('qb_jobs')
      .update({
        progress: {
          completed: processed,
          total: totalImages,
          message: `Generating images... ${totalSuccess}/${totalImages} done (${totalFailed} failed)`,
          phase: 'images',
        },
      })
      .eq('id', jobId);
  }

  console.log(`\n🎨 Image pipeline complete: ${totalSuccess}/${totalImages} images generated\n`);
  return { totalProcessed: imageQuestions.length, totalSuccess, totalFailed };
}

/**
 * Which of these review issues say the IMAGE disagrees with the text?
 *
 * This defect class cannot be fixed by the fixer: it is a text model, so asked to
 * reconcile a chart with its narrative it edits the narrative — or worse, writes the
 * rationale's numbers INTO the text while the chart still shows different ones,
 * making the contradiction sharper. One CFA fix said so outright: "the actual
 * image_url file could not be regenerated as this requires image-generation
 * capability outside this text-editing". The audit then re-flags it, forever.
 *
 * The cure is to redraw the figure from the corrected text instead.
 */
const IMAGE_WORD = /\b(image|figure|chart|graph|plot|diagram|exhibit|axis|axes|plotted|legend)\b/i;
// Two vocabularies, because reviewers describe this defect in two registers. The
// AUDIT reports it ("the image contradicts the rationale"); the VALIDATOR prescribes
// a remedy ("Reconcile Figure 1 coordinates with the values used in Sub-Q1"). The
// first version of this matched only the reporting register, so on a live run every
// redraw silently failed to fire: "consistent between image and text" is not
// "inconsisten\w*", and "to match" is the opposite of "does not match".
const CONTRADICTION_WORD = /\b(contradict\w*|mismatch\w*|inconsisten\w*|do(es)? not match|don't match|disagree\w*|differ\w*|not consistent|does not correspond|unverifiable)\b/i;
const REMEDY_WORD = /\b(reconcile|realign|align|replace|redraw|regenerate|relabel|re-?label|adjust|consistent|correspond\w*|matching|match the)\b/i;

export function imageContradictionIssues(issues: string[]): string[] {
  return (issues || []).filter((i) =>
    typeof i === 'string' && IMAGE_WORD.test(i) && (CONTRADICTION_WORD.test(i) || REMEDY_WORD.test(i)));
}

// ── Re-generate image for a question after review fix ──
// Called from the review pipeline when validator/adversarial flags image issues.

export async function regenerateQuestionImage(
  questionId: string,
  jobId: string,
  reviewFeedback: string[],
  opts: { duringReview?: boolean } = {}
): Promise<boolean> {
  if (!openaiClient) return false;

  const { data: question, error } = await supabase
    .from('qb_questions')
    .select('*')
    .eq('id', questionId)
    .single();

  if (error || !question) return false;

  // Never hand a PLOTTED figure back to the image model.
  //
  // A chart with known data points is drawn by arithmetic, so its markers and labels cannot drift
  // apart. Regenerating it replaces that with a diffusion model's impression of a chart, and this
  // one has now failed the same way twice: asked for weight at the 50th, 25th, 10th and 5th
  // percentiles it produced points sitting visibly below each of those labels — which is the
  // defect a tester reported in the first place. The review feedback that triggers this is
  // usually right that the image is wrong; regenerating is simply not the way to fix a plot.
  //
  // So a figure marked as plotted is left alone and the finding is reported. Re-running its
  // renderer is a deliberate act, not something a review pass should do on its own.
  const source = String(question.image_source || '');
  if (/^Plotted from/i.test(source)) {
    console.log(`    ↩︎ Q${question.question_number}: image was plotted from its specification, not regenerating — re-run its renderer instead`);
    return false;
  }

  // Build fix instructions from review feedback
  const fixInstructions = reviewFeedback.join('\n');

  console.log(`    🔄 Re-generating image for Q${question.question_number} with review feedback`);
  return generateAndStoreImage(question, jobId, fixInstructions, opts);
}

export function isImageGenerationAvailable(): boolean {
  return !!openaiClient;
}
