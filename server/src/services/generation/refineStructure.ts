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
  // Build a condensed view of the structure (subject names + topic names only, no chapters)
  const subjects = (currentStructure.subjects as Array<Record<string, unknown>>) || [];
  const condensed = subjects.map((s) => {
    const topics = (s.topics as Array<Record<string, unknown>>) || [];
    return {
      name: s.name,
      topics: topics.map((t) => (t.name as string) || ''),
      high_yield_topics: topics.filter((t) => t.high_yield || t.is_high_yield).map((t) => (t.name as string) || ''),
    };
  });

  const refinePrompt = `You are helping to refine a course structure for "${courseName}".

CURRENT SUBJECTS AND TOPICS:
${JSON.stringify(condensed, null, 2)}

USER REQUEST:
${userMessage}

Respond with a JSON object describing the CHANGES to make (not the full structure):
{
  "response": "<1-2 sentence explanation of what you changed>",
  "modified": true,
  "changes": [
    { "action": "add_subject", "name": "<subject name>", "topics": ["topic1", "topic2", ...] },
    { "action": "remove_subject", "name": "<subject name>" },
    { "action": "rename_subject", "old_name": "<old>", "new_name": "<new>" },
    { "action": "add_topics", "subject": "<subject name>", "topics": ["new topic 1", "new topic 2"] },
    { "action": "remove_topics", "subject": "<subject name>", "topics": ["topic to remove"] },
    { "action": "rename_topic", "subject": "<subject name>", "old_name": "<old>", "new_name": "<new>" }
  ]
}

If no changes are needed (user is just asking a question), return:
{ "response": "<answer>", "modified": false, "changes": [] }

Output ONLY valid JSON.`;

  const responseText = await orCall(
    MODELS.STRUCTURE,
    '',
    refinePrompt,
    // The model must echo back the ENTIRE structure; 4000 tokens truncates large
    // courses (many subjects) mid-JSON, causing an unrecoverable parse failure.
    { temperature: 0.3, maxTokens: 16000 }
  );

  let text = responseText.content.trim();
  if (text.includes('```json')) text = text.split('```json')[1].split('```')[0].trim();
  else if (text.includes('```')) text = text.split('```')[1].split('```')[0].trim();

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) text = jsonMatch[0];

  try {
    const result = JSON.parse(text);
    if (!result.modified || !result.changes || result.changes.length === 0) {
      return { response: result.response || 'No changes needed.', modified: false };
    }

    // Apply changes to the full structure
    const updated = JSON.parse(JSON.stringify(currentStructure)) as Record<string, unknown>;
    const updatedSubjects = (updated.subjects as Array<Record<string, unknown>>) || [];

    for (const change of result.changes as Array<Record<string, unknown>>) {
      const action = change.action as string;

      if (action === 'add_subject') {
        const topicNames = (change.topics as string[]) || [];
        updatedSubjects.push({
          name: change.name as string,
          topics: topicNames.map((t) => ({ name: t, chapters: [], high_yield: false })),
          description: '',
        });
      } else if (action === 'remove_subject') {
        const name = (change.name as string).toLowerCase().trim();
        const idx = updatedSubjects.findIndex((s) => ((s.name as string) || '').toLowerCase().trim() === name);
        if (idx >= 0) updatedSubjects.splice(idx, 1);
      } else if (action === 'rename_subject') {
        const oldName = (change.old_name as string).toLowerCase().trim();
        const subj = updatedSubjects.find((s) => ((s.name as string) || '').toLowerCase().trim() === oldName);
        if (subj) subj.name = change.new_name as string;
      } else if (action === 'add_topics') {
        const subjName = (change.subject as string).toLowerCase().trim();
        const subj = updatedSubjects.find((s) => ((s.name as string) || '').toLowerCase().trim() === subjName);
        if (subj) {
          const topics = (subj.topics as Array<Record<string, unknown>>) || [];
          for (const t of (change.topics as string[]) || []) {
            topics.push({ name: t, chapters: [], high_yield: false });
          }
          subj.topics = topics;
        }
      } else if (action === 'remove_topics') {
        const subjName = (change.subject as string).toLowerCase().trim();
        const subj = updatedSubjects.find((s) => ((s.name as string) || '').toLowerCase().trim() === subjName);
        if (subj) {
          const toRemove = ((change.topics as string[]) || []).map((t) => t.toLowerCase().trim());
          subj.topics = ((subj.topics as Array<Record<string, unknown>>) || []).filter(
            (t) => !toRemove.includes(((t.name as string) || '').toLowerCase().trim())
          );
        }
      } else if (action === 'rename_topic') {
        const subjName = (change.subject as string).toLowerCase().trim();
        const subj = updatedSubjects.find((s) => ((s.name as string) || '').toLowerCase().trim() === subjName);
        if (subj) {
          const oldName = (change.old_name as string).toLowerCase().trim();
          const topic = ((subj.topics as Array<Record<string, unknown>>) || []).find(
            (t) => ((t.name as string) || '').toLowerCase().trim() === oldName
          );
          if (topic) topic.name = change.new_name as string;
        }
      }
    }

    updated.subjects = updatedSubjects;

    return {
      response: result.response || 'Structure updated.',
      updated_structure: updated,
      modified: true,
    };
  } catch (parseErr) {
    console.error('[refine] JSON parse failed:', parseErr instanceof Error ? parseErr.message : parseErr);
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
    // The model must echo back the ENTIRE specs object (all subject distributions
    // etc.); 4000 tokens truncates it mid-JSON → "Unterminated string" parse error.
    { temperature: 0.1, maxTokens: 16000 }
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
