/**
 * Draw an ECG from a specification, by arithmetic, instead of asking the image model.
 *
 * The image model draws a convincing trace with the wrong timing: asked three times for 4:3 Wenckebach
 * (PR lengthening beat by beat, then a dropped QRS) it drew a constant PR with dropped beats — Mobitz II
 * — each time, and a blind reader read it so. An earlier NCLEX rhythm strip failed the same way
 * (renderGrowthChart.py). Intervals are numbers; they are drawn here from numbers.
 *
 * A beat is a sum of smooth components — P, Q, R, S, ST plateau, T, U — placed on a timeline of atrial
 * and ventricular events that each rhythm generates (an AV block conducts or drops P waves by rule, AF
 * spaces QRS irregularly over fibrillatory waves). Each of the twelve leads scales the components by
 * its own template; bundle-branch blocks, pre-excitation, ST patterns and T-wave changes modify them.
 * The trace is drawn as SVG on standard paper (25 mm/s, 10 mm/mV, 1 mm and 5 mm grid, calibration
 * pulse) and rasterised with resvg. Deterministic: the same specification draws the same strip.
 */
import { Resvg } from '@resvg/resvg-js';
import { orCall, MODELS } from '../llm/openrouter.js';

export const LEADS = ['I', 'II', 'III', 'aVR', 'aVL', 'aVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'] as const;
export type Lead = (typeof LEADS)[number];

export const RHYTHMS = [
  'sinus', 'sinus_arrhythmia', 'first_degree_av_block', 'mobitz_1', 'mobitz_2', 'two_to_one_av_block',
  'complete_heart_block', 'atrial_fibrillation', 'atrial_flutter', 'svt', 'junctional',
  'sinus_with_pvcs', 'sinus_with_pacs', 'ventricular_tachycardia', 'torsades', 'ventricular_fibrillation',
  'sine_wave', 'asystole',
] as const;
export type Rhythm = (typeof RHYTHMS)[number];

export const ST_PATTERNS = ['none', 'inferior_stemi', 'anterior_stemi', 'lateral_stemi', 'anterolateral_stemi',
  'posterior_mi', 'pericarditis', 'subendocardial_ischemia', 'brugada', 'digoxin'] as const;

export interface EcgSpec {
  layout: 'rhythm_strip' | '12_lead';
  strip_lead?: Lead;
  rhythm: Rhythm;
  /** Ventricular rate (beats/min) for most rhythms; the sinus/atrial rate for AV blocks and flutter. */
  rate?: number;
  atrial_rate?: number;
  ventricular_rate?: number;
  pr_ms?: number;
  /** Mobitz I: PR lengthening on the second conducted beat; later increments shrink. */
  pr_increment_ms?: number;
  /** AV blocks: P waves per cycle (4 → 4:3 Wenckebach, 3 → 3:2 Mobitz II). Flutter: flutter waves per QRS. */
  conduction?: number;
  qrs_ms?: number;
  bundle?: 'none' | 'rbbb' | 'lbbb';
  delta_wave?: boolean;
  p_wave?: 'normal' | 'peaked' | 'bifid' | 'absent' | 'inverted' | 'flat';
  t_wave?: 'normal' | 'peaked' | 'inverted' | 'flat';
  /** Leads the t_wave change applies to; every lead when omitted. */
  t_wave_leads?: Lead[];
  st_pattern?: (typeof ST_PATTERNS)[number];
  /** Extra ST deviation by lead, in mV (+ elevation, − depression), added to the pattern. */
  st_mv?: Partial<Record<Lead, number>>;
  /** Leads with pathological Q waves. */
  q_waves?: Lead[];
  qt_ms?: number;
  u_waves?: boolean;
  low_voltage?: boolean;
  alternans?: boolean;
  lvh?: boolean;
  pvc_pattern?: 'isolated' | 'bigeminy' | 'trigeminy' | 'couplet';
  /** Asystole: P waves still present ("P-wave asystole"). */
  p_waves_only?: boolean;
  duration_s?: number;
}

