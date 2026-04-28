import { orCall, MODELS } from '../llm/openrouter.js';

/**
 * Refine course structure based on user chat input.
 * Direct port of refine_structure() from V1 app.py lines 5645-5741.
 */
export async function refineCourseStructure(
  courseName: string,
  currentStructure: Record<string, unknown>,
  userMessage: string
): Promise<{ response: string; updated_structure?: Record<string, unknown>; modified: boolean }> {
  const refinePrompt = `You are helping to refine a course structure for "${courseName}".

CURRENT STRUCTURE:
${JSON.stringify(currentStructure, null, 2)}

USER REQUEST:
${userMessage}

Your task:
1. Understand what the user wants to change (add subjects/topics, remove items, rename, reorder, etc.)
2. Modify the structure accordingly
3. Respond with a JSON object containing:
   - "response": A friendly message explaining what you changed (1-2 sentences)
   - "updated_structure": The COMPLETE updated structure in the same JSON format
   - "modified": true

If no changes are needed (e.g., user just asking a question), set "modified": false and don't include "updated_structure".

IMPORTANT:
- Maintain the exact JSON structure format with "course" and "subjects" array
- Each subject has "name" and "topics" (array of strings)
- Keep all existing fields that weren't asked to change
- When asked to remove subjects, only keep the ones the user wants
- Output ONLY valid JSON, no markdown fences, no extra text`;

  const responseText = await orCall(
    MODELS.STRUCTURE,
    '',
    refinePrompt,
    { temperature: 0.3, maxTokens: 16000 }
  );

  let text = responseText.content.trim();

  // Extract JSON from markdown if needed
  if (text.includes('```json')) {
    text = text.split('```json')[1].split('```')[0].trim();
  } else if (text.includes('```')) {
    text = text.split('```')[1].split('```')[0].trim();
  }

  // Extract outermost JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) text = jsonMatch[0];

  try {
    const result = JSON.parse(text);
    return {
      response: result.response || 'Structure updated.',
      updated_structure: result.updated_structure,
      modified: result.modified ?? !!result.updated_structure,
    };
  } catch (parseErr) {
    console.error('[refine] JSON parse failed:', parseErr instanceof Error ? parseErr.message : parseErr);
    console.error('[refine] Raw text (first 500 chars):', text.slice(0, 500));

    // Attempt to salvage: maybe the LLM returned the structure directly without wrapper
    try {
      const directParse = JSON.parse(text);
      if (directParse.subjects && Array.isArray(directParse.subjects)) {
        return {
          response: 'Structure updated.',
          updated_structure: directParse,
          modified: true,
        };
      }
    } catch { /* ignore */ }

    return {
      response: 'I understood your request, but encountered an error updating the structure. Please try rephrasing.',
      modified: false,
    };
  }
}

/**
 * Refine exam format/specs based on user chat input.
 * Direct port from V1 app.py lines 7195-7227.
 */
export async function refineExamFormat(
  specs: Record<string, unknown>,
  userMessage: string
): Promise<{ response: string; updated_specs?: Record<string, unknown> }> {
  const prompt = `You are adjusting official mock exam specifications based on a user request.

Current specs (JSON):
${JSON.stringify(specs, null, 2)}

User request: ${userMessage}

Apply the requested change and return the updated specs as a JSON object with the same structure, plus a plain-English "response" field (1-2 sentences) describing what you changed.

Rules:
- subject_distribution question counts must still sum to total_questions
- If image_questions_total is changed, keep it <= total_questions
- Preserve any fields the user did not ask to change
- Return ONLY valid JSON, no markdown fences`;

  const responseText = await orCall(
    MODELS.VALIDATOR,
    '',
    prompt,
    { temperature: 0.1, maxTokens: 4000 }
  );

  let text = responseText.content.trim();
  if (text.includes('```json')) {
    text = text.split('```json')[1].split('```')[0].trim();
  } else if (text.includes('```')) {
    text = text.split('```')[1].split('```')[0].trim();
  }

  try {
    const result = JSON.parse(text);
    const response = result.response || 'Specs updated.';
    delete result.response;
    return { response, updated_specs: result };
  } catch (parseErr) {
    console.error('[refine-exam] JSON parse failed:', parseErr instanceof Error ? parseErr.message : parseErr);
    console.error('[refine-exam] Raw text (first 500 chars):', text.slice(0, 500));
    return { response: 'Failed to update exam format. Please try rephrasing.' };
  }
}
