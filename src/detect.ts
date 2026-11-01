// In-process detection layers: name-based assignments, URL passwords, explicit formats,
// and entropy. Provider-pattern findings come from the external scanner (see scanner.ts).

export type Span = { start: number; end: number };

const ASSIGNMENT = /(["']?-*[A-Za-z_][\w.-]*["']?)[ \t]*[:=][ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`\r\n]*)`|([^\s"'`,;}\])]+))/dg;
// AUTH matches Authorization but not Author.
const NAME_KEYWORD = /KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH(?!OR(?!IZATION))|CREDENTIAL|DATABASE_URL/i;
const SCHEME_WORDS = /^(bearer|basic)$/i;
const URL_PASSWORD = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@/dg;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const TOKEN = /[A-Za-z0-9+/_-]{20,}={0,2}/g;
const PADDED_BASE64 = /^[A-Za-z0-9+/]{20,}={1,2}$/;
const ENTROPY_FLOOR = 3.3;
const SKIPPED_VALUES = /^(true|false|null|none|undefined)$/i;
// T3 Code identifiers (thread, run, message and scheduled-task IDs, thread links) are routing data the
// agent passes back to T3 tools. An identifier is one run of ID_CHAR; `?` ends it, so link query text
// stays scanned.
const ID_CHAR = /[A-Za-z0-9:%/._~-]/;
const T3_ID = /^(?:t3-(?:thread|citation):\/\/|mcp(?::|%3A)launch(?::|%3A)|scheduled-task:|run:thread:|message:(?:mcp|provider):|turn-item:|(?:thread:)?delegated-task:)/i;
const T3_ID_KEY = /"(?:[a-z]+(?:Thread|Run|Message|Item|Task|Project|Environment)|thread|project|run|message|item|task|environment)Id\\?"[ \t]*:[ \t]*\\?"$/;

export function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function groupSpan(match: RegExpExecArray, groups: number[]): Span | null {
  const indices = match.indices;
  if (!indices) return null;
  for (const index of groups) {
    const span = indices[index];
    if (span) return { start: span[0], end: span[1] };
  }
  return null;
}

// Name rule: a KEY, TOKEN, SECRET, PASSWORD, PASS, AUTH, CREDENTIAL or DATABASE_URL name assigned a value.
function assignmentSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(ASSIGNMENT)) {
    if (!NAME_KEYWORD.test(match[1])) continue;
    let span = groupSpan(match, [2, 3, 4, 5]);
    if (!span) continue;
    const value = text.slice(span.start, span.end);
    if (value === '' || value.startsWith('$') || SKIPPED_VALUES.test(value)) continue;
    if (SCHEME_WORDS.test(value)) {
      const following = /^[ \t]+([^\s"'`,;]+)/.exec(text.slice(span.end));
      if (!following) continue;
      const start = span.end + following[0].length - following[1].length;
      span = { start, end: start + following[1].length };
    }
    spans.push(span);
  }
  return spans;
}

// URL rule: the password part of scheme://user:password@host.
function urlPasswordSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(URL_PASSWORD)) {
    const span = groupSpan(match, [1]);
    if (span && !text.slice(span.start, span.end).startsWith('$')) spans.push(span);
  }
  return spans;
}

// Explicit format rule: UUIDs, JWTs and padded base64 stay masked, whatever their entropy.
function explicitSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const pattern of [UUID, JWT]) {
    for (const match of text.matchAll(pattern)) {
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return spans;
}

// Entropy rule: random-looking tokens of 20 or more characters.
function entropySpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const token = match[0];
    const randomLooking = /[A-Za-z]/.test(token) && /[0-9]/.test(token) && entropy(token) >= ENTROPY_FLOOR;
    if (randomLooking || PADDED_BASE64.test(token)) {
      spans.push({ start: match.index, end: match.index + token.length });
    }
  }
  return spans;
}

export function inProcessSpans(text: string): Span[] {
  return [...assignmentSpans(text), ...urlPasswordSpans(text), ...explicitSpans(text), ...entropySpans(text)];
}

function isT3Identifier(text: string, span: Span): boolean {
  let start = span.start;
  while (start > 0 && ID_CHAR.test(text[start - 1])) start--;
  let end = span.end;
  while (end < text.length && ID_CHAR.test(text[end])) end++;
  return T3_ID.test(text.slice(start, end)) || T3_ID_KEY.test(text.slice(Math.max(0, span.start - 64), span.start));
}

// Exemptions: a span is not a secret when it is a git SHA in git output, an
// integrity hash in a lockfile, a T3 Code identifier, or one of the gateway's own placeholders.
export function isExempt(text: string, span: Span, gitContext: boolean): boolean {
  const value = text.slice(span.start, span.end);
  if (value.includes('⟦SECRET_')) return true;
  if (isT3Identifier(text, span)) return true;
  const lineStart = text.lastIndexOf('\n', span.start - 1) + 1;
  const lineEnd = text.indexOf('\n', span.end);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  if (/^sha(1|256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(value) && /integrity|resolved|#sha/.test(line)) return true;
  if (gitContext && /^[0-9a-f]{40}$/.test(value) && /\b(commit|tree|parent|merge|blob|HEAD)\b/i.test(line)) return true;
  return false;
}

// Canonical secret value: what a span's identity is computed from.
export function canonicalOf(value: string): string {
  let secret = value.trim();
  if (secret.length >= 2 && /^(["'`])[\s\S]*\1$/.test(secret)) secret = secret.slice(1, -1).trim();
  return secret;
}
