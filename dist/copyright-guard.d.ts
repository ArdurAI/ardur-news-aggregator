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
import type { ExtractedFact } from './contracts-v3.ts';
export declare const MAX_QUOTE_WORDS = 25;
/** Throws if the quote exceeds 25 words. */
export declare function assertQuoteLength(quote: string, context: string): void;
/** Truncate a quote to MAX_QUOTE_WORDS (for defensive trimming, not for bypassing the guard). */
export declare function trimQuoteToLimit(quote: string): string;
/**
 * Returns true if the statement shares ≥1 8-gram with the source body —
 * a signal that the statement may be lifting verbatim text rather than
 * re-expressing the fact in original language.
 */
export declare function hasForbiddenVerbatimOverlap(statement: string, sourceBody: string): boolean;
export interface FactWireValidationResult {
    facts: ExtractedFact[];
    violations: string[];
}
/**
 * Validates a batch of ExtractedFacts for wire serialization.
 * Strips or truncates non-compliant quotes. Logs violations but does not throw —
 * the caller decides whether violations block publication.
 */
export declare function validateFactsForWire(facts: ExtractedFact[]): FactWireValidationResult;
/**
 * Scrub a body string to ensure it is NOT embedded in any wire artifact.
 * Call this if you ever need to log a fact's context for debugging —
 * use this function to ensure you never accidentally embed body text.
 */
export declare function assertNotBodyText(_body: string, location: string): never;
