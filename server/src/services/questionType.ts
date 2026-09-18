/**
 * question_type — the PRESENTATION MEDIUM of a question's stimulus, orthogonal
 * to format_type (mcq/sata/case_study/tbs/…):
 *   - 'text'     → no visual/document stimulus (plain stem)
 *   - 'image'    → a GENUINE visual is required (x-ray, ECG, histology, photo,
 *                   diagram, chart, gel, …) — keep as a generated image
 *   - 'markdown' → the stimulus is a DOCUMENT / DATA structure (workpaper,
 *                   financial statement, schedule, K-1, ledger, contract,
 *                   matrix, TBS exhibits) — should be Markdown text/tables,
 *                   never an image
 *
 * The raw image and/or markdown are both carried in the exported JSON so a
 * downstream product can render whichever applies.
 */

// Document / data stimuli that belong in Markdown (tables, workpapers, forms…).
const DOC_MARKDOWN_RX =
  /scan|document|financ|statement|schedule|trial[\s-]?balance|ledger|invoice|memo\b|letter|\bform\b|report|dashboard|table|spreadsheet|worksheet|workpaper|register|contract|filing|questionnaire|policy|receipt|disclosure|footnote|journal[\s-]?entry|reconcil|k-?1|m-?1|term[\s-]?sheet|matrix|listing|rollforward|workbook|abstract|agreement|balance[\s-]?sheet|income[\s-]?statement|cash[\s-]?flow|amortization|depreciation[\s-]?schedule|system[\s-]?description|access[\s-]?control/i;

// Genuine visuals that MUST stay images.
const VISUAL_RX =
  /x-?ray|radiograph|\bct\b|\bmri\b|ultrasound|sonograph|ecg|ekg|electrocardiogram|rhythm[\s-]?strip|telemetry|echocardiogram|histolog|patholog|microscop|cytolog|smear|\bgel\b|blot|anatomy|anatomic|dermat|rash|lesion|wound|specimen|photograph|photo\b|\bphoto|fundus|retina|oral[\s-]?cavity|radiolog|imaging|diagram|flow[\s-]?chart|\bgraph\b|\bchart\b|\bplot\b|\bmap\b|illustration|figure|infusion[\s-]?pump|monitor[\s-]?display|waveform|micrograph/i;

/**
 * Classify the INTENDED presentation medium of a question, from its format and
 * declared image_type. Data-driven, domain-agnostic.
 */
export function classifyQuestionType(q: Record<string, unknown>): 'text' | 'image' | 'markdown' {
  const formatType = (q.format_type as string)
    || ((q.tags as Record<string, unknown>)?.format_type as string)
    || 'mcq_single';
  const content = (q.content as Record<string, unknown>) || {};

  // TBS / performance tasks / anything already carrying markdown exhibits → markdown.
  if (formatType === 'task_based_simulation' || formatType === 'tbs' || formatType === 'performance_task') return 'markdown';
  if (Array.isArray(content.exhibits) && (content.exhibits as unknown[]).length > 0) return 'markdown';

  const imageType = ((q.image_type as string) || (content.image_type as string) || '').trim();
  const isImageQ = Boolean(q.is_image_question || content.is_image_question);

  if (isImageQ || imageType) {
    // A document/data "image" should be markdown; a genuine visual stays image.
    if (DOC_MARKDOWN_RX.test(imageType) && !VISUAL_RX.test(imageType)) return 'markdown';
    return 'image';
  }
  return 'text';
}

/** What medium the question's stored content ACTUALLY provides right now. */
export function currentQuestionMedium(q: Record<string, unknown>): 'text' | 'image' | 'markdown' {
  const content = (q.content as Record<string, unknown>) || {};
  if (Array.isArray(content.exhibits) && (content.exhibits as unknown[]).length > 0) return 'markdown';
  if (q.image_url || content.image_url) return 'image';
  return 'text';
}

/**
 * A question needs markdown regeneration when its INTENDED medium is markdown
 * but its stored content is still an image (or has no exhibits yet).
 */
export function needsMarkdownRegeneration(q: Record<string, unknown>): boolean {
  return classifyQuestionType(q) === 'markdown' && currentQuestionMedium(q) !== 'markdown';
}
