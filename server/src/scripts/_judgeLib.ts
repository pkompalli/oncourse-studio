export { orCall } from '../services/llm/openrouter.js';

/** The first balanced JSON object in a reply, wherever it sits. */
export function extractJson(raw: string): Record<string, any> {
  const t = raw.trim();
  for (let s = t.indexOf('{'); s >= 0; s = t.indexOf('{', s + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = s; i < t.length; i++) {
      const c = t[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true; else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { try { return JSON.parse(t.slice(s, i + 1)); } catch { break; } }
    }
  }
  throw new Error(`no JSON in judge reply: ${t.slice(0, 80)}`);
}
