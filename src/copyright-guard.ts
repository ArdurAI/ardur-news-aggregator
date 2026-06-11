/**
 * Copyright guard — A5.
 *
 * Enforces the Ardur copyright posture:
 *   - Bodies are fetched and stored PRIVATELY; never emitted on the wire.
 *   - Wire carries original-expression facts + short quotes (< 25 words) + canonical links.
 *   - 8-gram verbatim screen flags near-verbatim body reproduction in statements.
 *
 * All serialization of ExtractedFact[] MUST pass through validateFactsForWire()
 * before inclusion in any AggregationArtifact.
 */

import type { ExtractedFact, FactProvenance } from './contracts-v3.ts';

export const MAX_QUOTE_WORDS = 25;

// ── Word tokeniser (CJK-aware) ───────────────────────────────────────────────
//
// CJK / whitespace-free scripts have no inter-word spaces, so splitting on \s+
// yields a single "word" regardless of character count, bypassing the 25-word cap.
// Fix: each Han / Hiragana / Katakana / Hangul character counts as one word;
// Latin-script word characters are counted as whitespace-delimited tokens.
//
// Regex: match either one CJK code-point OR one run of non-CJK, non-whitespace chars.
const WORD_TOKEN_RE =
  /[一-鿿぀-ゟ゠-ヿ가-힣㐀-䶿豈-﫿]|[^\s一-鿿぀-ゟ゠-ヿ가-힣㐀-䶿豈-﫿]+/gu;

export function wordCount(text: string): number {
  return (text.trim().match(WORD_TOKEN_RE) ?? []).length;
}

/** Throws if the quote exceeds 25 words. */
export function assertQuoteLength(quote: string, context: string): void {
  const wc = wordCount(quote);
  if (wc > MAX_QUOTE_WORDS) {
    throw new Error(
      `Copyright violation: quote in ${context} is ${wc} words (max ${MAX_QUOTE_WORDS}): ` +
        `"${quote.slice(0, 80)}…"`,
    );
  }
}

/** Truncate a quote to MAX_QUOTE_WORDS (for defensive trimming, not for bypassing the guard). */
export function trimQuoteToLimit(quote: string): string {
  const tokens = quote.trim().match(WORD_TOKEN_RE) ?? [];
  if (tokens.length <= MAX_QUOTE_WORDS) return quote;
  return tokens.slice(0, MAX_QUOTE_WORDS).join(' ') + '…';
}

// ── 8-gram verbatim screen ───────────────────────────────────────────────────

function ngrams(text: string, n: number): Set<string> {
  // Tokenise the same way wordCount does so CJK text produces grams.
  const words = (text.toLowerCase().replace(/[^\w\s一-鿿぀-ゟ゠-ヿ가-힣]/g, '')
    .match(WORD_TOKEN_RE) ?? []).filter(Boolean);
  const grams = new Set<string>();
  for (let i = 0; i <= words.length - n; i++) {
    grams.add(words.slice(i, i + n).join(' '));
  }
  return grams;
}

/**
 * Returns true if the statement shares ≥1 8-gram with the source body —
 * a signal that the statement may be lifting verbatim text rather than
 * re-expressing the fact in original language.
 */
export function hasForbiddenVerbatimOverlap(statement: string, sourceBody: string): boolean {
  if (!sourceBody) return false;
  const statementGrams = ngrams(statement, 8);
  if (statementGrams.size === 0) return false;
  const bodyGrams = ngrams(sourceBody, 8);
  for (const gram of statementGrams) {
    if (bodyGrams.has(gram)) return true;
  }
  return false;
}

// ── Wire serialization guard ─────────────────────────────────────────────────

export interface FactWireValidationResult {
  facts: ExtractedFact[];
  violations: string[];
}

/**
 * Validates a batch of ExtractedFacts for wire serialization.
 *
 * Fail-CLOSED policy — any violation DROPS the fact, never silently patches it:
 *   - Empty provenance → dropped.
 *   - Provenance missing URL → dropped.
 *   - Quote exceeds MAX_QUOTE_WORDS → dropped (not truncated).
 *   - Statement verbatim-overlaps a source body (when bodyMap supplied) → dropped.
 *
 * @param facts    Facts to validate.
 * @param bodyMap  Optional map from sourceDocId → private body text.
 *                 When provided, fact.statement is re-screened for verbatim overlap.
 */
export function validateFactsForWire(
  facts: ExtractedFact[],
  bodyMap?: Map<string, string>,
): FactWireValidationResult {
  const violations: string[] = [];
  const clean: ExtractedFact[] = [];

  for (const fact of facts) {
    if (fact.provenance.length === 0) {
      violations.push(`fact ${fact.id}: no provenance — dropped`);
      continue;
    }

    // Re-screen statement for verbatim overlap (A5 fail-CLOSED gate)
    if (bodyMap) {
      let verbatim = false;
      for (const prov of fact.provenance) {
        const body = bodyMap.get(prov.sourceDocId);
        if (body && hasForbiddenVerbatimOverlap(fact.statement, body)) {
          violations.push(
            `fact ${fact.id}: statement has verbatim overlap with ${prov.sourceDomain} — dropped`,
          );
          verbatim = true;
          break;
        }
      }
      if (verbatim) continue;
    }

    const cleanProvenance: FactProvenance[] = [];
    let provenanceViolation = false;

    for (const prov of fact.provenance) {
      if (!prov.url) {
        violations.push(`fact ${fact.id}: provenance missing url — dropped`);
        provenanceViolation = true;
        break;
      }

      if (prov.quote !== undefined) {
        const wc = wordCount(prov.quote);
        if (wc > MAX_QUOTE_WORDS) {
          // Fail CLOSED: drop the entire fact rather than silently truncating the quote.
          violations.push(
            `fact ${fact.id}: quote is ${wc} words in provenance from ${prov.sourceDomain} — dropped (fail-closed)`,
          );
          provenanceViolation = true;
          break;
        }
      }

      cleanProvenance.push(prov);
    }

    if (provenanceViolation) continue;

    clean.push({ ...fact, provenance: cleanProvenance });
  }

  return { facts: clean, violations };
}

/**
 * Scrub a body string to ensure it is NOT embedded in any wire artifact.
 * Call this if you ever need to log a fact's context for debugging —
 * use this function to ensure you never accidentally embed body text.
 */
export function assertNotBodyText(_body: string, location: string): never {
  throw new Error(
    `Copyright guard: attempted to serialize article body at ${location}. ` +
      `Bodies must remain in the private ETL store only.`,
  );
}
