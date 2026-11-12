import type { TagKind } from '../../shared/inbox-types.js';

/** One identifier, person or company found in an item. */
export interface Tag {
  kind: TagKind;
  /** The lookup key: `INV-2041`, `inv 2041` and `Invoice #2041` share one. */
  normalized: string;
  /** As written, for display. */
  value: string;
}

// Mailbox providers say nothing about who sent something.
const SHARED_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
]);
const CURRENCY: Record<string, string> = {
  r: 'ZAR',
  zar: 'ZAR',
  $: 'USD',
  usd: 'USD',
  '€': 'EUR',
  eur: 'EUR',
  '£': 'GBP',
  gbp: 'GBP',
};
const PATTERNS: {
  kind: TagKind;
  pattern: RegExp;
  normalize: (match: RegExpMatchArray) => string | undefined;
}[] = [
  {
    kind: 'invoice',
    pattern:
      /\b(?:inv(?:oice)?)\.?\s*(?:no\.?|number|#)?\s*[#:-]?\s*([a-z]{0,3}-?\d{3,10})\b/gi,
    normalize: (m) => `INV-${m[1].replace(/\D/g, '')}`,
  },
  {
    kind: 'order',
    pattern:
      /\b(?:po|purchase\s+order)\s*(?:no\.?|number|#)?\s*[#:-]?\s*(\d{3,10})\b/gi,
    normalize: (m) => `PO-${m[1]}`,
  },
  {
    // Issue keys such as OPS-311; INV and PO are handled above.
    kind: 'ticket',
    pattern: /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g,
    normalize: (m) =>
      ['INV', 'PO'].includes(m[1]) ? undefined : `${m[1]}-${m[2]}`,
  },
  {
    kind: 'email',
    pattern: /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi,
    normalize: (m) => m[0].toLowerCase(),
  },
  {
    kind: 'amount',
    pattern:
      /(?:\b(ZAR|USD|EUR|GBP)|(?<![A-Za-z0-9])(R|\$|€|£))\s?(\d{1,3}(?:[ ,]\d{3})+|\d+)(?:\.(\d{2}))?\b/gi,
    normalize: (m) => {
      const currency = CURRENCY[(m[1] ?? m[2]).toLowerCase()];
      const whole = Number(m[3].replace(/[ ,]/g, ''));
      return currency && whole
        ? `${currency} ${whole}.${m[4] ?? '00'}`
        : undefined;
    },
  },
];

/**
 * Finds identifiers in an item's text with regular expressions tuned to
 * catch too much rather than too little; judging which ones matter is left
 * to later steps. Code only: free, and the same text always gives the same
 * tags.
 */
export function extractTags(item: {
  title: string;
  summary?: string;
  from?: string | null;
}): Tag[] {
  const text = `${item.title}\n${item.summary ?? ''}`;
  const tags = new Map<string, Tag>();
  const add = (kind: TagKind, normalized: string, value: string) => {
    const key = `${kind}:${normalized}`;
    if (!tags.has(key))
      tags.set(key, { kind, normalized, value: value.trim().slice(0, 200) });
  };
  for (const { kind, pattern, normalize } of PATTERNS)
    for (const match of `${text}\n${item.from ?? ''}`.matchAll(pattern)) {
      const normalized = normalize(match);
      if (normalized) add(kind, normalized, match[0]);
    }
  for (const tag of [...tags.values()])
    if (tag.kind === 'email') {
      const domain = tag.normalized.split('@')[1];
      if (domain && !SHARED_DOMAINS.has(domain)) add('domain', domain, domain);
    }
  for (const match of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    const domain = match[1].toLowerCase().replace(/^www\./, '');
    if (!SHARED_DOMAINS.has(domain)) add('domain', domain, domain);
  }
  // "Thandi Nkosi <thandi@acme.co.za>": the display name is the person.
  const name = item.from?.match(/^\s*"?([^"<@]{2,80}?)"?\s*</)?.[1];
  if (name) add('person', name.toLowerCase().replace(/\s+/g, ' '), name);
  return [...tags.values()];
}