// ── Lead templates (mV): a normal adult axis and R-wave progression ──
const TEMPLATE: Record<Lead, { p: number; q: number; r: number; s: number; t: number }> = {
  I: { p: 0.1, q: -0.05, r: 0.8, s: -0.1, t: 0.25 },
  II: { p: 0.2, q: -0.05, r: 1.2, s: -0.2, t: 0.35 },
  III: { p: 0.06, q: -0.05, r: 0.6, s: -0.2, t: 0.12 },
  aVR: { p: -0.12, q: 0, r: 0.12, s: -0.9, t: -0.28 },
  aVL: { p: 0.05, q: -0.05, r: 0.5, s: -0.25, t: 0.15 },
  aVF: { p: 0.1, q: -0.05, r: 0.9, s: -0.2, t: 0.25 },
  V1: { p: 0.07, q: 0, r: 0.2, s: -1.0, t: -0.05 },
  V2: { p: 0.1, q: 0, r: 0.4, s: -1.4, t: 0.4 },
  V3: { p: 0.1, q: 0, r: 0.8, s: -0.8, t: 0.5 },
  V4: { p: 0.1, q: -0.05, r: 1.4, s: -0.4, t: 0.5 },
  V5: { p: 0.1, q: -0.1, r: 1.3, s: -0.2, t: 0.4 },
  V6: { p: 0.1, q: -0.1, r: 1.0, s: -0.1, t: 0.3 },
};
/** Flutter and fibrillatory waves: largest in the inferior leads and V1. */
const ATRIAL_GAIN: Record<Lead, number> = { I: 0.3, II: 1, III: 1, aVR: -0.6, aVL: -0.2, aVF: 1, V1: 0.8, V2: 0.6, V3: 0.4, V4: 0.3, V5: 0.25, V6: 0.2 };
/** A ventricular ectopic / VT complex: LBBB-like, so negative in V1 and positive in V6. */
const PVC_GAIN: Record<Lead, number> = { I: 0.9, II: 1.1, III: 0.8, aVR: -1, aVL: 0.4, aVF: 0.9, V1: -1.2, V2: -1.3, V3: -0.6, V4: 0.6, V5: 1.2, V6: 1.2 };

const ST_PRESET: Record<string, Partial<Record<Lead, number>>> = {
  none: {},
  inferior_stemi: { II: 0.3, III: 0.4, aVF: 0.35, I: -0.1, aVL: -0.25 },
  anterior_stemi: { V1: 0.2, V2: 0.45, V3: 0.45, V4: 0.3, II: -0.05, III: -0.1, aVF: -0.08 },
  lateral_stemi: { I: 0.25, aVL: 0.3, V5: 0.25, V6: 0.2, III: -0.25, aVF: -0.12 },
  anterolateral_stemi: { I: 0.2, aVL: 0.25, V2: 0.35, V3: 0.4, V4: 0.4, V5: 0.3, V6: 0.2, III: -0.2, aVF: -0.1 },
  posterior_mi: { V1: -0.2, V2: -0.3, V3: -0.25 },
  pericarditis: { I: 0.15, II: 0.2, III: 0.1, aVL: 0.08, aVF: 0.15, V2: 0.15, V3: 0.2, V4: 0.2, V5: 0.2, V6: 0.15, aVR: -0.15 },
  subendocardial_ischemia: { I: -0.15, II: -0.15, aVL: -0.1, aVF: -0.1, V4: -0.2, V5: -0.25, V6: -0.2, aVR: 0.1 },
  brugada: { V1: 0.35, V2: 0.3 },
  digoxin: { I: -0.12, II: -0.15, aVF: -0.12, V4: -0.15, V5: -0.2, V6: -0.18 },
};

