/**
 * Clustering — group items that cover the same story across sources.
 * Ported from clusterItems/similarity/tokens in build-news-digests.mjs.
 */

import type { AggregatedItem, Cluster, SourceTier } from '@ardurai/contracts';
import { stripMarkup } from './util.ts';

const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','shall','should','may','might','must','can',
  'could','to','of','in','for','on','with','at','by','from','as','into',
  'through','about','against','between','and','but','or','nor','not','so','yet',
  'both','either','neither','whether','each','every','all','any','few','more',
  'most','other','some','such','no','too','very','just','that','this','those','these','its',
]);

const BASE_IMPORTANT = new Set([
  'openai','anthropic','google','microsoft','amazon','nvidia','meta','apple',
  'kubernetes','k8s','docker','cncf','python','rust','llm','gpt','claude',
  'gemini','llama','mistral','react','aws','azure','gcp','linux','github',
  'security','vulnerability','cve','breach','exploit','ai','ml','devsecops',
  'terraform','helm','istio','prometheus','grafana','zero-day','ransomware',
  'supply-chain','openssl','oauth','iam','rbac','ebpf','wasm','webassembly',
]);

function tokens(text: string): string[] {
  return stripMarkup(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function similarity(a: string, b: string, importantSet: Set<string>): number {
  const aSet = new Set(tokens(a));
  const bSet = new Set(tokens(b));
  if (!aSet.size || !bSet.size) return 0;
  const overlap = [...aSet].filter((t) => bSet.has(t));
  const importantOverlap = overlap.filter((t) => importantSet.has(t)).length;
  return (overlap.length + importantOverlap * 1.5) / Math.min(aSet.size, bSet.size);
}

export interface ClusterOptions {
  threshold: number;
  importantTerms: string[];
}

export function clusterItems(
  items: Omit<AggregatedItem, 'clusterId'>[],
  options: ClusterOptions,
): { items: AggregatedItem[]; clusters: Cluster[] } {
  const importantSet = new Set([...BASE_IMPORTANT, ...options.importantTerms.map((t) => t.toLowerCase())]);
  const threshold = options.threshold;

  interface MutableCluster {
    clusterId: string;
    headline: string;
    topic: string;
    topicLabel: string;
    members: Omit<AggregatedItem, 'clusterId'>[];
  }

  const rawClusters: MutableCluster[] = [];

  // Sort by feedRank asc (lower = more prominent), then by publishedAt desc (newest first)
  const sorted = [...items].sort((a, b) => {
    const rankA = a.interaction.feedRank ?? 999;
    const rankB = b.interaction.feedRank ?? 999;
    if (rankA !== rankB) return rankA - rankB;
    return b.publishedAt.localeCompare(a.publishedAt);
  });

  for (const item of sorted) {
    const found = rawClusters.find(
      (c) => c.topic === item.topic && similarity(c.headline, item.title, importantSet) >= threshold,
    );
    if (found) {
      found.members.push(item);
    } else {
      rawClusters.push({
        clusterId: `cluster-${item.topic}-${rawClusters.length}`,
        headline: item.title,
        topic: item.topic,
        topicLabel: item.topicLabel,
        members: [item],
      });
    }
  }

  const resultItems: AggregatedItem[] = [];
  const resultClusters: Cluster[] = [];

  for (const raw of rawClusters) {
    const { clusterId } = raw;

    const tierHistogram: Partial<Record<SourceTier, number>> = {};
    const distinctDomains = new Set<string>();
    const distinctSources = new Set<string>();
    let earliest = raw.members[0]?.publishedAt ?? '';
    let latest = raw.members[0]?.publishedAt ?? '';

    for (const m of raw.members) {
      distinctDomains.add(m.sourceDomain);
      distinctSources.add(m.source);
      tierHistogram[m.tier] = (tierHistogram[m.tier] ?? 0) + 1;
      if (m.publishedAt < earliest) earliest = m.publishedAt;
      if (m.publishedAt > latest) latest = m.publishedAt;
    }

    for (const m of raw.members) {
      resultItems.push({ ...m, clusterId });
    }

    resultClusters.push({
      clusterId,
      topic: raw.topic,
      topicLabel: raw.topicLabel,
      headline: raw.headline,
      memberIds: raw.members.map((m) => m.id),
      sourceCount: distinctSources.size,
      distinctDomains: distinctDomains.size,
      tierHistogram,
      earliestPublishedAt: earliest,
      latestPublishedAt: latest,
    });
  }

  return { items: resultItems, clusters: resultClusters };
}
