import 'dotenv/config';

/**
 * One-off script: Regenerate hot_spot questions with the new stimulus+correct_ids contract.
 *
 * Targets:
 *   - 4 standalone hot_spot questions
 *   - hot_spot sub-questions inside case studies (Q#2412, Q#1009)
 *
 * Approach: Send each question to the fixer LLM with explicit instructions
 * about the new hot_spot contract, then re-validate.
 *
 * Usage: npx tsx server/src/scripts/regenHotspot.ts
 */

import { supabase } from '../db/supabase.js';
import { orCall, MODELS } from '../services/llm/openrouter.js';
import { runValidatorBatch } from '../services/review/validator.js';

const JOB_ID = 'a53a897a-1cfa-4860-b883-f9f2613a1b85';

const HOT_SPOT_CONTRACT = `
HOT_SPOT CONTRACT — the answer MUST be a set of target IDs, NEVER a text description.

For text_targets (default — discrete text elements like medication orders, lab values, charting entries):
{
  "stem": "<question asking to click/select the correct item>",
  "stimulus": {
    "type": "text_targets",
    "title": "<title of displayed record/table>",
    "targets": [
      { "id": "<lowercase-slug>", "text": "<full text of clickable element>" },
      ...at least 2 targets, including plausible distractors
    ]
  },
  "answer": { "correct_ids": ["<id of correct target(s)>"] },
  "scoring": "dichotomous",
  "rationale": {
    "<id1>": "<why correct/incorrect — 1 sentence>",
    "<id2>": "<why correct/incorrect — 1 sentence>"
  },
  "explanation": "<overall explanation>"
}

FORBIDDEN: answer.region, answer.label, answer.landmark — REMOVE these entirely.
The image_description text should be converted into stimulus.targets with text elements.
Each target id must be a lowercase slug (e.g. mar-1, lab-2, order-3).
`;

async function convertHotspotQuestion(question: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const content = question.content as Record<string, unknown> || {};
  const contentJson = JSON.stringify(content, null, 2);

  const prompt = `You are a medical education question editor. Convert this hot_spot question from the LEGACY format (answer.region) to the NEW contract format (stimulus + correct_ids).

${HOT_SPOT_CONTRACT}

ORIGINAL QUESTION CONTENT:
${contentJson}

Additional context:
- image_description: ${content.image_description || 'none'}
- question stem: ${content.stem || ''}

INSTRUCTIONS:
1. Read the image_description and stem carefully.
2. Extract the discrete elements (medication orders, lab values, assessment findings, etc.) from the image_description.
3. Create text_targets with those elements as targets, each with a lowercase-slug id.
4. Set answer.correct_ids to the id(s) of the correct target(s) — based on the old answer.region.
5. Set scoring to "dichotomous" (single correct) or "plus_minus" (multiple correct).
6. Add rationale keyed by target id explaining why each is correct/incorrect.
7. Remove answer.region, answer.label, answer.landmark entirely.
8. Keep the explanation and all other fields.

Return ONLY the converted content JSON object. No preamble, no markdown fences.`;

  try {
    const response = await orCall(MODELS.FIXER, '', prompt, {
      maxTokens: 4000,
      temperature: 0.2,
    });

    let raw = response.content.trim();
    if (raw.includes('```json')) raw = raw.split('```json')[1].split('```')[0].trim();
    else if (raw.includes('```')) raw = raw.split('```')[1].split('```')[0].trim();

    return JSON.parse(raw);
  } catch (e) {
    console.error(`  Error converting: ${e}`);
    return null;
  }
}

async function convertCaseStudyHotspots(question: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const content = question.content as Record<string, unknown>;
  const contentJson = JSON.stringify(content, null, 2);

  const prompt = `You are a medical education question editor. This is a case_study question with hot_spot sub-questions that use the LEGACY format (answer.region). Convert ONLY the hot_spot sub-questions to the NEW contract format.

${HOT_SPOT_CONTRACT}

FULL CASE STUDY CONTENT:
${contentJson}

INSTRUCTIONS:
1. Find each sub-question with format_type "hot_spot".
2. Convert it: create stimulus.targets from the sub-question's context, set answer.correct_ids, add scoring and rationale.
3. Remove answer.region/label/landmark from hot_spot sub-questions.
4. Leave ALL other sub-questions (mcq_single, sata, etc.) completely unchanged.
5. Keep the case_narrative, explanation, and all other fields unchanged.

Return the COMPLETE updated content JSON (all sub-questions, not just the hot_spot ones). No preamble, no markdown fences.`;

  try {
    const response = await orCall(MODELS.FIXER, '', prompt, {
      maxTokens: 6000,
      temperature: 0.2,
    });

    let raw = response.content.trim();
    if (raw.includes('```json')) raw = raw.split('```json')[1].split('```')[0].trim();
    else if (raw.includes('```')) raw = raw.split('```')[1].split('```')[0].trim();

    return JSON.parse(raw);
  } catch (e) {
    console.error(`  Error converting case study: ${e}`);
    return null;
  }
}

