/**
 * Intent drift: does this payment plausibly serve what the human actually asked for?
 * A deliberately simple lexical check. It only ever escalates to human review, never blocks,
 * because a lexical mismatch is a reason to ask, not proof of an attack.
 */

const STOPWORDS = new Set(
  `a an the and or for to of in on at by with from my me i we our you your it this that these those is are be
   please can could would should will want need get buy purchase order pay some any one two new best cheap good
   under over about around up down into out just also than then so as if not no yes do does make find book`
    .split(/\s+/)
    .filter(Boolean),
);

export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

function stem(w: string): string {
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('es') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('s') && w.length > 3) return w.slice(0, -1);
  return w;
}

export interface IntentCheck {
  overlap: string[];
  drift: boolean;
}

export function checkIntent(userIntent: string | undefined, ...purchaseTexts: string[]): IntentCheck | null {
  if (!userIntent) return null;
  const intent = tokens(userIntent);
  if (intent.size < 2) return null; // too little signal to judge
  const purchase = tokens(purchaseTexts.join(' '));
  const overlap = [...intent].filter((t) => purchase.has(t));
  return { overlap, drift: overlap.length === 0 };
}