// ── Deterministic randomness ──
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hash(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

const g = (t: number, c: number, sd: number) => Math.exp(-0.5 * ((t - c) / sd) ** 2);
const g2 = (t: number, c: number, sdL: number, sdR: number) => g(t, c, t < c ? sdL : sdR);
const sig = (x: number) => 1 / (1 + Math.exp(-x));

interface Atrial { t: number; kind: 'p' | 'pac' }
interface Ventricular { t: number; kind: 'normal' | 'pvc' | 'escape_wide'; qrs: number; alt?: number }

/** Atrial and ventricular events for the rhythm over [−1, duration+1] s. */
function timeline(s: EcgSpec, dur: number, rand: () => number): { atrial: Atrial[]; vent: Ventricular[] } {
  const atrial: Atrial[] = [], vent: Ventricular[] = [];
  const qrs = (s.qrs_ms ?? (s.bundle && s.bundle !== 'none' ? 140 : 90)) / 1000;
  const pr = (s.pr_ms ?? (s.delta_wave ? 100 : 160)) / 1000;
  const start = -1, end = dur + 1;
  const sinusRate = s.atrial_rate ?? s.rate ?? 75;
  const pp = 60 / sinusRate;
  const conducted = (tp: number, prv = pr, kind: Ventricular['kind'] = 'normal', q = qrs) => { atrial.push({ t: tp, kind: 'p' }); vent.push({ t: tp + prv, kind, qrs: q }); };

  switch (s.rhythm) {
    case 'sinus': case 'first_degree_av_block': {
      const p = s.rhythm === 'first_degree_av_block' ? Math.max(pr, 0.3) : pr;
      for (let t = start; t < end; t += pp) conducted(t, p);
      break;
    }
    case 'sinus_arrhythmia': {
      for (let t = start, k = 0; t < end; k++) { conducted(t); t += pp * (1 + 0.22 * Math.sin(k * 0.9)); }
      break;
    }
    case 'mobitz_1': {
      const n = Math.max(3, Math.round(s.conduction ?? 4));
      const inc = (s.pr_increment_ms ?? 120) / 1000;
      const pr0 = s.pr_ms ? s.pr_ms / 1000 : 0.18;
      for (let t = start, k = 0; t < end; t += pp, k++) {
        const i = k % n;
        if (i === n - 1) { atrial.push({ t, kind: 'p' }); continue; }
        // Increments shrink beat by beat (classic Wenckebach): inc, 0.55·inc, 0.35·inc …
        let p = pr0; for (let j = 1; j <= i; j++) p += inc * [1, 0.55, 0.35, 0.25, 0.2][Math.min(j - 1, 4)];
        conducted(t, p);
      }
      break;
    }
    case 'mobitz_2': case 'two_to_one_av_block': {
      const n = s.rhythm === 'two_to_one_av_block' ? 2 : Math.max(3, Math.round(s.conduction ?? 3));
      for (let t = start, k = 0; t < end; t += pp, k++) {
        if (k % n === n - 1) atrial.push({ t, kind: 'p' }); else conducted(t);
      }
      break;
    }
    case 'complete_heart_block': {
      const ar = s.atrial_rate ?? s.rate ?? 80, vr = s.ventricular_rate ?? 38;
      for (let t = start; t < end; t += 60 / ar) atrial.push({ t, kind: 'p' });
      const q = (s.qrs_ms ?? 140) / 1000;
      for (let t = start + 0.37; t < end; t += 60 / vr) vent.push({ t, kind: q >= 0.12 ? 'escape_wide' : 'normal', qrs: q });
      break;
    }
    case 'atrial_fibrillation': {
      const rr = 60 / (s.ventricular_rate ?? s.rate ?? 110);
      for (let t = start; t < end; t += rr * (0.55 + 0.9 * rand())) vent.push({ t, kind: 'normal', qrs });
      break;
    }
    case 'atrial_flutter': {
      const fr = 60 / (s.atrial_rate ?? 300), n = Math.max(2, Math.round(s.conduction ?? 2));
      for (let t = start, k = 0; t < end; t += fr, k++) if (k % n === 0) vent.push({ t: t + 0.26, kind: 'normal', qrs });
      break;
    }
    case 'svt': case 'junctional': {
      const rr = 60 / (s.rate ?? (s.rhythm === 'svt' ? 190 : 50));
      for (let t = start; t < end; t += rr) vent.push({ t, kind: 'normal', qrs });
      break;
    }
    case 'sinus_with_pvcs': case 'sinus_with_pacs': {
      const pat = s.pvc_pattern ?? 'isolated';
      const every = pat === 'bigeminy' ? 2 : pat === 'trigeminy' ? 3 : 4;
      for (let t = start, k = 0; t < end; k++) {
        conducted(t);
        if ((k + 1) % every === 0) {
          if (s.rhythm === 'sinus_with_pvcs') {
            vent.push({ t: t + pr + pp * 0.48, kind: 'pvc', qrs: 0.16 });
            if (pat === 'couplet') vent.push({ t: t + pr + pp * 0.95, kind: 'pvc', qrs: 0.16 });
            t += pp * 2; // compensatory pause: the next sinus beat is on time
          } else {
            const tp = t + pp * 0.6; atrial.push({ t: tp, kind: 'pac' }); vent.push({ t: tp + pr, kind: 'normal', qrs });
            t = tp + pp; // non-compensatory: the sinus node is reset
          }
        } else t += pp;
      }
      break;
    }
    case 'ventricular_tachycardia': {
      const rr = 60 / (s.rate ?? 170);
      for (let t = start; t < end; t += rr) vent.push({ t, kind: 'pvc', qrs: (s.qrs_ms ?? 160) / 1000 });
      // AV dissociation: sinus P waves march through
      for (let t = start + 0.13; t < end; t += 60 / 75) atrial.push({ t, kind: 'p' });
      break;
    }
    case 'asystole': {
      if (s.p_waves_only) for (let t = start; t < end; t += 60 / (s.atrial_rate ?? s.rate ?? 60)) atrial.push({ t, kind: 'p' });
      break;
    }
    default: break; // torsades, VF and sine wave are continuous waveforms (continuous())
  }
  if (s.alternans) vent.forEach((v, i) => { v.alt = i % 2 ? 0.55 : 1; });
  return { atrial, vent };
}

interface Built { spec: EcgSpec; dur: number; atrial: Atrial[]; vent: Ventricular[]; phase: number[] }

function build(spec: EcgSpec): Built {
  const dur = spec.duration_s ?? 10;
  const rand = rng(hash(JSON.stringify(spec)));
  const { atrial, vent } = timeline(spec, dur, rand);
  return { spec, dur, atrial, vent, phase: Array.from({ length: 6 }, () => rand() * 6.283) };
}

/** Continuous rhythms with no discrete beats. */
function continuous(b: Built, lead: Lead, t: number): number | null {
  const s = b.spec, gain = PVC_GAIN[lead];
  if (s.rhythm === 'ventricular_fibrillation') {
    const env = 0.35 + 0.25 * Math.sin(t * 0.9 + b.phase[0]);
    return gain * env * (Math.sin(2 * Math.PI * 4.7 * t + b.phase[1]) + 0.6 * Math.sin(2 * Math.PI * 6.1 * t + b.phase[2]) + 0.35 * Math.sin(2 * Math.PI * 8.3 * t + b.phase[3])) / 1.4;
  }
  if (s.rhythm === 'torsades') {
    const f = (s.rate ?? 230) / 60, cyc = 2.6;
    // Polymorphic complexes whose amplitude waxes and wanes and whose polarity twists around the baseline.
    const env = Math.sin(Math.PI * t / cyc);
    const w = Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t + 0.6);
    return Math.abs(gain) * 1.25 * env * w;
  }
  if (s.rhythm === 'sine_wave') {
    const f = (s.rate ?? 70) / 60;
    return gain * 0.9 * Math.sin(2 * Math.PI * f * t) * (1 + 0.15 * Math.sin(4 * Math.PI * f * t));
  }
  return null;
}

