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
  for (const tag of extractNames(text, name ? [normalizeName(name)] : []))
    add(tag.kind, tag.normalized, tag.value);
  return [...tags.values()];
}

// Words that start with a capital for reasons other than being a name.
const NOT_NAMES = new Set(
  `a an the and or but if so to of in on at for from by with about as into per via
  is are was were be been it its this that these those there here
  i we you he she they me us them our your my his her their
  hi hello hey dear thanks thank regards cheers please re fw fwd ok yes no not
  new same any all some each every see now today tomorrow yesterday
  monday tuesday wednesday thursday friday saturday sunday
  january february march april may june july august september october november december
  invoice payment order purchase reminder credit note delivery export ticket
  receipt statement quote account accounts team meeting update urgent important
  action required request notice report weekly monthly daily digest details
  attached attachment reference ref total amount due project office site branch`
    .split(/\s+/)
    .filter(Boolean),
);
// Names often confused with places after "in".
const NOT_PLACES = new Set(
  'teams slack excel outlook gmail zoom word jira github english'.split(' '),
);
const CONNECTORS = new Set('van von de der den du da la le of &'.split(' '));
const WORD = String.raw`\p{Lu}[\p{L}'’]*(?:-\p{L}+)*`;
const PHRASE = String.raw`${WORD}(?:[ \t]+${WORD}){0,2}`;
const PLACE_NOUN = String.raw`(?:[Oo]ffice|[Ss]ite|[Bb]ranch|[Ww]arehouse|[Dd]epot|[Pp]lant|[Cc]ampus|[Ff]actory|[Ss]tore|[Hh]ub)`;
const CUES: { kind: 'project' | 'place'; pattern: RegExp }[] = [
  {
    kind: 'project',
    pattern: new RegExp(String.raw`\b[Pp]roject[ \t]+(${PHRASE})`, 'gu'),
  },
  {
    kind: 'project',
    pattern: new RegExp(String.raw`(${PHRASE})[ \t]+project\b`, 'gu'),
  },
  {
    kind: 'place',
    pattern: new RegExp(String.raw`(${PHRASE})[ \t]+${PLACE_NOUN}\b`, 'gu'),
  },
  {
    kind: 'place',
    pattern: new RegExp(String.raw`\bin[ \t]+(${PHRASE})`, 'gu'),
  },
];
// A run of capitalised words, allowing "van", "of" and "&" between them.
const RUN = new RegExp(
  String.raw`(?<![\p{L}\p{N}@.#/_'’-])${WORD}(?:[ \t]+(?:(?:${[...CONNECTORS].join('|')})[ \t]+)*${WORD})*`,
  'gu',
);
const HASHTAG = /(?<![\p{L}\p{N}&#])#(\p{L}[\p{L}\p{N}_-]{1,40})/gu;

const bare = (word: string) => word.replace(/['’]s$/, '');
const isName = (word: string) => {
  const plain = bare(word);
  return (
    plain.length >= 2 &&
    // All capitals is a code (OPS, EFT, USD), not a name.
    /\p{Ll}/u.test(plain) &&
    !NOT_NAMES.has(plain.toLowerCase())
  );
};
const normalizeName = (value: string) =>
  value
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/[\s_-]+/g, ' ')
    .trim();
/** Splits words into runs of names, dropping connectors at the edges. */
function segments(words: string[]) {
  const out: { start: number; words: string[] }[] = [];
  let current: { start: number; words: string[] } | undefined;
  words.forEach((word, index) => {
    if (CONNECTORS.has(word) || isName(word)) {
      current ??= { start: index, words: [] };
      current.words.push(bare(word));
    } else current = undefined;
    if (current && current.words.length === 1) out.push(current);
  });
  for (const segment of out)
    while (segment.words.length && CONNECTORS.has(segment.words[0])) {
      segment.words.shift();
      segment.start++;
    }
  for (const segment of out)
    while (segment.words.length && CONNECTORS.has(segment.words.at(-1)!))
      segment.words.pop();
  return out.filter((segment) => segment.words.length);
}

/**
 * Free-form names: a project or place when a cue word says so ("Project
 * Falcon", "the Cape Town office", "in Durban"), #hashtags, and any other
 * run of capitalised words as a plain name. A lone capitalised word that
 * starts a sentence is skipped, since that capital says nothing. Many of
 * these are noise on their own; the links view keeps only names that recur
 * in two or more items.
 */
export function extractNames(text: string, skip: string[] = []): Tag[] {
  const tags = new Map<string, Tag>(
    skip.map((normalized) => [normalized, undefined as unknown as Tag]),
  );
  const add = (kind: TagKind, words: string[]) => {
    const value = words.join(' ').slice(0, 200);
    const normalized = normalizeName(value);
    if (normalized.length >= 3 && !tags.has(normalized))
      tags.set(normalized, { kind, normalized, value });
  };
  for (const { kind, pattern } of CUES)
    for (const match of text.matchAll(pattern)) {
      const found = segments(match[1].split(/[ \t]+/));
      // "Project Falcon" names what follows; "the Falcon project" what precedes.
      const words = pattern.source.startsWith('(') ? found.at(-1) : found[0];
      if (
        words &&
        !(
          kind === 'place' &&
          NOT_PLACES.has(words.words.join(' ').toLowerCase())
        )
      )
        add(kind, words.words);
    }
  for (const match of text.matchAll(HASHTAG)) add('name', [match[1]]);
  for (const match of text.matchAll(RUN)) {
    const before = text.slice(0, match.index);
    const sentenceStart = /(?:^|[.!?:;]|\n)\s*$/.test(before);
    for (const segment of segments(match[0].split(/[ \t]+/)))
      if (!(sentenceStart && segment.start === 0 && segment.words.length === 1))
        add('name', segment.words);
  }
  return [...tags.values()].filter(Boolean);
}
