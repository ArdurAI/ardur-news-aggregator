/**
 * Fact extractor — A4.
 *
 * AI-primary (Ollama) → ExtractedFact[] with per-source provenance.
 * Deterministic floor: regex-based entity/number/date extraction for when
 * the LLM is unavailable — but synthesis treats a fact-poor cluster as HOLD,
 * not as license to invent.
 *
 * Hard rules:
 *   - Every ExtractedFact has provenance.length >= 1.
 *   - No fact is emitted that is not grounded in a real source body.
 *   - The statement is original expression — not a copied sentence.
 *   - Quotes in provenance are validated to < 25 words by the copyright guard.
 */
import type { SourceDocument, ExtractedFact } from './contracts-v3.ts';
import type { ProviderMeta } from '@ardurai/contracts';
export interface SourceBodyPair {
    doc: SourceDocument;
    body: string;
}
export interface FactExtractionResult {
    facts: ExtractedFact[];
    provider: ProviderMeta;
    warnings: string[];
}
/**
 * Extract facts from a cluster's source bodies.
 * Tries Ollama first; falls back to deterministic extraction.
 * All returned facts have provenance.length >= 1.
 * Wire safety is validated by copyright-guard before returning.
 */
export declare function extractFacts(pairs: SourceBodyPair[], topic: string, clusterId: string): Promise<FactExtractionResult>;