/** The signal of one lead at time t, in mV. */
function sample(b: Built, lead: Lead, t: number): number {
  const s = b.spec, T = TEMPLATE[lead];
  const vol = s.low_voltage ? 0.35 : 1;
  const wander = 0.02 * Math.sin(2 * Math.PI * 0.18 * t + b.phase[4]) + 0.004 * Math.sin(2 * Math.PI * 33 * t + b.phase[5]);
  const cont = continuous(b, lead, t);
  if (cont !== null) return cont * vol + wander;
  let v = 0;

  // Atrial activity
  if (s.rhythm === 'atrial_fibrillation') {
    v += ATRIAL_GAIN[lead] * 0.05 * (Math.sin(2 * Math.PI * 6.1 * t + b.phase[0]) + 0.7 * Math.sin(2 * Math.PI * 7.4 * t + b.phase[1]) + 0.5 * Math.sin(2 * Math.PI * 9.3 * t + b.phase[2]));
  } else if (s.rhythm === 'atrial_flutter') {
    const fr = 60 / (s.atrial_rate ?? 300);
    const x = ((t / fr) % 1 + 1) % 1; // slow downslope, quick return: the inferior-lead sawtooth
    const saw = x < 0.78 ? -x / 0.78 : -(1 - x) / 0.22;
    v += ATRIAL_GAIN[lead] * 0.32 * (saw + 0.5);
  } else if (s.p_wave !== 'absent' && s.rhythm !== 'svt' && s.rhythm !== 'junctional') {
    for (const a of b.atrial) {
      if (Math.abs(t - a.t - 0.05) > 0.2) continue;
      let amp = T.p * (s.p_wave === 'flat' ? 0.3 : s.p_wave === 'inverted' ? -1 : a.kind === 'pac' ? 0.7 : 1);
      if (s.p_wave === 'peaked' && ['II', 'III', 'aVF'].includes(lead)) amp = 0.3;
      if (s.p_wave === 'bifid') v += amp * 0.85 * (g(t, a.t + 0.035, 0.018) + g(t, a.t + 0.09, 0.02));
      else v += amp * g(t, a.t + 0.05, s.p_wave === 'peaked' ? 0.016 : 0.022);
    }
  }
  if (s.rhythm === 'junctional') {
    // Retrograde P just after the QRS, inverted in the inferior leads
    for (const q of b.vent) v += -0.6 * T.p * g(t, q.t + q.qrs + 0.06, 0.018);
  }

  // Ventricular complexes
  const qt0 = (s.qt_ms ?? 0) / 1000;
  const stDev = ((ST_PRESET[s.st_pattern ?? 'none'] ?? {})[lead] ?? 0) + (s.st_mv?.[lead] ?? 0);
  const tApplies = !s.t_wave_leads?.length || s.t_wave_leads.includes(lead);
  for (let i = 0; i < b.vent.length; i++) {
    const q = b.vent[i];
    if (t < q.t - 0.15 || t > q.t + 0.9) continue;
    const prevRR = i > 0 ? q.t - b.vent[i - 1].t : 0.8;
    const qt = qt0 || 0.4 * Math.sqrt(Math.min(Math.max(prevRR, 0.3), 1.6));
    const d = q.qrs, x = t - q.t, alt = q.alt ?? 1;
    if (q.kind === 'pvc' || q.kind === 'escape_wide') {
      // Wide, bizarre complex with a discordant T and no ST plateau of its own.
      const gn = PVC_GAIN[lead];
      v += gn * alt * (1.1 * g(x, 0.45 * d, 0.2 * d) - 0.35 * g(x, 0.85 * d, 0.13 * d));
      v += -gn * 0.38 * g2(x, d + 0.17, 0.06, 0.05);
      continue;
    }
    let r = T.r, sA = T.s, qA = T.q, tA = T.t;
    if (s.lvh && ['V5', 'V6', 'I', 'aVL'].includes(lead)) { r *= 2.1; tA = -0.25; }
    if (s.lvh && ['V1', 'V2'].includes(lead)) sA *= 2.0;
    if (s.st_pattern === 'posterior_mi' && ['V1', 'V2'].includes(lead)) { r = 0.9; sA = -0.3; tA = 0.45; }
    if (s.q_waves?.includes(lead)) { qA = -0.45; r *= 0.45; }
    if (s.delta_wave) v += r * alt * 0.33 * g(x, -0.025, 0.03);
    if (s.bundle === 'rbbb') {
      if (['V1', 'V2'].includes(lead)) { v += alt * (0.25 * g(x, 0.22 * d, 0.1 * d) - 0.35 * g(x, 0.45 * d, 0.08 * d) + 0.85 * g(x, 0.72 * d, 0.12 * d)); tA = -0.22; }
      else { v += alt * (qA * g(x, 0.12 * d, 0.06 * d) + r * g(x, 0.3 * d, 0.1 * d) + (['I', 'aVL', 'V5', 'V6'].includes(lead) ? -0.4 : sA * 0.6) * g(x, 0.72 * d, 0.14 * d)); }
    } else if (s.bundle === 'lbbb') {
      if (['V1', 'V2', 'V3'].includes(lead)) { v += alt * (0.08 * g(x, 0.15 * d, 0.06 * d) - 1.5 * g(x, 0.55 * d, 0.2 * d)); tA = 0.45; }
      else if (['I', 'aVL', 'V5', 'V6'].includes(lead)) { v += alt * (1.0 * g(x, 0.38 * d, 0.13 * d) + 1.05 * g(x, 0.7 * d, 0.13 * d)); tA = -0.32; }
      else v += alt * (r * 0.8 * g(x, 0.5 * d, 0.2 * d) + sA * g(x, 0.85 * d, 0.1 * d));
    } else {
      v += alt * (qA * g(x, 0.15 * d, 0.07 * d) + r * g(x, 0.45 * d, 0.12 * d) + sA * g(x, 0.78 * d, 0.1 * d));
    }
    // ST deviation: a plateau from the J point into the T wave.
    const tc = qt - 0.08;
    let st = stDev;
    if (s.bundle === 'lbbb' && !stDev) st = ['V1', 'V2', 'V3'].includes(lead) ? 0.2 : ['I', 'aVL', 'V5', 'V6'].includes(lead) ? -0.1 : 0;
    if (st) {
      if (s.st_pattern === 'digoxin') v += st * sig((x - d) / 0.01) * sig((tc - x) / 0.04) * (1 - 0.6 * Math.sin(Math.PI * Math.min(Math.max((x - d) / (tc - d), 0), 1)));
      else v += st * sig((x - d) / 0.006) * sig((tc + 0.02 - x) / 0.025);
    }
    // T wave
    let tAmp = tA, sdL = 0.055, sdR = 0.038;
    if (tApplies && s.t_wave === 'peaked') { tAmp = Math.max(Math.abs(tA) * 2.8, 0.7) * (lead === 'aVR' ? -1 : 1); sdL = 0.03; sdR = 0.028; }
    if (tApplies && s.t_wave === 'inverted') tAmp = -Math.max(Math.abs(tA), 0.2);
    if (tApplies && s.t_wave === 'flat') tAmp = tA * 0.15;
    if (s.st_pattern === 'brugada' && ['V1', 'V2'].includes(lead)) tAmp = -0.25;
    if (s.st_pattern === 'pericarditis' && lead !== 'aVR') v += -0.06 * g(x, -0.06, 0.03); // PR depression
    v += tAmp * g2(x, tc, sdL, sdR);
    if (s.u_waves) v += 0.12 * Math.sign(T.t || 1) * g(x, tc + 0.15, 0.035);
  }
  return v * vol + wander;
}

