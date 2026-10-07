/**
 * Put back an image that a restructure-mode fix removed in error, from the URL its audit trail
 * recorded (fixer.ts records image_removed on the fix entry). The restoration is logged on the trail.
 *
 *   npx tsx src/scripts/restoreRemovedImage.ts <qb_questions id> "<reason>"
 */
import 'dotenv/config';
import { supabase } from '../db/supabase.js';

const [id, reason = 'image removed in error'] = process.argv.slice(2);
const { data: q, error } = await supabase.from('qb_questions').select('id, image_url, is_image_question, audit_trail').eq('id', id).single();
if (error || !q) throw new Error(error?.message || 'not found');
if (q.image_url) { console.log(`already has an image: ${q.image_url}`); process.exit(0); }
const trail = Array.isArray(q.audit_trail) ? [...q.audit_trail] : [];
const removed = [...trail].reverse().find((e: Record<string, unknown>) => typeof e?.image_removed === 'string')?.image_removed as string | undefined;
if (!removed) throw new Error('no removed image recorded on the trail');
trail.push({ phase: 'image_restored', image_url: removed, reason, timestamp: new Date().toISOString() });
const { error: upErr } = await supabase.from('qb_questions').update({ image_url: removed, is_image_question: true, audit_trail: trail }).eq('id', id);
if (upErr) throw new Error(upErr.message);
console.log(`restored ${removed}`);
