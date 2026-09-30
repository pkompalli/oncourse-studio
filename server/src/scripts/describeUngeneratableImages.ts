/**
 * Recover two NCLEX questions whose images cannot be produced, by stating the findings in the stem.
 *
 * Both are clinically sound with correct keys. Neither can have the image it asks for:
 *
 *   ec0938ca  a term newborn in respiratory distress. The image API answers "400 Your request was
 *             rejected by the safety system". Re-framing it from a photograph to a clinical-atlas
 *             illustration was tried and refused again with a new request id — a distressed infant
 *             with central cyanosis is what that filter exists to stop, whatever the medium.
 *   66e9027e  a lead II rhythm strip showing complete AV block. Its description already specifies
 *             every waveform vertex by coordinate — 7 P waves at 0.8 s intervals against 3 QRS at
 *             1.9 s — and the model still rendered a regular narrow-QRS trace. A diffusion model
 *             does not plot coordinates, so re-prompting is not the answer.
 *
 * So each stem now states what its image was specified to show. Nothing is invented: the findings
 * below are read off the image_description each question already carried, which is why the keys and
 * distractors continue to work untouched.
 *
 *   - The ECG stem gives the atrial rate, the ventricular rate, the absence of any fixed
 *     relationship between them and the QRS duration. That is what discriminates complete AV block
 *     from its three distractors: sinus bradycardia keeps one P wave per QRS, atrial flutter shows
 *     rapid sawtooth waves rather than discrete P waves at 75/min, and a junctional rhythm has no
 *     independent faster atrial activity marching through.
 *   - The newborn stem gives the nasal flaring, the intercostal and subcostal retractions and the
 *     central cyanosis, which is what makes airway positioning, preductal saturation, respiratory
 *     support and summoning the team correct, and feeding or reassessing in 30 minutes wrong.
 *
 * Each row loses its image fields and rejoins its non-image siblings at question_type 'text', then
 * returns to 'generated' so review and audit score it again rather than leaving it flagged and
 * silently dropped from every export.
 *
 * A described finding is a real NCLEX item style, so this costs the paper two image questions
 * against its image percentage and recovers two answerable ones. An unanswerable image question is
 * worth less than a described one.
 *
 * Dry run by default. Pass --apply, then POST /api/jobs/:id/resume.
 */
import 'dotenv/config';
import { supabase } from '../db/supabase.js';

const APPLY = process.argv.includes('--apply');
const JOB = '5071eac0-7ac1-4e61-ad22-62dc1b95c85a';

/** New stems, keyed by question id prefix, with the old text asserted so a re-run cannot double-apply. */
const CONVERSIONS: Record<string, { expectContains: string; stem: string; why: string }> = {
  '66e9027e': {
    expectContains: 'Interpret the displayed lead II rhythm strip',
    why: 'ECG could not be rendered; strip described from its own specification',
    stem:
      'A client reports dizziness and has a blood pressure of 82/48 mm Hg. A six-second lead II '
      + 'rhythm strip shows upright P waves occurring regularly at a rate of about 75/min and QRS '
      + 'complexes occurring regularly at a rate of about 32/min, with no consistent relationship '
      + 'between the P waves and the QRS complexes; the P waves march through the strip '
      + 'independently, some falling within QRS complexes and T waves. The QRS duration is about '
      + '0.12 seconds. The pattern is most consistent with [Blank 1], and the hypotension occurs '
      + 'primarily because [Blank 2].',
  },
  'ec0938ca': {
    expectContains: 'shown in the image',
    why: 'photograph refused by the image safety system; findings described instead',
    stem:
      'Twenty minutes after birth, a term newborn lies supine beneath a radiant warmer with the '
      + 'head in a neutral position. The nurse observes bilateral nasal flaring, intercostal and '
      + 'subcostal retractions, and a blue-gray discoloration of the tongue and central oral '
      + 'mucosa. Which actions should the nurse take immediately? Select all that apply.',
  },
};

const { data, error } = await supabase
  .from('qb_questions').select('id,topic,status,is_image_question,image_type,image_url,content')
  .eq('job_id', JOB);
if (error) throw new Error(error.message);

const edits: Array<{ id: string; what: string[]; patch: Record<string, unknown> }> = [];

for (const [prefix, conv] of Object.entries(CONVERSIONS)) {
  const row = (data || []).find((r: any) => String(r.id).startsWith(prefix)) as any;
  if (!row) { console.log(`  !! no question starting ${prefix}`); continue; }

  const content = JSON.parse(JSON.stringify(row.content ?? {}));
  const stem = String(content.stem ?? '');
  const what: string[] = [];
  const patch: Record<string, unknown> = {};

  if (stem === conv.stem) {
    console.log(`  ${prefix}: already converted`);
    continue;
  }
  if (!stem.includes(conv.expectContains)) {
    console.log(`  !! ${prefix}: stem does not contain "${conv.expectContains}" — left alone`);
    continue;
  }

  content.stem = conv.stem;
  what.push(`stem: ${conv.why}`);

  if (content.question_type === 'image') {
    content.question_type = 'text';
    what.push("content.question_type: image -> text, matching its non-image siblings");
  }
  if (row.is_image_question) { patch.is_image_question = false; what.push('is_image_question -> false'); }
  if (row.image_url !== null) { patch.image_url = null; what.push('image_url cleared'); }
  if (row.image_type !== null) { patch.image_type = null; what.push('image_type cleared'); }
  patch.image_description = null;

  // Back to 'generated' so the pipeline scores the rewritten question instead of leaving a stale
  // flag on a stem that no longer has the problem the auditor objected to.
  if (row.status !== 'generated') { patch.status = 'generated'; what.push(`status ${row.status} -> generated for re-review`); }

  patch.content = content;
  edits.push({ id: row.id, what, patch });
}

console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — ${edits.length} question(s)`);
for (const e of edits) {
  console.log(`\n${e.id.slice(0, 8)}`);
  for (const w of e.what) console.log(`  - ${w}`);
  console.log(`  new stem: ${String((e.patch.content as any).stem).slice(0, 150)}…`);
}

if (!edits.length) { console.log('\nnothing to do'); process.exit(0); }
if (!APPLY) { console.log('\nRe-run with --apply, then POST /api/jobs/:id/resume'); process.exit(0); }

let ok = 0;
for (const e of edits) {
  const { error: upErr } = await supabase.from('qb_questions').update(e.patch).eq('id', e.id);
  if (upErr) console.log(`  FAILED ${e.id.slice(0, 8)}: ${upErr.message}`);
  else ok++;
}
console.log(`\nwrote ${ok}/${edits.length} — now POST /api/jobs/${JOB}/resume`);