// ── Drawing ──
const MM = 6; // px per mm
const FONT = 'Helvetica, Arial, sans-serif';

function grid(x0: number, y0: number, w: number, h: number): string {
  const lines: string[] = [];
  for (let mm = 0; mm * MM <= w; mm++) lines.push(`<line x1="${x0 + mm * MM}" y1="${y0}" x2="${x0 + mm * MM}" y2="${y0 + h}" stroke="${mm % 5 ? '#f5c4cc' : '#e8909f'}" stroke-width="${mm % 5 ? 0.6 : 1.2}"/>`);
  for (let mm = 0; mm * MM <= h; mm++) lines.push(`<line x1="${x0}" y1="${y0 + mm * MM}" x2="${x0 + w}" y2="${y0 + mm * MM}" stroke="${mm % 5 ? '#f5c4cc' : '#e8909f'}" stroke-width="${mm % 5 ? 0.6 : 1.2}"/>`);
  return lines.join('');
}

function trace(b: Built, lead: Lead, t0: number, t1: number, x0: number, yBase: number): string {
  const pts: string[] = [];
  for (let t = t0; t <= t1 + 1e-9; t += 0.004) pts.push(`${(x0 + (t - t0) * 25 * MM).toFixed(1)},${(yBase - sample(b, lead, t) * 10 * MM).toFixed(1)}`);
  return `<polyline points="${pts.join(' ')}" fill="none" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/>`;
}

