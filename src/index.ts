/**
 * ardur-news-aggregator — public entrypoint.
 * Stage 1 of the Ardur content pipeline: ingest >=20-30 sources/topic, dedup,
 * cluster, capture aggregate interaction metrics, emit AggregationArtifact.
 */

import { randomUUID } from 'node:crypto';
import type { AggregationArtifact, AggregatedItem, CycleMeta, SourceCoverage } from './contracts.ts';
import { SCHEMA_VERSION, CYCLE_INTERVAL_MS } from './contracts.ts';
import { loadTopics, sourcesForTopic } from './sources.ts';
import { ingestTopic } from './ingest.ts';
import { dedupe } from './dedup.ts';
import { clusterItems } from './cluster.ts';
import { captureInteractionMetrics } from './interaction.ts';
import type { RawItem } from './ingest.ts';

export * from './contracts.ts';
export type { SourceDefinition, TopicDefinition, FetchStrategy } from './sources.ts';
export type { RawItem, IngestResult } from './ingest.ts';

export interface AggregationOptions {
  cycle?: CycleMeta;
  maxAgeMs?: number;
  perSourceTimeoutMs?: number;
  concurrency?: number;
  now?: Date;
}

// ---------------------------------------------------------------------------
// Cycle helpers
// ---------------------------------------------------------------------------

function floorToCycle(d: Date): Date {
  const ms = d.valueOf();
  return new Date(ms - (ms % CYCLE_INTERVAL_MS));
}

