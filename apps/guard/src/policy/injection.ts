/**
 * Heuristic prompt-injection detector.
 *
 * The agent's "reason" for a payment is text the agent wrote, often paraphrasing content
 * it just read (a product page, an email). When that content was hostile, traces of the
 * attack tend to leak into the reason: instruction overrides, secrecy demands, urgency,
 * and requests for untraceable value (gift cards, crypto). We score those traces.
 *
 * Heuristics are fast, deterministic and explainable. An optional LLM classifier
 * (see llmClassifier.ts) can add a second opinion for paraphrased attacks.
 */

export interface InjectionSignal {
  id: string;
  weight: number;
  match: string;
}

export interface InjectionResult {
  score: number;
  signals: InjectionSignal[];
  source: 'heuristic' | 'heuristic+llm';
  llmRationale?: string;
}

interface Pattern {
  id: string;
  weight: number;
  re: RegExp;
}

const PATTERNS: Pattern[] = [
  {
    id: 'instruction_override',
    weight: 60,
    re: /\b(ignore|forget|disregard)\b.{0,30}\b(previous|prior|above|earlier|all|your|the)\b.{0,20}\b(instructions?|prompts?|rules?|guidelines?|directions?)\b/i,
  },
  {
    id: 'role_hijack',
    weight: 40,
    re: /\b(you are now|new instructions?|system prompt|developer (message|mode)|act as (an? )?(admin|administrator|root))\b/i,
  },
  {
    id: 'secrecy',
    weight: 50,
    re: /\b(do not|don't|never)\b.{0,15}\b(tell|inform|notify|alert|mention|ask)\b.{0,15}\b(the )?(user|owner|human|customer|anyone)\b/i,
  },
  {
    id: 'guard_evasion',
    weight: 50,
    re: /\b(bypass|override|disable|skip|circumvent|avoid)\b.{0,25}\b(limit|limits|guard|policy|policies|approval|check|checks|verification|firewall)\b/i,
  },
  {
    id: 'false_authority',
    weight: 25,
    re: /\b(authori[sz]ed|approved|requested|instructed)\s+by\s+(the\s+)?(admin|administrator|ceo|owner|security team|it department|management)\b/i,
  },
  { id: 'gift_cards', weight: 25, re: /\bgift ?cards?\b|\bprepaid (cards?|vouchers?)\b|\bredeem codes?\b/i },
  { id: 'crypto_payout', weight: 25, re: /\b(bitcoin|btc|ethereum|usdt|tether|crypto(currency)?|wallet address)\b/i },
  { id: 'wire_payout', weight: 20, re: /\b(wire transfer|western union|moneygram|zelle)\b/i },
  {
    id: 'urgency',
    weight: 10,
    re: /\b(urgent(ly)?|immediately|right now|act now|asap|within \d+ (minutes?|mins?)|before it'?s too late)\b/i,
  },
  {
    id: 'bulk_quantity',
    weight: 15,
    re: /\b(buy|purchase|order)\b.{0,15}\b([2-9]\d|\d{3,})\s*(x\s*)?(units?|items?|cards?|pieces?|of)\b/i,
  },
  { id: 'hidden_markup', weight: 30, re: /<!--|display\s*:\s*none|font-size\s*:\s*0|color\s*:\s*(white|#fff)/i },
];

// Zero-width and bidi control characters are a classic way to hide instructions.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/;

export function detectInjection(...texts: Array<string | null | undefined>): InjectionResult {
  const text = texts.filter(Boolean).join('\n');
  const signals: InjectionSignal[] = [];

  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (m) signals.push({ id: p.id, weight: p.weight, match: m[0].slice(0, 80) });
  }
  if (INVISIBLE.test(text)) {
    signals.push({ id: 'invisible_characters', weight: 30, match: 'zero-width or bidi control characters' });
  }
  const b64 = text.match(/[A-Za-z0-9+/]{60,}={0,2}/);
  if (b64) signals.push({ id: 'encoded_payload', weight: 15, match: `${b64[0].slice(0, 24)}…` });

  const score = Math.min(
    100,
    signals.reduce((s, x) => s + x.weight, 0),
  );
  return { score, signals, source: 'heuristic' };
}