function calPulse(x: number, yBase: number): string {
  const w = 5 * MM, h = 10 * MM;
  return `<polyline points="${x},${yBase} ${x + MM},${yBase} ${x + MM},${yBase - h} ${x + MM + w},${yBase - h} ${x + MM + w},${yBase} ${x + 2 * MM + w},${yBase}" fill="none" stroke="#111" stroke-width="1.6"/>`;
}

const label = (x: number, y: number, s: string) => `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${4 * MM}" font-weight="bold" fill="#111">${s}</text>`;

export function renderEcgSvg(spec: EcgSpec): string {
  const b = build(spec);
  const padL = 10 * MM, padR = 4 * MM;
  if (spec.layout === 'rhythm_strip') {
    const dur = b.dur, w = dur * 25 * MM, rowH = 40 * MM, W = padL + w + padR, H = rowH + 12 * MM;
    const yb = 26 * MM;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#fff8f9"/>${grid(0, 0, W, rowH + 6 * MM)}${calPulse(MM, yb)}${label(padL + MM, 6 * MM, spec.strip_lead ?? 'II')}${trace(b, spec.strip_lead ?? 'II', 0, dur, padL, yb)}${label(MM, H - 2 * MM, '25 mm/s   10 mm/mV').replace(`font-size="${4 * MM}" font-weight="bold"`, `font-size="${3 * MM}"`)}</svg>`;
  }
  const colW = 2.5 * 25 * MM, rowH = 34 * MM, W = padL + 4 * colW + padR, H = 4 * rowH + 10 * MM;
  const rows: Lead[][] = [['I', 'aVR', 'V1', 'V4'], ['II', 'aVL', 'V2', 'V5'], ['III', 'aVF', 'V3', 'V6']];
  let body = '';
  rows.forEach((row, r) => {
    const yb = r * rowH + rowH * 0.62;
    body += calPulse(MM, yb);
    row.forEach((lead, c) => {
      const x0 = padL + c * colW;
      body += trace(b, lead, c * 2.5, c * 2.5 + 2.5, x0, yb) + label(x0 + MM, r * rowH + 6 * MM, lead);
      if (c) body += `<line x1="${x0}" y1="${yb - 3 * MM}" x2="${x0}" y2="${yb + 3 * MM}" stroke="#111" stroke-width="1.6"/>`;
    });
  });
  const ybR = 3 * rowH + rowH * 0.62;
  body += calPulse(MM, ybR) + trace(b, spec.strip_lead ?? 'II', 0, 10, padL, ybR) + label(padL + MM, 3 * rowH + 6 * MM, spec.strip_lead ?? 'II');
  body += `<text x="${MM}" y="${H - 2 * MM}" font-family="${FONT}" font-size="${3 * MM}" fill="#111">25 mm/s   10 mm/mV</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#fff8f9"/>${grid(0, 0, W, H - 6 * MM)}${body}</svg>`;
}