function buildCycle(now: Date, override?: CycleMeta): CycleMeta {
  if (override) return override;
  const windowStart = floorToCycle(now);
  const windowEnd = new Date(windowStart.valueOf() + CYCLE_INTERVAL_MS);
  return {
    id: windowStart.toISOString(),
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Claims extraction — deterministic NLP over title + summaryHint
// ---------------------------------------------------------------------------

const IMPORTANT_ENTITIES = new Set([
  'openai','anthropic','google','microsoft','amazon','nvidia','meta','apple',
  'kubernetes','k8s','docker','cncf','llm','gpt','claude','gemini','llama',
  'mistral','aws','azure','gcp','linux','github','cve','ebpf','wasm','oauth',
  'terraform','helm','istio','prometheus','grafana','supply-chain','zero-day',
]);

function extractClaims(title: string, summaryHint: string, topicTerms: string[]): string[] {
  const text = `${title} ${summaryHint}`.toLowerCase();
  const important = new Set([...IMPORTANT_ENTITIES, ...topicTerms.map((t) => t.toLowerCase())]);
  const found = new Set<string>();
  for (const term of important) {
    if (text.includes(term)) found.add(term);
  }
  return [...found].slice(0, 5);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runAggregation(options: AggregationOptions = {}): Promise<AggregationArtifact> {
  const now = options.now ?? new Date();
  const maxAgeMs = options.maxAgeMs ?? 36 * 60 * 60 * 1000;
  const perSourceTimeoutMs = options.perSourceTimeoutMs ?? 30_000;
  const concurrency = options.concurrency ?? 10;
  const cycle = buildCycle(now, options.cycle);
  const runId = randomUUID();
  const warnings: string[] = [];

  const allTopics = loadTopics();
  const activeTopics = allTopics.filter((t) => t.id !== 'all');

  const itemsByTopic: Record<string, AggregatedItem[]> = {};
  const clustersByTopic: Record<string, ReturnType<typeof clusterItems>['clusters']> = {};
  const coverageByTopic: Record<string, SourceCoverage> = {};

  // --------------------------------------------------------------------------
  // Per-topic ingestion + dedup + cluster
  // --------------------------------------------------------------------------
  for (const topic of activeTopics) {
    const sources = sourcesForTopic(topic.id);
    const ingestResults = await ingestTopic(topic, sources, {
      now, maxAgeMs, concurrency, perSourceTimeoutMs,
    });

    // Coverage stats
    const sourcesResponded = ingestResults.filter((r) => r.ok).length;
    const allItems: RawItem[] = ingestResults.flatMap((r) => r.items);

    // Surface per-source errors as warnings
    for (const r of ingestResults) {
      if (!r.ok && r.error) {
        warnings.push(`[${topic.id}] source ${r.source.domain}: ${r.error}`);
      }
    }

    // Dedup
    const { items: dedupedItems } = dedupe(allItems);

    // Build pre-cluster AggregatedItems
    const preCluster = dedupedItems.map((item): Omit<AggregatedItem, 'clusterId'> => {
      const id = `${item.topic}-${item.fingerprint.slice(0, 24).replace(/[^a-z0-9]/g, '')}`;
      const interaction = captureInteractionMetrics(
        { feedRank: item.feedRank },
        { capturedAt: now, provenance: 'rss-feed-position' },
      );
      return {
        id,
        topic: item.topic,
        topicLabel: item.topicLabel,
        title: item.title,
        source: item.source,
        sourceDomain: item.sourceDomain,
        sourceUrl: item.sourceUrl,
        url: item.url,
        tier: item.tier,
        publishedAt: item.publishedAt,
        summaryHint: item.summaryHint,
        interaction,
        fingerprint: item.fingerprint,
        claims: extractClaims(item.title, item.summaryHint, topic.terms),
      };
    });

    // Cluster
    const { items: clusteredItems, clusters } = clusterItems(preCluster, {
      threshold: 0.82,
      importantTerms: topic.terms,
    });

    // Project cluster-level signals back onto member items
    const clusterMap = new Map(clusters.map((c) => [c.clusterId, c]));
    const finalItems: AggregatedItem[] = clusteredItems.map((item) => {
      const cluster = clusterMap.get(item.clusterId);
      if (!cluster) return item;
      const velocity = cluster.memberIds.length / 6; // rough: items per hour in 6h window
      return {
        ...item,
        interaction: {
          ...item.interaction,
          crossSourceMentions: cluster.distinctDomains,
          velocity,
        },
      };
    });

    // Coverage
    const distinctDomains = new Set(finalItems.map((i) => i.sourceDomain)).size;
    const degraded = distinctDomains < topic.diversityFloor;
    if (degraded) {
      warnings.push(
        `[${topic.id}] degraded: ${distinctDomains} distinct domains < floor ${topic.diversityFloor}`,
      );
    }

    itemsByTopic[topic.id] = finalItems;
    clustersByTopic[topic.id] = clusters;
    coverageByTopic[topic.id] = {
      sourcesConfigured: sources.length,
      sourcesQueried: ingestResults.length,
      sourcesResponded,
      distinctDomains,
      degraded,
    };
  }

  // --------------------------------------------------------------------------
  // 'all' topic — merge + re-sort by crossSourceMentions
  // --------------------------------------------------------------------------
  const allItemsFlat = Object.values(itemsByTopic).flat();
  const seenIds = new Set<string>();
  const globalItems: AggregatedItem[] = [];
  for (const item of allItemsFlat.sort(
    (a, b) => b.interaction.crossSourceMentions - a.interaction.crossSourceMentions,
  )) {
    if (!seenIds.has(item.id)) {
      seenIds.add(item.id);
      globalItems.push(item);
    }
  }
  itemsByTopic['all'] = globalItems;
  // No independent clustering for 'all' — use per-topic clusters
  clustersByTopic['all'] = Object.values(clustersByTopic).flat();
  coverageByTopic['all'] = {
    sourcesConfigured: Object.values(coverageByTopic).reduce((s, c) => s + c.sourcesConfigured, 0),
    sourcesQueried: Object.values(coverageByTopic).reduce((s, c) => s + c.sourcesQueried, 0),
    sourcesResponded: Object.values(coverageByTopic).reduce((s, c) => s + c.sourcesResponded, 0),
    distinctDomains: new Set(globalItems.map((i) => i.sourceDomain)).size,
    degraded: false,
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    artifact: 'aggregation',
    runId,
    upstreamRunId: null,
    generatedAt: now.toISOString(),
    cycle,
    topics: allTopics.map(({ id, label, description }) => ({ id, label, description })),
    warnings,
    data: { itemsByTopic, clustersByTopic, coverageByTopic },
  };
}
