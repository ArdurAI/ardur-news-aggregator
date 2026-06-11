/**
 * ardur-news-aggregator — public entrypoint.
 *
 * Stage 1 of the Ardur content pipeline: ingest ALL clustered coverage (no
 * source ceiling — A1), widen via per-topic search discovery (A2), run the
 * ETL (full-text fetch + extraction + persistent store — A3), extract
 * ExtractedFact[] with per-source provenance (A4), and enforce the copyright
 * guard (A5).  Emits AggregationArtifact with rev-3 extensions when the ETL
 * is enabled.
 *
 * Practical limits (no silent caps):
 *   - Per-source fetch budget (perSourceTimeoutMs).
 *   - Dedup (title+url fingerprint + contentHash).
 *   - robots.txt / ToS restrictions — flagged as warnings, never silently dropped.
 *
 * ETL is opt-in via ARDUR_ETL_ENABLED=true (or options.etlEnabled).
 * When disabled the pipeline behaves exactly as before (CI-friendly).
 */
import { randomUUID } from 'node:crypto';
import { SCHEMA_VERSION, CYCLE_INTERVAL_MS, CONTRACT_REVISION, assertCompatibleArtifact, } from '@ardurai/contracts';
import { CONTRACT_REVISION_V3 } from "./contracts-v3.js";
import { loadTopics, sourcesForTopic, loadSources } from "./sources.js";
import { ingestTopic } from "./ingest.js";
import { dedupe } from "./dedup.js";
import { clusterItems } from "./cluster.js";
import { captureInteractionMetrics } from "./interaction.js";
import { defaultSearchProviders, searchAllProviders } from "./search-provider.js";
import { fileEtlStore, docIdFromUrl } from "./etl-store.js";
import { fetchArticle } from "./content-extract.js";
import { extractFacts } from "./fact-extractor.js";
import { validateFactsForWire } from "./copyright-guard.js";
export * from '@ardurai/contracts';
export * from "./contracts-v3.js";
// ---------------------------------------------------------------------------
// Cycle helpers
// ---------------------------------------------------------------------------
function floorToCycle(d) {
    const ms = d.valueOf();
    return new Date(ms - (ms % CYCLE_INTERVAL_MS));
}
function buildCycle(now, override) {
    if (override)
        return override;
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
    'openai', 'anthropic', 'google', 'microsoft', 'amazon', 'nvidia', 'meta', 'apple',
    'kubernetes', 'k8s', 'docker', 'cncf', 'llm', 'gpt', 'claude', 'gemini', 'llama',
    'mistral', 'aws', 'azure', 'gcp', 'linux', 'github', 'cve', 'ebpf', 'wasm', 'oauth',
    'terraform', 'helm', 'istio', 'prometheus', 'grafana', 'supply-chain', 'zero-day',
]);
function extractClaims(title, summaryHint, topicTerms) {
    const text = `${title} ${summaryHint}`.toLowerCase();
    const important = new Set([...IMPORTANT_ENTITIES, ...topicTerms.map((t) => t.toLowerCase())]);
    const found = new Set();
    for (const term of important) {
        if (text.includes(term))
            found.add(term);
    }
    return [...found].slice(0, 5);
}
// ---------------------------------------------------------------------------
// ETL phase (A3 + A4 + A5)
// ---------------------------------------------------------------------------
async function runEtlForTopic(topicId, clusteredItems, clusters, opts) {
    const warnings = [];
    const documents = [];
    const factsByCluster = {};
    // Build URL → item lookup (deduped by URL, keeping first occurrence)
    const urlToItem = new Map();
    for (const item of clusteredItems) {
        if (!urlToItem.has(item.url))
            urlToItem.set(item.url, item);
    }
    // Budget: limit total article fetches per topic
    let fetchCount = 0;
    for (const cluster of clusters) {
        const clusterItems = cluster.memberIds.map((id) => {
            for (const item of clusteredItems) {
                if (item.id === id)
                    return item;
            }
            return null;
        }).filter((item) => item !== null);
        // Deduplicate URLs within the cluster (cross-source corroboration is fine, fetching the
        // same URL twice is not). Log any item dropped due to budget — A1 hard rule: no silent caps.
        const seenUrls = new Set();
        const urlsToFetch = [];
        for (const item of clusterItems) {
            if (seenUrls.has(item.url))
                continue;
            seenUrls.add(item.url);
            if (fetchCount >= opts.fetchBudget) {
                warnings.push(`[${topicId}/${cluster.clusterId}] fetch budget exhausted (${opts.fetchBudget}) — ` +
                    `${urlsToFetch.length} of ${clusterItems.length} URLs fetched for this cluster`);
                break;
            }
            urlsToFetch.push(item);
            fetchCount++;
        }
        const clusterDocs = [];
        const bodies = new Map();
        // Fetch + store each URL in the cluster (concurrent within cluster, budget-controlled)
        const fetchPromises = urlsToFetch.map(async (item) => {
            // Check if we already have a fresh copy in the store
            const existing = await fileEtlStore.getById(docIdFromUrl(item.url));
            if (existing) {
                clusterDocs.push(existing);
                const body = await fileEtlStore.getBody(existing.id);
                if (body)
                    bodies.set(existing.id, body);
                return;
            }
            const fetched = await fetchArticle(item.url, {
                title: item.title,
                publishedAt: item.publishedAt,
                source: item.source,
                tier: item.tier,
            });
            const { doc, body } = fetched;
            const putOpts = {};
            if (fetched.etag !== undefined)
                putOpts.etag = fetched.etag;
            if (fetched.lastModified !== undefined)
                putOpts.lastModified = fetched.lastModified;
            await fileEtlStore.put(doc, body, putOpts);
            clusterDocs.push(doc);
            if (body) {
                bodies.set(doc.id, body);
            }
            if (doc.accessPolicy === 'robots-disallowed') {
                warnings.push(`[${topicId}/${cluster.clusterId}] robots-disallowed: ${item.url}`);
            }
            else if (doc.accessPolicy === 'paywalled') {
                warnings.push(`[${topicId}/${cluster.clusterId}] paywalled (snippet-only): ${item.url}`);
            }
            else if (doc.extraction === 'failed') {
                warnings.push(`[${topicId}/${cluster.clusterId}] fetch failed: ${item.url}`);
            }
        });
        await Promise.all(fetchPromises);
        documents.push(...clusterDocs);
        // A4: Extract facts from the bodies in this cluster
        const pairs = clusterDocs
            .filter((doc) => doc.extraction !== 'failed')
            .map((doc) => ({ doc, body: bodies.get(doc.id) ?? '' }))
            .filter((p) => p.body.length >= 100);
        if (pairs.length === 0) {
            warnings.push(`[${topicId}/${cluster.clusterId}] no extractable bodies — 0 facts for this cluster`);
            factsByCluster[cluster.clusterId] = [];
            continue;
        }
        const { facts, warnings: factWarnings } = await extractFacts(pairs, topicId, cluster.clusterId);
        warnings.push(...factWarnings.map((w) => `[${topicId}/${cluster.clusterId}] ${w}`));
        // A5: Final copyright gate before placing facts on the wire artifact
        const { facts: wireFacts, violations } = validateFactsForWire(facts);
        warnings.push(...violations.map((v) => `[A5] ${v}`));
        factsByCluster[cluster.clusterId] = wireFacts;
    }
    return { documents, factsByCluster, warnings };
}
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export async function runAggregation(options = {}) {
    const now = options.now ?? new Date();
    const maxAgeMs = options.maxAgeMs ?? 36 * 60 * 60 * 1000;
    const perSourceTimeoutMs = options.perSourceTimeoutMs ?? 30_000;
    const concurrency = options.concurrency ?? 10;
    const cycle = buildCycle(now, options.cycle);
    const runId = options.runId ?? randomUUID();
    const warnings = [];
    const etlEnabled = options.etlEnabled ?? process.env['ARDUR_ETL_ENABLED'] === 'true';
    const etlFetchBudgetPerTopic = options.etlFetchBudgetPerTopic ?? 30;
    const allTopics = loadTopics();
    const activeTopics = allTopics.filter((t) => t.id !== 'all');
    // A2: Build the set of known catalog domains for new-domain logging
    const catalogDomains = new Set(loadSources().map((s) => s.domain));
    const searchProviders = defaultSearchProviders();
    const itemsByTopic = {};
    const clustersByTopic = {};
    const coverageByTopic = {};
    const documentsByTopic = {};
    const factsByClusterGlobal = {};
    // --------------------------------------------------------------------------
    // Per-topic ingestion + dedup + cluster (A1: no ceiling — all items kept)
    // --------------------------------------------------------------------------
    for (const topic of activeTopics) {
        const sources = sourcesForTopic(topic.id);
        const ingestResults = await ingestTopic(topic, sources, {
            now, maxAgeMs, concurrency, perSourceTimeoutMs,
        });
        const sourcesResponded = ingestResults.filter((r) => r.ok).length;
        const allItems = ingestResults.flatMap((r) => r.items);
        for (const r of ingestResults) {
            if (!r.ok && r.error) {
                warnings.push(`[${topic.id}] source ${r.source.domain}: ${r.error}`);
            }
        }
        // A2: Search discovery — merge results with feed items (dedup by URL)
        if (topic.query) {
            const searchResults = await searchAllProviders(topic.query, topic.id, now, searchProviders, catalogDomains, (domain, classification) => {
                warnings.push(`[${topic.id}] new domain discovered: ${domain} ` +
                    `(tier=${classification.tier}, credibility=${classification.credibilityHint}) — ` +
                    `flagged for catalog review`);
            });
            const existingUrls = new Set(allItems.map((i) => i.url));
            for (const result of searchResults) {
                if (!result.url || existingUrls.has(result.url))
                    continue;
                existingUrls.add(result.url);
                // Discovery results become thin RawItems (no full body yet — ETL handles that)
                const classification = catalogDomains.has(result.domain)
                    ? { tier: 'news', credibilityHint: 0.65 }
                    : { tier: 'news', credibilityHint: 0.6 };
                allItems.push({
                    topic: topic.id,
                    topicLabel: topic.label,
                    title: result.title,
                    source: result.sourceLabel ?? result.domain,
                    sourceDomain: result.domain,
                    sourceUrl: '',
                    url: result.url,
                    tier: classification.tier,
                    publishedAt: result.publishedAt ?? now.toISOString(),
                    summaryHint: '',
                    feedRank: 9999,
                });
            }
        }
        // Dedup (A1: keep all — no ceiling; dedup only removes true duplicates)
        const { items: dedupedItems, duplicatesRemoved } = dedupe(allItems);
        if (duplicatesRemoved > 0) {
            warnings.push(`[${topic.id}] dedup removed ${duplicatesRemoved} exact duplicates (same-source)`);
        }
        const preCluster = dedupedItems.map((item) => {
            const id = `${item.topic}-${item.fingerprint.slice(0, 24).replace(/[^a-z0-9]/g, '')}`;
            const interaction = captureInteractionMetrics({ feedRank: item.feedRank }, { capturedAt: now, provenance: 'rss-feed-position' });
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
        const { items: clusteredItems, clusters } = clusterItems(preCluster, {
            threshold: 0.82,
            importantTerms: topic.terms,
        });
        // A1: Verify no cluster is silently truncated — log member counts
        const clusterMap = new Map(clusters.map((c) => [c.clusterId, c]));
        const finalItems = clusteredItems.map((item) => {
            const cluster = clusterMap.get(item.clusterId);
            if (!cluster)
                return item;
            const velocity = cluster.memberIds.length / 6;
            return {
                ...item,
                interaction: {
                    ...item.interaction,
                    crossSourceMentions: cluster.distinctDomains,
                    velocity,
                },
            };
        });
        const distinctDomains = new Set(finalItems.map((i) => i.sourceDomain)).size;
        const degraded = distinctDomains < topic.diversityFloor;
        if (degraded) {
            warnings.push(`[${topic.id}] degraded: ${distinctDomains} distinct domains < floor ${topic.diversityFloor}`);
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
        // --------------------------------------------------------------------------
        // A3 + A4 + A5: ETL — full-text fetch + fact extraction + copyright guard
        // --------------------------------------------------------------------------
        if (etlEnabled) {
            const { documents, factsByCluster, warnings: etlWarnings } = await runEtlForTopic(topic.id, finalItems, clusters, { fetchBudget: etlFetchBudgetPerTopic, fetchTimeoutMs: perSourceTimeoutMs });
            warnings.push(...etlWarnings);
            documentsByTopic[topic.id] = documents;
            for (const [clusterId, clusterFacts] of Object.entries(factsByCluster)) {
                factsByClusterGlobal[clusterId] = clusterFacts;
            }
        }
    }
    // --------------------------------------------------------------------------
    // 'all' topic — merge + re-sort by crossSourceMentions (A1: full set)
    // --------------------------------------------------------------------------
    const allItemsFlat = Object.values(itemsByTopic).flat();
    const seenIds = new Set();
    const globalItems = [];
    for (const item of allItemsFlat.sort((a, b) => b.interaction.crossSourceMentions - a.interaction.crossSourceMentions)) {
        if (!seenIds.has(item.id)) {
            seenIds.add(item.id);
            globalItems.push(item);
        }
    }
    itemsByTopic['all'] = globalItems;
    clustersByTopic['all'] = Object.values(clustersByTopic).flat();
    coverageByTopic['all'] = {
        sourcesConfigured: Object.values(coverageByTopic).reduce((s, c) => s + c.sourcesConfigured, 0),
        sourcesQueried: Object.values(coverageByTopic).reduce((s, c) => s + c.sourcesQueried, 0),
        sourcesResponded: Object.values(coverageByTopic).reduce((s, c) => s + c.sourcesResponded, 0),
        distinctDomains: new Set(globalItems.map((i) => i.sourceDomain)).size,
        degraded: false,
    };
    // Build artifact — rev 3 (AggregationData already carries the optional ETL fields)
    const artifact = {
        schemaVersion: SCHEMA_VERSION,
        contractRevision: etlEnabled ? CONTRACT_REVISION_V3 : CONTRACT_REVISION,
        artifact: 'aggregation',
        runId,
        upstreamRunId: null,
        generatedAt: now.toISOString(),
        cycle,
        topics: allTopics.map(({ id, label, description }) => ({ id, label, description })),
        warnings,
        data: {
            itemsByTopic,
            clustersByTopic,
            coverageByTopic,
            ...(etlEnabled
                ? {
                    documentsByTopic,
                    factsByCluster: factsByClusterGlobal,
                }
                : {}),
        },
    };
    const { warnings: gateWarnings } = assertCompatibleArtifact(artifact, 'aggregation');
    artifact.warnings.push(...gateWarnings);
    return artifact;
}