export function renderEcgPng(spec: EcgSpec): Buffer {
  return new Resvg(renderEcgSvg(spec), { font: { loadSystemFonts: true }, background: '#fff8f9' }).render().asPng();
}

/** Is this item's image an ECG (by its type, description or stem)? */
export function isEcgImage(q: Record<string, unknown>): boolean {
  return /\becg\b|\bekg\b|electrocardiogra|rhythm strip|\btracing\b.*\b(heart|cardiac|rhythm)|\b12[- ]lead\b/i
    .test(`${q.image_type || ''} ${q.image_description || ''} ${String(q.question || '').slice(0, 300)}`);
}

function sanitize(v: Record<string, any>): EcgSpec | null {
  if (!RHYTHMS.includes(v.rhythm)) return null;
  const leads = (x: unknown) => (Array.isArray(x) ? x.filter((l) => (LEADS as readonly string[]).includes(l)) : undefined) as Lead[] | undefined;
  const num = (x: unknown, lo: number, hi: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : undefined);
  const st: Partial<Record<Lead, number>> = {};
  if (v.st_mv && typeof v.st_mv === 'object') for (const [k, x] of Object.entries(v.st_mv)) if ((LEADS as readonly string[]).includes(k) && typeof x === 'number') st[k as Lead] = Math.max(-0.6, Math.min(0.8, x));
  return {
    layout: v.layout === '12_lead' ? '12_lead' : 'rhythm_strip',
    strip_lead: (LEADS as readonly string[]).includes(v.strip_lead) ? v.strip_lead : 'II',
    rhythm: v.rhythm,
    rate: num(v.rate, 15, 320), atrial_rate: num(v.atrial_rate, 30, 360), ventricular_rate: num(v.ventricular_rate, 15, 250),
    pr_ms: num(v.pr_ms, 60, 500), pr_increment_ms: num(v.pr_increment_ms, 20, 250), conduction: num(v.conduction, 2, 8),
    qrs_ms: num(v.qrs_ms, 60, 240), bundle: ['rbbb', 'lbbb'].includes(v.bundle) ? v.bundle : 'none', delta_wave: v.delta_wave === true,
    p_wave: ['peaked', 'bifid', 'absent', 'inverted', 'flat'].includes(v.p_wave) ? v.p_wave : 'normal',
    t_wave: ['peaked', 'inverted', 'flat'].includes(v.t_wave) ? v.t_wave : 'normal', t_wave_leads: leads(v.t_wave_leads),
    st_pattern: (ST_PATTERNS as readonly string[]).includes(v.st_pattern) ? v.st_pattern : 'none', st_mv: st, q_waves: leads(v.q_waves),
    qt_ms: num(v.qt_ms, 250, 700), u_waves: v.u_waves === true, low_voltage: v.low_voltage === true, alternans: v.alternans === true, lvh: v.lvh === true,
    pvc_pattern: ['bigeminy', 'trigeminy', 'couplet'].includes(v.pvc_pattern) ? v.pvc_pattern : 'isolated', p_waves_only: v.p_waves_only === true,
  };
}