async function main() {
  console.log('=== Hot Spot Regeneration Script ===\n');

  // 1. Find standalone hot_spot questions
  const { data: allQs } = await supabase.from('qb_questions')
    .select('*')
    .eq('job_id', JOB_ID)
    .is('replaced_by_id', null);

  if (!allQs) { console.log('No questions found'); return; }

  const hotspots = allQs.filter(q => {
    const ft = (q.tags as Record<string, unknown>)?.format_type;
    return ft === 'hot_spot';
  });

  const caseStudiesWithHotspot = allQs.filter(q => {
    const ft = (q.tags as Record<string, unknown>)?.format_type;
    if (ft !== 'case_study') return false;
    const subs = ((q.content as Record<string, unknown>)?.sub_questions as Array<Record<string, unknown>>) || [];
    return subs.some(s => s.format_type === 'hot_spot');
  });

  console.log(`Found ${hotspots.length} standalone hot_spot questions`);
  console.log(`Found ${caseStudiesWithHotspot.length} case studies with hot_spot sub-questions\n`);

  // 2. Convert standalone hot_spots
  let converted = 0;
  for (const q of hotspots) {
    const qNum = q.question_number;
    console.log(`Converting Q#${qNum}...`);

    const newContent = await convertHotspotQuestion(q);
    if (!newContent) {
      console.log(`  FAILED to convert Q#${qNum}`);
      continue;
    }

    // Validate the new content has the correct structure
    const stimulus = newContent.stimulus as Record<string, unknown> | undefined;
    const answer = newContent.answer as Record<string, unknown> | undefined;
    if (!stimulus || !answer?.correct_ids) {
      console.log(`  INVALID conversion for Q#${qNum} — missing stimulus or correct_ids`);
      continue;
    }

    // Update in DB
    const trail = Array.isArray(q.audit_trail) ? [...q.audit_trail] : [];
    trail.push({
      phase: 'hotspot_contract_migration',
      message: 'Converted from legacy answer.region to stimulus+correct_ids contract',
      timestamp: new Date().toISOString(),
    });

    const { error } = await supabase.from('qb_questions').update({
      content: newContent,
      validator_score: null,
      adversarial_score: null,
      quality_score: null,
      combined_score: null,
      audit_trail: trail,
      status: 'reviewed',
    }).eq('id', q.id);

    if (error) {
      console.log(`  DB update failed for Q#${qNum}: ${error.message}`);
    } else {
      console.log(`  OK Q#${qNum} converted`);
      converted++;
    }
  }

  // 3. Convert case study hot_spot sub-questions
  for (const q of caseStudiesWithHotspot) {
    const qNum = q.question_number;
    console.log(`Converting case study Q#${qNum} hot_spot sub-questions...`);

    const newContent = await convertCaseStudyHotspots(q);
    if (!newContent) {
      console.log(`  FAILED to convert Q#${qNum}`);
      continue;
    }

    const trail = Array.isArray(q.audit_trail) ? [...q.audit_trail] : [];
    trail.push({
      phase: 'hotspot_contract_migration',
      message: 'Converted hot_spot sub-questions from legacy to stimulus+correct_ids',
      timestamp: new Date().toISOString(),
    });

    const { error } = await supabase.from('qb_questions').update({
      content: newContent,
      validator_score: null,
      adversarial_score: null,
      quality_score: null,
      combined_score: null,
      audit_trail: trail,
      status: 'reviewed',
    }).eq('id', q.id);

    if (error) {
      console.log(`  DB update failed for Q#${qNum}: ${error.message}`);
    } else {
      console.log(`  OK Q#${qNum} case study converted`);
      converted++;
    }
  }

  console.log(`\n=== Conversion complete: ${converted}/${hotspots.length + caseStudiesWithHotspot.length} ===`);

  // 4. Re-validate converted questions
  if (converted > 0) {
    console.log('\n=== Re-validating converted questions ===\n');

    // Re-fetch converted questions
    const convertedIds = [...hotspots, ...caseStudiesWithHotspot].map(q => q.id);
    const { data: freshQs } = await supabase.from('qb_questions')
      .select('*')
      .in('id', convertedIds);

    if (freshQs && freshQs.length > 0) {
      // Get course info for validator
      const { data: job } = await supabase.from('qb_jobs').select('course_id').eq('id', JOB_ID).single();
      let examFormat = {};
      let courseName = 'NCLEX';
      if (job) {
        const { data: course } = await supabase.from('qb_courses').select('name, exam_format').eq('id', job.course_id).single();
        if (course) {
          courseName = (course as Record<string, unknown>).name as string || 'NCLEX';
          examFormat = (course as Record<string, unknown>).exam_format || {};
        }
      }

      const results = await runValidatorBatch(freshQs, 'qbank', 'medical education', examFormat as Record<string, unknown>);

      for (let i = 0; i < freshQs.length; i++) {
        const q = freshQs[i];
        const result = results[i] || {};
        const score = (result.overall_accuracy_score as number) || 5;
        const hotspotIssues = (result.hotspot_issues as string[]) || [];

        const trail = Array.isArray(q.audit_trail) ? [...q.audit_trail] : [];
        trail.push({
          phase: 'post_migration_validator',
          score,
          hotspot_issues: hotspotIssues.length > 0 ? hotspotIssues : null,
          summary: (result.summary as string) || '',
          timestamp: new Date().toISOString(),
        });

        await supabase.from('qb_questions').update({
          validator_score: score,
          audit_trail: trail,
        }).eq('id', q.id);

        console.log(`  Q#${q.question_number}: validator_score=${score} hotspot_issues=${hotspotIssues.length}`);
      }
    }
  }

  console.log('\n=== Done ===');
}

main().catch(console.error);
