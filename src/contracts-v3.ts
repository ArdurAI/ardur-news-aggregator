/**
 * Rev-3 contract additions — local definitions until @ardurai/contracts publishes rev 3.
 * When contracts rev 3 ships, delete this file and import from '@ardurai/contracts' directly.
 *
 * Design doc §6.1: ardur-pipeline/docs/redesign-content-flow-2026-06.md
 */

import type { SourceTier, Confidence, ProviderMeta } from '@ardurai/contracts';

export const CONTRACT_REVISION_V3 = 3 as const;

// ── Read / extract layer ─────────────────────────────────────────────────────

export type ExtractionStatus = 'full' | 'snippet' | 'failed';
export type AccessPolicy = 'allowed' | 'paywalled' | 'robots-disallowed' | 'tos-restricted';

/**
 * Metadata for a fetched source article. The body is NEVER serialized here —
 * it lives only in the private ETL store (data/etl-store/) for extraction + audit.
 */
export interface SourceDocument {
  /** Stable id: hex-encoded SHA-256 of the canonical URL. */
  id: string;
  /** Canonical URL — no PII, no fragment, no credentials. */
  url: string;
  source: string;
  sourceDomain: string;
  tier: SourceTier;
  title: string;
  publishedAt: string;
  /** ISO-8601 UTC timestamp of the fetch. */
  fetchedAt: string;
  extraction: ExtractionStatus;
  accessPolicy: AccessPolicy;
  wordCount: number | null;
  lang: string | null;
  /** SHA-256 of the extracted body text — used for dedup and change-detection. */
  contentHash: string;
  /** HTTP ETag from the server, if provided — used for conditional re-fetches. */
  etag?: string;
  /** HTTP Last-Modified from the server, if provided. */
  lastModified?: string;
}

export interface FactProvenance {
  /** → SourceDocument.id */
  sourceDocId: string;
  sourceDomain: string;
  /** Canonical link for attribution — always present. */
  url: string;
  /**
   * Optional verbatim support — MUST be < 25 words.
   * Copyright guard validates this before serialization.
   */
  quote?: string;
}

/**
 * An atomic, original-expression fact extracted from one or more article bodies.
 * Hard invariant: provenance.length >= 1. Any code path that would emit an
 * ExtractedFact without provenance MUST throw instead.
 */
export interface ExtractedFact {
  id: string;
  topic: string;
  clusterId: string;
  /** Original-expression statement — not a copied sentence from any source. */
  statement: string;
  /** Present when the fact is quantitative — enables chart blocks in the synthesizer. */
  quantity?: {
    metric: string;
    value: number;
    unit?: string;
    /** ISO date the figure refers to (e.g. a fiscal quarter end). */
    asOf?: string;
  };
  entities: string[];
  /** Non-empty array — at least one source must ground every fact. */
  provenance: FactProvenance[];
  /** Distinct source domains asserting this fact (fuzzy-matched). Minimum 1. */
  corroboration: number;
  confidence: Confidence;
  extractedBy: ProviderMeta;
}

// ── Aggregation data extension (additive) ────────────────────────────────────

/** Rev-3 extension to AggregationData — additive, absent == rev-2 producer. */
export interface AggregationDataV3Extension {
  /**
   * Source documents fetched and stored by the ETL — metadata only (no body).
   * Keyed by topicId.
   */
  documentsByTopic?: Record<string, SourceDocument[]>;
  /**
   * Extracted facts per cluster — the primary synthesizer input.
   * Keyed by clusterId.
   */
  factsByCluster?: Record<string, ExtractedFact[]>;
}
