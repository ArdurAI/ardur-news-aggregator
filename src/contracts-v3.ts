/**
 * Rev-3 contract bridge.
 *
 * @ardurai/contracts ships the current shared contract revision (rev 5 as of
 * the Hermes provider metadata rollout). Rev 3 ETL types (SourceDocument,
 * FactProvenance, ExtractedFact, ExtractionStatus, AccessPolicy,
 * AggregationData.documentsByTopic?, AggregationData.factsByCluster?) remain
 * available from the package directly.
 *
 * This file re-exports them for backwards compatibility with local imports,
 * and defines the CONTRACT_REVISION_V3 constant for tooling that checks the
 * revision number.
 */

export {
  CONTRACT_REVISION as CONTRACT_REVISION_V3,
  type ExtractionStatus,
  type AccessPolicy,
  type SourceDocument,
  type FactProvenance,
  type ExtractedFact,
} from '@ardurai/contracts';

/**
 * Rev-3 additive extension fields on AggregationData.
 * Kept as a convenience interface — AggregationData already carries these
 * as optional fields in @ardurai/contracts rev 3.
 */
export interface AggregationDataV3Extension {
  documentsByTopic?: Record<string, import('@ardurai/contracts').SourceDocument[]>;
  factsByCluster?: Record<string, import('@ardurai/contracts').ExtractedFact[]>;
}
