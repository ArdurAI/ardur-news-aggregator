/**
 * ardur-news-aggregator — public entrypoint.
 *
 * Stage 1 of the Ardur content pipeline: ingest >= 20-30 sources/topic, dedup,
 * cluster, capture aggregate interaction metrics, and emit an
 * `AggregationArtifact` for `ardur-ranking-engine`.
 *
 * SCAFFOLD ONLY — wiring/signatures are final; module bodies are stubs.
 */

import type { AggregationArtifact, CycleMeta } from './contracts.ts';

export * from './contracts.ts';
export type { SourceDefinition, TopicDefinition, FetchStrategy } from './sources.ts';
export type { RawItem, IngestResult } from './ingest.ts';

export interface AggregationOptions {
  /** 6-hour cycle this run belongs to. Defaults to floor(now, 6h) UTC. */
  cycle?: CycleMeta;
  /** Max item age to admit. Defaults to 36h (matches existing maxAgeMs). */
  maxAgeMs?: number;
  /** Per-source fetch timeout. */
  perSourceTimeoutMs?: number;
  /** Concurrent source fetches. */
  concurrency?: number;
  /** Override the wall clock (testing/replay). */
  now?: Date;
}

/**
 * Run a full aggregation cycle and return the artifact. Failures of individual
 * sources are recorded as `warnings` and reflected in per-topic coverage
 * (degraded), never aborting the run.
 */
export function runAggregation(_options: AggregationOptions = {}): Promise<AggregationArtifact> {
  throw new Error('not implemented: wire sources -> ingest -> dedup -> cluster -> interaction');
}
