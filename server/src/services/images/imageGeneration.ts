/**
 * Image generation service — ported from V1's OpenAI image pipeline.
 *
 * V1 flow (app.py lines 2327-2400):
 *   - _build_openai_safe_prompt() — safety-filter-aware prompt
 *   - generate_image_with_openrouter() — direct OpenAI images API (gpt-image-2)
 *
 * Uses direct OpenAI API (not OpenRouter) because OpenRouter doesn't
 * expose /v1/images/generations.
 */

import OpenAI from 'openai';
import { supabase } from '../../db/supabase.js';
import crypto from 'crypto';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';

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

function buildImagePrompt(questionData: Record<string, unknown>, fixInstructions?: string): string {
  const imageType = (questionData.image_type as string) || '';
  const imageDesc = (questionData.image_description as string) || '';
  const courseName = (questionData.course as string) || 'medical board';

  // Use image_description if available, otherwise fall back to image_type
  const subject = imageDesc || imageType || 'clinical image';

  let prompt = `Create a medical educational illustration for a ${courseName} examination question.

IMAGE NEEDED: ${subject}${imageType && imageType !== subject ? `\nIMAGE TYPE: ${imageType}` : ''}

This is a professional medical education image. Create a clean, clinical illustration suitable for a medical exam.
- Educational/textbook style
- Professional medical illustration
- No patient photos — use diagrams, illustrations, or schematic representations
- Do not include any text or labels on the image
- Generate ONLY the precise image needed — no infographic, no decorative borders, no extra surrounding elements. The image must carry the information needed to complete the question, nothing more.`;

  if (fixInstructions) {
    prompt += `\n\nADDITIONAL REQUIREMENTS FROM REVIEW:\n${fixInstructions}`;
  }

  return prompt;
}

// ── Generate image with OpenAI (V1 app.py lines 2356-2400) ──

async function generateImageWithOpenAI(
  questionData: Record<string, unknown>,
  fixInstructions?: string
): Promise<{ imageBytes: Buffer; mimeType: string } | null> {
  if (!openaiClient) return null;

  const prompt = buildImagePrompt(questionData, fixInstructions);
  const imageType = (questionData.image_type as string) || '';

  try {
    console.log(`    [openai-img] Generating with ${OPENAI_IMAGE_MODEL}: ${imageType.slice(0, 80)}`);

    const response = await openaiClient.images.generate({
      model: OPENAI_IMAGE_MODEL,
      prompt,
      n: 1,
      size: '1024x1024',
      ...({ output_format: 'png' } as Record<string, unknown>),
    });

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
    return null;
  }
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

// ── Generate and store image for a single question ──

async function generateAndStoreImage(
  question: Record<string, unknown>,
  jobId: string,
  fixInstructions?: string
): Promise<boolean> {
  const qId = question.id as string;
  const qNum = question.question_number as number;

  const result = await generateImageWithOpenAI(question, fixInstructions);
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

  // If this question was previously scored low (image-related failure),
  // reset scores so it gets properly re-evaluated in audit
  const prevQuality = question.quality_score as number | null;
  const prevValidator = question.validator_score as number | null;
  const prevScore = prevQuality ?? prevValidator;
  if (prevScore !== null && prevScore <= 6) {
    updateData.validator_score = null;
    updateData.adversarial_score = null;
    updateData.quality_score = null;
    updateData.combined_score = null;
    updateData.audit_trail = [];
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

  // Fetch image questions that don't have images yet
  const { data: imageQuestions, error } = await supabase
    .from('qb_questions')
    .select('*')
    .eq('job_id', jobId)
    .eq('is_image_question', true)
    .is('image_url', null)
    .is('replaced_by_id', null);

  if (error || !imageQuestions || imageQuestions.length === 0) {
    return { totalProcessed: 0, totalSuccess: 0, totalFailed: 0 };
  }

  const totalImages = imageQuestions.length;
  console.log(`\n🎨 Image pipeline: generating ${totalImages} images with ${OPENAI_IMAGE_MODEL}\n`);

  let totalSuccess = 0;
  let totalFailed = 0;

  // Process 3 at a time to avoid rate limits
  const CONCURRENCY = 3;
  for (let i = 0; i < totalImages; i += CONCURRENCY) {
    const batch = imageQuestions.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((q) => generateAndStoreImage(q, jobId))
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) totalSuccess++;
      else totalFailed++;
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

// ── Re-generate image for a question after review fix ──
// Called from the review pipeline when validator/adversarial flags image issues.

export async function regenerateQuestionImage(
  questionId: string,
  jobId: string,
  reviewFeedback: string[]
): Promise<boolean> {
  if (!openaiClient) return false;

  const { data: question, error } = await supabase
    .from('qb_questions')
    .select('*')
    .eq('id', questionId)
    .single();

  if (error || !question) return false;

  // Build fix instructions from review feedback
  const fixInstructions = reviewFeedback.join('\n');

  console.log(`    🔄 Re-generating image for Q${question.question_number} with review feedback`);
  return generateAndStoreImage(question, jobId, fixInstructions);
}

export function isImageGenerationAvailable(): boolean {
  return !!openaiClient;
}
