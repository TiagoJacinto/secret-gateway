// Finds secret hits across a set of text segments. One scanner call covers every
// segment and every decoded variant, so the external process starts once per request.
import { canonicalOf, inProcessSpans, isExempt, type Span } from './detect.ts';
import type { Exemptions } from './exemptions.ts';

export type ScanFinding = { secret: string; line: number };
export interface Scanner {
  scan(text: string): Promise<ScanFinding[]>;
}
export type Hit = Span & { secret: string };
export type Segment = { text: string; gitContext: boolean };

// Candidate encoded forms: base64 or percent-encoded runs. Underscore and '=' are excluded so that a name
// such as GH_TOKEN_B64= does not join the run that follows it.
const CANDIDATE = /[A-Za-z0-9+/%-]{16,}={0,2}/g;
const BASE64_STRICT = /^[A-Za-z0-9+/]+={0,2}$/;
const PLACEHOLDER = /⟦SECRET_[0-9a-f]{6,64}⟧/g;

// URL-encoded and base64-wrapped forms of a token. Each decoded form is scanned as its own line.
export function decodedVariants(token: string): string[] {
  const variants: string[] = [];
  if (/%[0-9A-Fa-f]{2}/.test(token)) {
    try {
      const decoded = decodeURIComponent(token);
      if (decoded !== token) variants.push(decoded);
    } catch {
      // Not valid percent-encoding; there is no decoded form.
    }
  }
  if (token.length >= 16 && token.length % 4 === 0 && BASE64_STRICT.test(token)) {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const printable = /^[\x20-\x7e]+$/.test(decoded);
    if (printable && decoded.length >= 8 && Buffer.from(decoded, 'utf8').toString('base64') === token) {
      variants.push(decoded);
    }
  }
  return variants;
}

type Owner = {
  segment: number;
  text: string;
  offset: number;
  token?: Span;
};

export async function findHits(segments: Segment[], scanner: Scanner, exemptions: Exemptions): Promise<Hit[][]> {
  const owners: Owner[] = [];
  let offset = 0;
  segments.forEach((segment, index) => {
    owners.push({ segment: index, text: segment.text, offset });
    offset += segment.text.length + 1;
    for (const token of segment.text.matchAll(CANDIDATE)) {
      for (const variant of decodedVariants(token[0])) {
        const start = token.index;
        owners.push({ segment: index, text: variant, offset, token: { start, end: start + token[0].length } });
        offset += variant.length + 1;
      }
    }
  });

  const probe = owners.map((owner) => owner.text).join('\n');
  const lineStarts = [0];
  for (let index = 0; index < probe.length; index++) if (probe[index] === '\n') lineStarts.push(index + 1);
  const ownerAt = (position: number): Owner | undefined =>
    owners.findLast((owner) => owner.offset <= position);

  const found: { owner: Owner; span: Span }[] = [];
  for (const finding of await scanner.scan(probe)) {
    if (!finding.secret) continue;
    const from = lineStarts[finding.line - 1] ?? 0;
    let position = probe.indexOf(finding.secret, from);
    if (position === -1) position = probe.indexOf(finding.secret);
    if (position === -1) continue;
    const owner = ownerAt(position);
    if (!owner) continue;
    const start = position - owner.offset;
    found.push({ owner, span: { start, end: start + finding.secret.length } });
  }
  for (const owner of owners) {
    for (const span of inProcessSpans(owner.text)) found.push({ owner, span });
  }

  // A decoded variant maps back to the encoded token that produced it, so the token is what gets masked.
  // Variant hits win over plain hits on the same token, keeping one canonical identity per secret.
  const variantHits: Hit[][] = segments.map(() => []);
  const plainHits: Hit[][] = segments.map(() => []);
  for (const { owner, span } of found) {
    const segment = segments[owner.segment];
    const secret = canonicalOf(owner.text.slice(span.start, span.end));
    if (secret === '') continue;
    const segmentSpan = owner.token ?? span;
    if (isExempt(segment.text, segmentSpan, segment.gitContext, exemptions)) continue;
    const bucket = owner.token ? variantHits : plainHits;
    bucket[owner.segment].push({ start: segmentSpan.start, end: segmentSpan.end, secret });
  }

  return segments.map((segment, index) => {
    const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;
    const placeholders = [...segment.text.matchAll(PLACEHOLDER)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
    }));
    const candidates = [
      ...variantHits[index],
      ...plainHits[index].filter((hit) => !variantHits[index].some((variant) => overlaps(variant, hit))),
    ].filter((hit) => !placeholders.some((p) => overlaps(p, hit)));
    const sorted = candidates.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged: Hit[] = [];
    for (const hit of sorted) {
      const last = merged.at(-1);
      if (last && hit.start < last.end) continue;
      merged.push(hit);
    }
    return merged;
  });
}
