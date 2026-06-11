/**
 * Rev-3 contract bridge.
 *
 * @ardurai/contracts now ships rev 3 (CONTRACT_REVISION=3) — all core types
 * (SourceDocument, FactProvenance, ExtractedFact, ExtractionStatus, AccessPolicy,
 * AggregationData.documentsByTopic?, AggregationData.factsByCluster?) are
 * available from the package directly.
 *
 * This file re-exports them for backwards compatibility with local imports,
 * and defines the CONTRACT_REVISION_V3 constant for tooling that checks the
 * revision number.
 */
export { CONTRACT_REVISION as CONTRACT_REVISION_V3, } from '@ardurai/contracts';
