/**
 * Record, per course, whose rules decide the correct answer and what the exam's subject matter is
 * (exam_format.exam_pattern.answer_authority / subject_domain). Read by examProfile.ts for the
 * KEY_CORRECT check and answer adjudication, which until now judged every exam — CPA, LSAT, NEET PG —
 * "under current US practice" as "the final medical authority".
 *
 *   npx tsx src/scripts/setAnswerAuthority.ts [--dry]
 *
 * Matched on the course name; a course no rule matches is listed and left alone.
 */
import 'dotenv/config';
import { supabase } from '../db/supabase.js';

const US_MEDICINE = 'current US clinical practice and the major US guidelines (ACOG, ACC/AHA, IDSA, ADA, USPSTF, AAP, ATS, CDC, ACIP and the like), and the basic-science consensus of standard US medical texts';
const INDIA_MEDICINE = 'standard textbooks used in Indian medical education (Harrison, Bailey & Love, Williams, Park, Robbins, Guyton and the like) and current Indian national guidelines and programmes (MoHFW, ICMR, NTEP, NACO, the national immunisation schedule) and Indian law (MTP Act, PCPNDT Act, NMC regulations); where they differ from US or UK practice, the Indian position is correct';

const RULES: Array<{ match: RegExp; authority: string; domain: string }> = [
  { match: /USMLE/i, authority: US_MEDICINE, domain: 'medicine' },
  { match: /NCLEX/i, authority: 'the NCSBN NCLEX-RN test plan and Clinical Judgment Measurement Model, current US nursing standards of practice and evidence-based nursing guidance, nursing scope of practice and delegation rules, and current US clinical guidelines for the conditions involved; safety and prioritisation frameworks (ABCs, Maslow, acute over chronic) as NCLEX applies them', domain: 'nursing' },
  { match: /NEET PG|INICET|FMGE|UPSC CMS/i, authority: INDIA_MEDICINE, domain: 'medicine' },
  { match: /UKMLA/i, authority: 'current UK practice: NICE guidelines and Clinical Knowledge Summaries, the BNF, SIGN where NICE is silent, the UK Health Security Agency (Green Book), GMC guidance (Good Medical Practice, consent, confidentiality) and UK law (Mental Capacity Act, Mental Health Act); where they differ from US practice, the UK position is correct', domain: 'medicine' },
  { match: /\bCPA\b/i, authority: 'the AICPA Uniform CPA Examination Blueprints and the pronouncements in force for the current testing window: FASB Accounting Standards Codification, GASB standards, AICPA auditing standards (AU-C) and Code of Professional Conduct, PCAOB standards, SEC rules, the Internal Revenue Code and Treasury regulations, and US business law as the blueprints test it', domain: 'accounting' },
  { match: /\bCFA\b/i, authority: 'the CFA Institute curriculum for the level being tested, including the CFA Institute Code of Ethics and Standards of Professional Conduct and the GIPS standards; where the curriculum takes a position, that position is correct', domain: 'investment management' },
  { match: /\bMCAT\b/i, authority: 'the AAMC MCAT content outline and the established consensus of introductory college biology, biochemistry, general and organic chemistry, physics, psychology and sociology; for passage-based items, the answer the passage and its data support', domain: 'the natural, behavioural and social sciences' },
  { match: /\bLSAT\b/i, authority: 'LSAC test logic: the single answer the stimulus or passage supports under the question task as stated (strengthen, weaken, assumption, inference, flaw and so on), judged by what the text says, not by outside knowledge or opinion', domain: 'analytical and logical reasoning' },
  { match: /\bBar\b/i, authority: 'the NCBE tests\' standards: generally accepted principles of US law as the MBE and NextGen bar test them (majority rule unless the item states otherwise), the Federal Rules of Evidence and Civil Procedure, UCC Article 2, the US Constitution and Supreme Court doctrine, and the ABA Model Rules of Professional Conduct', domain: 'law' },
];

const dry = process.argv.includes('--dry');
const { data, error } = await supabase.from('qb_courses').select('id, name, exam_format');
if (error) throw new Error(error.message);
for (const c of data!) {
  const rule = RULES.find((r) => r.match.test(String(c.name)));
  if (!rule) { console.log(`  no rule: ${c.name} (${c.id})`); continue; }
  const ef = (c.exam_format || {}) as Record<string, any>;
  const pattern = { ...(ef.exam_pattern && typeof ef.exam_pattern === 'object' ? ef.exam_pattern : {}), answer_authority: rule.authority, subject_domain: rule.domain };
  console.log(`${dry ? '[dry] ' : ''}${c.name} (${String(c.id).slice(0, 8)}): ${rule.domain}`);
  if (dry) continue;
  const { error: e } = await supabase.from('qb_courses').update({ exam_format: { ...ef, exam_pattern: pattern } }).eq('id', c.id);
  if (e) console.error(`  write failed: ${e.message}`);
}
process.exit(0);