/**
 * The ECG specification for a question, written by a text model from the stem, options, key and
 * explanation. Null when the finding is not one this renderer draws (the caller falls back to the
 * image model) — the model answers "unsupported" rather than force a rhythm.
 */
export async function specifyEcg(q: Record<string, unknown>, feedback?: string): Promise<EcgSpec | null> {
  const o = (q.options || {}) as Record<string, string>;
  const k = String(q.correct_option ?? '');
  const prompt = `An exam question needs an ECG image. Specify the ECG that a cardiologist would read as supporting the correct answer, as a textbook example, using ONLY the fields below. It will be drawn exactly from your numbers.

QUESTION: ${String(q.question || '').slice(0, 2000)}
OPTIONS: ${Object.keys(o).sort().map((L) => `${L}. ${o[L]}${L === k ? ' (correct)' : ''}`).join(' | ')}
EXPLANATION: ${String(q.explanation || '').replace(/\s+/g, ' ').slice(0, 1500)}
${q.image_description ? `DESCRIPTION OF THE IMAGE: ${String(q.image_description).slice(0, 1000)}\n` : ''}${feedback ? `A PREVIOUS DRAWING FROM YOUR SPECIFICATION WAS READ WRONGLY; MAKE THE DECISIVE FEATURE UNMISTAKABLE: ${feedback.slice(0, 1200)}\n` : ''}
FIELDS
- layout: "rhythm_strip" (a single lead, for rhythm and conduction questions) or "12_lead" (for ST changes, territory, axis, bundle branch block, chamber enlargement, pre-excitation).
- strip_lead: lead for the rhythm strip ("II" by default; "V1" for flutter waves or RBBB).
- rhythm: one of ${RHYTHMS.join(', ')}.
- rate (ventricular rate; for sinus-driven rhythms and AV blocks the sinus rate), atrial_rate, ventricular_rate (complete heart block), pr_ms, pr_increment_ms (mobitz_1: added PR on the 2nd conducted beat), conduction (AV blocks: P waves per cycle — 4 means 4:3 Wenckebach, 3 means 3:2 Mobitz II; flutter: flutter waves per QRS).
- qrs_ms, bundle ("none" | "rbbb" | "lbbb"), delta_wave (true for WPW, with pr_ms about 100).
- p_wave ("normal" | "peaked" | "bifid" | "absent" | "inverted" | "flat"), t_wave ("normal" | "peaked" | "inverted" | "flat") with t_wave_leads (leads it applies to; omit for all).
- st_pattern (${ST_PATTERNS.join(' | ')}), st_mv (extra ST deviation by lead in mV, e.g. {"V2": 0.3}), q_waves (leads with pathological Q waves), qt_ms (only if the QT is the point), u_waves, low_voltage, alternans, lvh.
- pvc_pattern ("isolated" | "bigeminy" | "trigeminy" | "couplet") for sinus_with_pvcs; p_waves_only for P-wave asystole.
Use realistic textbook values (e.g. hyperkalaemia: t_wave peaked, p_wave flat, qrs_ms 130; complete heart block: atrial_rate 80, ventricular_rate 38). If the finding cannot be expressed with these fields (e.g. a pacemaker rhythm, a specific axis deviation), return {"unsupported": true}.

Return JSON only.`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await orCall(MODELS.VALIDATOR, '', prompt, { maxTokens: 1200, jsonMode: true });
      const v = JSON.parse(r.content.match(/\{[\s\S]*\}/)?.[0] ?? r.content);
      if (v.unsupported) return null;
      const s = sanitize(v);
      if (s) return s;
    } catch { /* one more attempt */ }
  }
  return null;
}
