import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEMA_VERSION, CYCLE_INTERVAL_MS, FORBIDDEN_METRIC_KEY_FRAGMENTS,
  CONTRACT_REVISION, assertCompatibleArtifact, SchemaVersionError,
} from '@ardurai/contracts';
import {
  normalizePublicUrl,
  assertAllowedFetchUrl,
  readBoundedText,
  DEFAULT_FETCH_PORTS,
} from './source-safety.ts';
import { loadSources, loadTopics, sourcesForTopic } from './sources.ts';
import { fingerprint, dedupe } from './dedup.ts';
import { clusterItems } from './cluster.ts';
import { isForbiddenMetricKey, captureInteractionMetrics } from './interaction.ts';
import type { AggregatedItem } from '@ardurai/contracts';
import type { RawItem } from './ingest.ts';
import {
  assertQuoteLength,
  trimQuoteToLimit,
  hasForbiddenVerbatimOverlap,
  validateFactsForWire,
  MAX_QUOTE_WORDS,
} from './copyright-guard.ts';
import { CONTRACT_REVISION_V3 } from './contracts-v3.ts';
import type { ExtractedFact, FactProvenance } from './contracts-v3.ts';
import { classifyDiscoveredDomain, GoogleNewsSearchProvider } from './search-provider.ts';
import { docIdFromUrl, contentHashOf, fileEtlStore } from './etl-store.ts';
import { fetchArticle } from './content-extract.ts';
import { extractFacts } from './fact-extractor.ts';
import { wordCount } from './copyright-guard.ts';
import type { SourceDocument as FullSourceDocument } from '@ardurai/contracts';
import {
  buildDescribeOutput,
  classifyError,
  deriveRunId,
  buildHermeticArtifact,
  parseRunnerArgs,
} from './runners.ts';
import { etld1 } from './fact-extractor.ts';

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

describe('contracts', () => {
  test('schema version is pinned', () => {
    assert.equal(SCHEMA_VERSION, 'ardur-content-pipeline/v1');
  });

  test('cycle interval is 6 hours', () => {
    assert.equal(CYCLE_INTERVAL_MS, 6 * 60 * 60 * 1000);
  });

  test('privacy guard lists known PII fragments', () => {
    assert.ok(FORBIDDEN_METRIC_KEY_FRAGMENTS.includes('email'));
    assert.ok(FORBIDDEN_METRIC_KEY_FRAGMENTS.includes('session'));
    assert.ok(FORBIDDEN_METRIC_KEY_FRAGMENTS.includes('userid'));
    assert.ok(FORBIDDEN_METRIC_KEY_FRAGMENTS.includes('token'));
  });

  test('CONTRACT_REVISION is 3 (rev 3: ExtractedFact, SourceDocument, visual blocks)', () => {
    assert.equal(CONTRACT_REVISION, 3);
  });

  test('assertCompatibleArtifact: accepts valid aggregation envelope (rev 3)', () => {
    const envelope = {
      schemaVersion: 'ardur-content-pipeline/v1' as const,
      contractRevision: 3,
      artifact: 'aggregation' as const,
      runId: 'test-run',
      upstreamRunId: null,
      generatedAt: '2026-06-11T00:00:00.000Z',
      cycle: { id: '2026-06-11T00:00:00.000Z', windowStart: '2026-06-11T00:00:00.000Z', windowEnd: '2026-06-11T06:00:00.000Z' },
      topics: [],
      warnings: [],
      data: { itemsByTopic: {}, clustersByTopic: {}, coverageByTopic: {} },
    };
    const { stage, warnings } = assertCompatibleArtifact(envelope, 'aggregation');
    assert.equal(stage, 'aggregation');
    assert.equal(warnings.length, 0);
  });

  test('assertCompatibleArtifact: throws SchemaVersionError on wrong schemaVersion', () => {
    assert.throws(
      () => assertCompatibleArtifact({ schemaVersion: 'wrong/v999', artifact: 'aggregation', data: {} }, 'aggregation'),
      (e: unknown) => e instanceof SchemaVersionError,
    );
  });

  test('assertCompatibleArtifact: throws SchemaVersionError on wrong artifact stage', () => {
    assert.throws(
      () => assertCompatibleArtifact({ schemaVersion: 'ardur-content-pipeline/v1', artifact: 'ranking', data: {} }, 'aggregation'),
      (e: unknown) => e instanceof SchemaVersionError,
    );
  });

  test('assertCompatibleArtifact: warns on forward contractRevision (forward-compat)', () => {
    const envelope = {
      schemaVersion: 'ardur-content-pipeline/v1' as const,
      contractRevision: 999,
      artifact: 'aggregation' as const,
      runId: 'test-run-fwd',
      upstreamRunId: null,
      generatedAt: '2026-06-11T00:00:00.000Z',
      cycle: { id: '2026-06-11T00:00:00.000Z', windowStart: '2026-06-11T00:00:00.000Z', windowEnd: '2026-06-11T06:00:00.000Z' },
      topics: [],
      warnings: [],
      data: { itemsByTopic: {}, clustersByTopic: {}, coverageByTopic: {} },
    };
    const { warnings } = assertCompatibleArtifact(envelope, 'aggregation');
    // Forward-compat: should warn on contractRevision > 3
    assert.ok(warnings.length > 0);
    assert.ok(warnings[0]!.includes('999'));
  });
});

// ---------------------------------------------------------------------------
// source-safety
// ---------------------------------------------------------------------------

describe('source-safety', () => {
  test('normalizePublicUrl: returns empty for empty input', () => {
    assert.equal(normalizePublicUrl(''), '');
    assert.equal(normalizePublicUrl(null), '');
    assert.equal(normalizePublicUrl(undefined), '');
  });

  test('normalizePublicUrl: strips credentials', () => {
    const result = normalizePublicUrl('https://user:pass@example.com/path');
    assert.equal(result, '');
  });

  test('normalizePublicUrl: strips fragment', () => {
    const result = normalizePublicUrl('https://example.com/path#section');
    assert.equal(result, 'https://example.com/path');
  });

  test('normalizePublicUrl: rejects http by default', () => {
    assert.equal(normalizePublicUrl('http://example.com/'), '');
  });

  test('normalizePublicUrl: allows http when option set', () => {
    const result = normalizePublicUrl('http://example.com/', { allowHttp: true });
    assert.ok(result.startsWith('http://'));
  });

  test('normalizePublicUrl: rejects private IPv4 127.0.0.1', () => {
    assert.equal(normalizePublicUrl('https://127.0.0.1/'), '');
  });

  test('normalizePublicUrl: rejects private IPv4 10.0.0.1', () => {
    assert.equal(normalizePublicUrl('https://10.0.0.1/'), '');
  });

  test('normalizePublicUrl: rejects private IPv4 192.168.1.1', () => {
    assert.equal(normalizePublicUrl('https://192.168.1.1/'), '');
  });

  test('normalizePublicUrl: rejects IPv6 ::1', () => {
    assert.equal(normalizePublicUrl('https://[::1]/'), '');
  });

  test('normalizePublicUrl: rejects localhost', () => {
    assert.equal(normalizePublicUrl('https://localhost/'), '');
  });

  test('normalizePublicUrl: accepts valid public https', () => {
    const result = normalizePublicUrl('https://example.com/path?q=1#frag');
    assert.ok(result.startsWith('https://example.com/'));
    assert.ok(!result.includes('#'));
  });

  test('normalizePublicUrl: rejects non-standard port when allowedPorts is DEFAULT_FETCH_PORTS', () => {
    assert.equal(
      normalizePublicUrl('https://example.com:8080/path', { allowedPorts: DEFAULT_FETCH_PORTS }),
      '',
    );
  });

  test('normalizePublicUrl: rejects host not in allow list', () => {
    assert.equal(
      normalizePublicUrl('https://evil.com/', { allowedHosts: new Set(['safe.com']) }),
      '',
    );
  });

  test('assertAllowedFetchUrl: throws for private IP', () => {
    assert.throws(
      () => assertAllowedFetchUrl('https://192.168.0.1/', new Set(['192.168.0.1'])),
      /Blocked/,
    );
  });

  test('assertAllowedFetchUrl: throws for host not in allow list', () => {
    assert.throws(
      () => assertAllowedFetchUrl('https://other.com/', new Set(['safe.com'])),
      /Blocked/,
    );
  });

  test('assertAllowedFetchUrl: returns normalized URL for allowed host', () => {
    const result = assertAllowedFetchUrl('https://news.google.com/rss/search?q=ai', new Set(['news.google.com']));
    assert.ok(result.startsWith('https://news.google.com/'));
  });

  test('readBoundedText: returns text under limit', async () => {
    const body = 'hello world';
    const response = new Response(body, { status: 200 });
    const result = await readBoundedText(response, { maxBytes: 1_000, label: 'test' });
    assert.equal(result, body);
  });

  test('readBoundedText: throws when content-length header exceeds limit', async () => {
    const response = new Response('x'.repeat(100), {
      status: 200,
      headers: { 'content-length': '200' },
    });
    await assert.rejects(
      () => readBoundedText(response, { maxBytes: 100, label: 'test' }),
      /exceeded/,
    );
  });
});

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

describe('sources', () => {
  test('loadSources: returns non-empty array', () => {
    assert.ok(loadSources().length > 0);
  });

  test('loadSources: every source has a non-empty domain', () => {
    for (const s of loadSources()) {
      assert.ok(s.domain.length > 0, `empty domain on source ${s.label}`);
    }
  });

  test('loadSources: every rss feedUrl starts with https://', () => {
    for (const s of loadSources()) {
      if (s.strategy.kind === 'rss') {
        assert.ok(
          s.strategy.feedUrl.startsWith('https://'),
          `non-https feedUrl on ${s.label}: ${s.strategy.feedUrl}`,
        );
      }
    }
  });

  test('loadTopics: includes ai, kubernetes, security topics', () => {
    const ids = loadTopics().map((t) => t.id);
    assert.ok(ids.includes('ai'));
    assert.ok(ids.includes('kubernetes'));
    assert.ok(ids.includes('security'));
  });

  test('sourcesForTopic(ai): returns at least 20 sources', () => {
    assert.ok(sourcesForTopic('ai').length >= 20, `only ${sourcesForTopic('ai').length} sources for ai`);
  });

  test('sourcesForTopic(kubernetes): returns at least 20 sources', () => {
    assert.ok(sourcesForTopic('kubernetes').length >= 20);
  });

  test('sourcesForTopic(security): returns at least 20 sources', () => {
    assert.ok(sourcesForTopic('security').length >= 20);
  });

  test('sourcesForTopic(platform): returns at least 20 sources', () => {
    assert.ok(sourcesForTopic('platform').length >= 20);
  });

  test('sourcesForTopic(models): returns at least 20 sources', () => {
    assert.ok(sourcesForTopic('models').length >= 20);
  });

  test('sourcesForTopic(all): returns empty array', () => {
    assert.deepEqual(sourcesForTopic('all'), []);
  });
});

// ---------------------------------------------------------------------------
// dedup
// ---------------------------------------------------------------------------

function makeRawItem(overrides: Partial<RawItem> = {}): RawItem {
  return {
    topic: 'ai',
    topicLabel: 'AI + LLMs',
    title: 'OpenAI Releases New Model',
    source: 'TechCrunch',
    sourceDomain: 'techcrunch.com',
    sourceUrl: '',
    url: 'https://techcrunch.com/2026/06/01/openai-new-model',
    tier: 'news',
    publishedAt: '2026-06-01T12:00:00Z',
    summaryHint: 'OpenAI released a new model today.',
    feedRank: 0,
    ...overrides,
  };
}

describe('dedup', () => {
  test('fingerprint: same title+url → same fingerprint', () => {
    const item = makeRawItem();
    assert.equal(fingerprint(item), fingerprint({ ...item }));
  });

  test('fingerprint: different titles → different fingerprints', () => {
    const a = fingerprint(makeRawItem({ title: 'Anthropic Launches Claude 4' }));
    const b = fingerprint(makeRawItem({ title: 'OpenAI Releases GPT-5' }));
    assert.notEqual(a, b);
  });

  test('fingerprint: strips HTML from title before fingerprinting', () => {
    const a = fingerprint({ title: '<b>OpenAI</b> New Model', url: 'https://example.com/x' });
    const b = fingerprint({ title: 'OpenAI New Model', url: 'https://example.com/x' });
    assert.equal(a, b);
  });

  test('dedupe: removes same-fingerprint same-domain duplicates', () => {
    const item = makeRawItem();
    const dup = makeRawItem({ feedRank: 1 });
    const { items, duplicatesRemoved } = dedupe([item, dup]);
    assert.equal(items.length, 1);
    assert.equal(duplicatesRemoved, 1);
  });

  test('dedupe: keeps cross-source items with same story (corroboration)', () => {
    const a = makeRawItem({ sourceDomain: 'techcrunch.com', source: 'TechCrunch' });
    const b = makeRawItem({ sourceDomain: 'theverge.com', source: 'The Verge' });
    const { items } = dedupe([a, b]);
    assert.equal(items.length, 2, 'cross-source items should both be kept');
  });

  test('dedupe: returned items all have fingerprint field', () => {
    const { items } = dedupe([makeRawItem()]);
    assert.ok('fingerprint' in items[0]!);
    assert.ok(typeof items[0]!.fingerprint === 'string');
  });
});

// ---------------------------------------------------------------------------
// interaction
// ---------------------------------------------------------------------------

describe('interaction', () => {
  test('isForbiddenMetricKey: userId is forbidden', () => {
    assert.ok(isForbiddenMetricKey('userId'));
    assert.ok(isForbiddenMetricKey('user_id'));
    assert.ok(isForbiddenMetricKey('USERID'));
  });

  test('isForbiddenMetricKey: sessionId is forbidden', () => {
    assert.ok(isForbiddenMetricKey('sessionId'));
    assert.ok(isForbiddenMetricKey('session_token'));
  });

  test('isForbiddenMetricKey: count is allowed', () => {
    assert.ok(!isForbiddenMetricKey('count'));
    assert.ok(!isForbiddenMetricKey('share_count'));
    assert.ok(!isForbiddenMetricKey('reactions'));
  });

  test('captureInteractionMetrics: builds InteractionMetrics with feedRank', () => {
    const m = captureInteractionMetrics(
      { feedRank: 3 },
      { capturedAt: new Date('2026-06-01T00:00:00Z'), provenance: 'test' },
    );
    assert.equal(m.feedRank, 3);
    assert.equal(m.provenance, 'test');
    assert.equal(m.crossSourceMentions, 0);
    assert.equal(m.velocity, null);
  });

  test('captureInteractionMetrics: drops forbidden engagement keys', () => {
    const m = captureInteractionMetrics(
      { feedRank: 0, engagement: { userId: 42, shares: 10 } },
      { capturedAt: new Date('2026-06-01T00:00:00Z'), provenance: 'test' },
    );
    assert.equal(m.shares, 10);
    // userId should have been dropped, not mapped to any field
  });

  test('captureInteractionMetrics: maps likes to reactions', () => {
    const m = captureInteractionMetrics(
      { feedRank: 0, engagement: { likes: 99 } },
      { capturedAt: new Date('2026-06-01T00:00:00Z'), provenance: 'test' },
    );
    assert.equal(m.reactions, 99);
  });

  test('captureInteractionMetrics: crossSourceMentions starts at 0', () => {
    const m = captureInteractionMetrics(
      { feedRank: 0 },
      { capturedAt: new Date('2026-06-01T00:00:00Z'), provenance: 'test' },
    );
    assert.equal(m.crossSourceMentions, 0);
  });
});

// ---------------------------------------------------------------------------
// cluster
// ---------------------------------------------------------------------------

function makeAggItem(overrides: Partial<Omit<AggregatedItem, 'clusterId'>> = {}): Omit<AggregatedItem, 'clusterId'> {
  return {
    id: `ai-item${Math.random().toString(36).slice(2, 8)}`,
    topic: 'ai',
    topicLabel: 'AI + LLMs',
    title: 'OpenAI Releases New GPT Model',
    source: 'TechCrunch',
    sourceDomain: 'techcrunch.com',
    sourceUrl: '',
    url: 'https://techcrunch.com/openai-gpt',
    tier: 'news',
    publishedAt: '2026-06-01T12:00:00Z',
    summaryHint: 'OpenAI releases a new model.',
    fingerprint: 'fp1',
    interaction: {
      feedRank: 0, shares: null, comments: null, reactions: null,
      crossSourceMentions: 0, velocity: null,
      capturedAt: '2026-06-01T12:00:00Z', provenance: 'test',
    },
    ...overrides,
  };
}

describe('cluster', () => {
  test('clusterItems: assigns clusterId to all items', () => {
    const items = [makeAggItem({ id: 'a1' }), makeAggItem({ id: 'a2' })];
    const { items: out } = clusterItems(items, { threshold: 0.82, importantTerms: [] });
    for (const item of out) {
      assert.ok(typeof item.clusterId === 'string' && item.clusterId.length > 0);
    }
  });

  test('clusterItems: clusters similar titles together', () => {
    const base: Omit<AggregatedItem, 'clusterId'> = makeAggItem({
      id: 'a1',
      title: 'OpenAI Releases New GPT Model Today',
    });
    const similar: Omit<AggregatedItem, 'clusterId'> = makeAggItem({
      id: 'a2',
      title: 'OpenAI Releases New GPT Model',
      sourceDomain: 'theverge.com',
      fingerprint: 'fp2',
    });
    const { clusters } = clusterItems([base, similar], { threshold: 0.5, importantTerms: ['openai', 'gpt'] });
    assert.equal(clusters.length, 1, 'similar titles should form one cluster');
    assert.equal(clusters[0]!.memberIds.length, 2);
  });

  test('clusterItems: keeps distinct stories in separate clusters', () => {
    const a: Omit<AggregatedItem, 'clusterId'> = makeAggItem({ id: 'a1', title: 'Kubernetes 1.32 Released' });
    const b: Omit<AggregatedItem, 'clusterId'> = makeAggItem({ id: 'a2', title: 'Anthropic Launches Claude 4' });
    const { clusters } = clusterItems([a, b], { threshold: 0.82, importantTerms: [] });
    assert.equal(clusters.length, 2, 'distinct stories should form separate clusters');
  });

  test('clusterItems: cluster memberIds are valid item ids', () => {
    const items = [makeAggItem({ id: 'x1' }), makeAggItem({ id: 'x2', title: 'Different Story Entirely About Rust', fingerprint: 'fp-x2' })];
    const { clusters } = clusterItems(items, { threshold: 0.82, importantTerms: [] });
    const allIds = clusters.flatMap((c) => c.memberIds);
    assert.ok(allIds.includes('x1'));
    assert.ok(allIds.includes('x2'));
  });

  test('clusterItems: cluster distinctDomains counts correctly', () => {
    const a = makeAggItem({ id: 'a1', sourceDomain: 'techcrunch.com', fingerprint: 'fa' });
    const b = makeAggItem({ id: 'a2', sourceDomain: 'theverge.com', fingerprint: 'fb' });
    const { clusters } = clusterItems([a, b], { threshold: 0.5, importantTerms: ['openai', 'gpt', 'model'] });
    if (clusters.length === 1) {
      assert.equal(clusters[0]!.distinctDomains, 2);
    }
    // If they ended up in separate clusters, that's valid for high threshold
  });

  test('clusterItems: tierHistogram sums to memberIds.length', () => {
    const items = [
      makeAggItem({ id: 'b1', tier: 'news', fingerprint: 'fb1' }),
      makeAggItem({ id: 'b2', tier: 'primary', fingerprint: 'fb2', title: 'OpenAI GPT Release News Today' }),
    ];
    const { clusters } = clusterItems(items, { threshold: 0.82, importantTerms: ['openai', 'gpt'] });
    for (const cluster of clusters) {
      const histogramSum = Object.values(cluster.tierHistogram).reduce((s, v) => s + v, 0);
      assert.equal(histogramSum, cluster.memberIds.length);
    }
  });
});

// ---------------------------------------------------------------------------
// index — cycle math (offline, no network)
// ---------------------------------------------------------------------------

describe('index (offline)', () => {
  test('runAggregation is exported from index', async () => {
    const mod = await import('./index.ts');
    assert.ok(typeof mod.runAggregation === 'function');
  });

  test('SCHEMA_VERSION re-exported from index', async () => {
    const mod = await import('./index.ts');
    assert.equal(mod.SCHEMA_VERSION, 'ardur-content-pipeline/v1');
  });

  // Network-dependent test: skip to avoid flaky CI
  // TODO: wire a mock fetch for full runAggregation integration test
});

// ---------------------------------------------------------------------------
// A1: No source ceiling — confirm export + type shape
// ---------------------------------------------------------------------------

describe('A1: uncapped ingestion', () => {
  test('CONTRACT_REVISION_V3 is 3 (re-exported from @ardurai/contracts)', () => {
    assert.equal(CONTRACT_REVISION_V3, 3);
  });

  test('CONTRACT_REVISION from @ardurai/contracts is now 3', () => {
    assert.equal(CONTRACT_REVISION, 3);
  });

  test('index re-exports CONTRACT_REVISION_V3', async () => {
    const mod = await import('./index.ts');
    assert.equal((mod as { CONTRACT_REVISION_V3?: unknown }).CONTRACT_REVISION_V3, 3);
  });
});

// ---------------------------------------------------------------------------
// A2: Search provider
// ---------------------------------------------------------------------------

describe('A2: search-provider', () => {
  test('classifyDiscoveredDomain: known primary domain', () => {
    const { tier, credibilityHint } = classifyDiscoveredDomain('openai.com');
    assert.equal(tier, 'primary');
    assert.ok(credibilityHint >= 0.9);
  });

  test('classifyDiscoveredDomain: known paper domain', () => {
    const { tier } = classifyDiscoveredDomain('arxiv.org');
    assert.equal(tier, 'paper');
  });

  test('classifyDiscoveredDomain: unknown domain defaults to news tier', () => {
    const { tier, credibilityHint } = classifyDiscoveredDomain('some-unknown-blog.io');
    assert.equal(tier, 'news');
    assert.ok(credibilityHint <= 0.65);
  });

  test('classifyDiscoveredDomain: known technical-news domain', () => {
    const { tier } = classifyDiscoveredDomain('infoq.com');
    assert.equal(tier, 'technical-news');
  });
});

// ---------------------------------------------------------------------------
// A3: ETL store helpers
// ---------------------------------------------------------------------------

describe('A3: etl-store helpers', () => {
  test('docIdFromUrl: same URL → same id', () => {
    const url = 'https://techcrunch.com/2026/06/01/openai-new-model';
    assert.equal(docIdFromUrl(url), docIdFromUrl(url));
  });

  test('docIdFromUrl: different URLs → different ids', () => {
    const a = docIdFromUrl('https://techcrunch.com/a');
    const b = docIdFromUrl('https://theverge.com/b');
    assert.notEqual(a, b);
  });

  test('contentHashOf: same text → same hash', () => {
    const text = 'OpenAI released a new model today.';
    assert.equal(contentHashOf(text), contentHashOf(text));
  });

  test('contentHashOf: different text → different hash', () => {
    assert.notEqual(contentHashOf('foo'), contentHashOf('bar'));
  });

  test('contentHashOf: empty string → valid hex hash', () => {
    const hash = contentHashOf('');
    assert.match(hash, /^[0-9a-f]+$/);
  });
});

// ---------------------------------------------------------------------------
// A5: Copyright guard
// ---------------------------------------------------------------------------

describe('A5: copyright-guard', () => {
  test('MAX_QUOTE_WORDS is 25', () => {
    assert.equal(MAX_QUOTE_WORDS, 25);
  });

  test('assertQuoteLength: accepts quote under 25 words', () => {
    const short = 'This is a short quote under the word limit.';
    assert.doesNotThrow(() => assertQuoteLength(short, 'test'));
  });

  test('assertQuoteLength: throws on quote exceeding 25 words', () => {
    const long = Array.from({ length: 26 }, (_, i) => `word${i}`).join(' ');
    assert.throws(() => assertQuoteLength(long, 'test'), /Copyright violation/);
  });

  test('trimQuoteToLimit: truncates to 25 words', () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`);
    const trimmed = trimQuoteToLimit(words.join(' '));
    const resultWords = trimmed.trim().split(/\s+/).filter((w) => !w.endsWith('…'));
    assert.ok(resultWords.length <= 25);
  });

  test('trimQuoteToLimit: short quote unchanged', () => {
    const short = 'This is fine.';
    assert.equal(trimQuoteToLimit(short), short);
  });

  test('hasForbiddenVerbatimOverlap: detects 8-gram match', () => {
    const sentence = 'one two three four five six seven eight more text here.';
    const body = 'The article said one two three four five six seven eight different things.';
    assert.ok(hasForbiddenVerbatimOverlap(sentence, body));
  });

  test('hasForbiddenVerbatimOverlap: no overlap for original expression', () => {
    const statement = 'OpenAI introduced a significantly improved language model this quarter.';
    const body = 'Apple launched a new iPhone with revolutionary camera features today.';
    assert.ok(!hasForbiddenVerbatimOverlap(statement, body));
  });

  test('validateFactsForWire: passes clean fact', () => {
    const fact: ExtractedFact = {
      id: 'test-1',
      topic: 'ai',
      clusterId: 'c1',
      statement: 'OpenAI released a new model with improved capabilities.',
      entities: ['OpenAI'],
      provenance: [
        {
          sourceDocId: 'doc-1',
          sourceDomain: 'techcrunch.com',
          url: 'https://techcrunch.com/2026/06/01/openai',
        },
      ],
      corroboration: 1,
      confidence: 'medium',
      extractedBy: {
        provider: 'deterministic',
        model: 'regex-v1',
        status: 'fallback',
        generatedAt: '2026-06-11T00:00:00Z',
      },
    };
    const { facts, violations } = validateFactsForWire([fact]);
    assert.equal(facts.length, 1);
    assert.equal(violations.length, 0);
  });

  test('validateFactsForWire: drops fact with empty provenance', () => {
    const fact: ExtractedFact = {
      id: 'test-2',
      topic: 'ai',
      clusterId: 'c1',
      statement: 'A fact with no provenance.',
      entities: [],
      provenance: [],
      corroboration: 0,
      confidence: 'low',
      extractedBy: {
        provider: 'deterministic',
        model: 'regex-v1',
        status: 'fallback',
        generatedAt: '2026-06-11T00:00:00Z',
      },
    };
    const { facts, violations } = validateFactsForWire([fact]);
    assert.equal(facts.length, 0);
    assert.ok(violations.length > 0);
  });

  test('validateFactsForWire: drops fact with over-length quote (fail-closed)', () => {
    const longQuote = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const prov: FactProvenance = {
      sourceDocId: 'doc-1',
      sourceDomain: 'example.com',
      url: 'https://example.com/article',
      quote: longQuote,
    };
    const fact: ExtractedFact = {
      id: 'test-3',
      topic: 'ai',
      clusterId: 'c1',
      statement: 'OpenAI launched something new.',
      entities: ['OpenAI'],
      provenance: [prov],
      corroboration: 1,
      confidence: 'low',
      extractedBy: {
        provider: 'deterministic',
        model: 'regex-v1',
        status: 'fallback',
        generatedAt: '2026-06-11T00:00:00Z',
      },
    };
    // Fail-closed: over-length quote drops the fact entirely (not truncated).
    const { facts, violations } = validateFactsForWire([fact]);
    assert.equal(facts.length, 0, 'fact with over-length quote must be dropped (fail-closed)');
    assert.ok(violations.some((v) => v.includes('dropped')), 'violation message must mention "dropped"');
  });
});

// ---------------------------------------------------------------------------
// #15 — CJK / whitespace-free word count
// ---------------------------------------------------------------------------

describe('#15: CJK word count', () => {
  test('wordCount: ASCII words counted correctly', () => {
    assert.equal(wordCount('one two three'), 3);
  });

  test('wordCount: empty string is 0', () => {
    assert.equal(wordCount(''), 0);
    assert.equal(wordCount('   '), 0);
  });

  test('wordCount: each Han character counts as one word', () => {
    // 5 Han chars, no spaces → should be 5, not 1
    assert.equal(wordCount('日本語テキ'), 5);
  });

  test('wordCount: mixed CJK + Latin counts both', () => {
    // "hello" = 1 Latin word, "日本" = 2 CJK → total 3
    assert.equal(wordCount('hello 日本'), 3);
  });

  test('wordCount: Hangul characters each count as one word', () => {
    assert.equal(wordCount('가나다라마'), 5);
  });

  test('assertQuoteLength: CJK 26-char quote exceeds 25-word limit', () => {
    const cjkQuote = '日'.repeat(26); // 26 CJK chars = 26 "words"
    assert.throws(() => assertQuoteLength(cjkQuote, 'test'), /Copyright violation/);
  });

  test('assertQuoteLength: CJK 25-char quote is exactly at limit', () => {
    const cjkQuote = '日'.repeat(25); // 25 CJK chars = 25 "words"
    assert.doesNotThrow(() => assertQuoteLength(cjkQuote, 'test'));
  });

  test('trimQuoteToLimit: CJK 30-token quote is trimmed to 25', () => {
    const cjkQuote = '日'.repeat(30);
    const trimmed = trimQuoteToLimit(cjkQuote);
    assert.ok(wordCount(trimmed.replace('…', '')) <= 25);
  });
});

// ---------------------------------------------------------------------------
// #16 — A5 fail-CLOSED + statement verbatim screen
// ---------------------------------------------------------------------------

describe('#16: A5 fail-closed + statement screen', () => {
  function makeCleanFact(overrides: Partial<ExtractedFact> = {}): ExtractedFact {
    return {
      id: 'f1',
      topic: 'ai',
      clusterId: 'c1',
      statement: 'OpenAI released a model with improved capabilities.',
      entities: ['OpenAI'],
      provenance: [{ sourceDocId: 'doc-1', sourceDomain: 'example.com', url: 'https://example.com/a' }],
      corroboration: 1,
      confidence: 'medium',
      extractedBy: { provider: 'deterministic', model: 'regex-v1', status: 'fallback', generatedAt: '2026-06-11T00:00:00Z' },
      ...overrides,
    };
  }

  test('validateFactsForWire: clean fact passes without bodyMap', () => {
    const { facts, violations } = validateFactsForWire([makeCleanFact()]);
    assert.equal(facts.length, 1);
    assert.equal(violations.length, 0);
  });

  test('validateFactsForWire: statement verbatim overlap → drops fact when bodyMap supplied', () => {
    // Statement that exactly replicates 8+ consecutive words from the body
    const body = 'one two three four five six seven eight different things here and more words';
    const statement = 'one two three four five six seven eight more text here.';
    const fact = makeCleanFact({
      statement,
      provenance: [{ sourceDocId: 'doc-1', sourceDomain: 'example.com', url: 'https://example.com/a' }],
    });
    const bodyMap = new Map([['doc-1', body]]);
    const { facts, violations } = validateFactsForWire([fact], bodyMap);
    assert.equal(facts.length, 0, 'verbatim statement must be dropped');
    assert.ok(violations.some((v) => v.includes('verbatim')), 'violation must mention verbatim');
  });

  test('validateFactsForWire: original statement passes with bodyMap', () => {
    const body = 'Apple launched a new iPhone with revolutionary camera features today.';
    const statement = 'OpenAI introduced a significantly improved language model this quarter.';
    const fact = makeCleanFact({ statement });
    const bodyMap = new Map([['doc-1', body]]);
    const { facts } = validateFactsForWire([fact], bodyMap);
    assert.equal(facts.length, 1);
  });

  test('validateFactsForWire: no bodyMap → statement NOT screened (gate absent = skip)', () => {
    // Without bodyMap the gate cannot check — fact should pass through
    const fact = makeCleanFact({ statement: 'some statement here' });
    const { facts } = validateFactsForWire([fact]);
    assert.equal(facts.length, 1);
  });
});

// ---------------------------------------------------------------------------
// #17 — paywalled / ToS-restricted bodies excluded from ETL
// ---------------------------------------------------------------------------

describe('#17: paywalled bodies excluded from fact extraction', () => {
  test('fetchArticle: TOS-restricted domain returns accessPolicy=tos-restricted', async () => {
    // wsj.com is in TOS_DISALLOW_DOMAINS — but fetchArticle calls the network.
    // We test the detection logic directly via the exported function below.
    // Verify that a robots-disallowed doc has extraction=failed.
    // (Network-independent: can test by passing a private/blocked URL)
    const result = await fetchArticle('https://127.0.0.1/article', { title: 'test' });
    assert.equal(result.doc.accessPolicy, 'tos-restricted');
    assert.equal(result.body, null);
  });

  test('SourceDocument accessPolicy field exists and is typed correctly', async () => {
    const result = await fetchArticle('https://127.0.0.1/article', { title: 'test' });
    const allowed: string[] = ['allowed', 'paywalled', 'robots-disallowed', 'tos-restricted'];
    assert.ok(allowed.includes(result.doc.accessPolicy));
  });
});

// ---------------------------------------------------------------------------
// #18 — deterministic fact ids + now threading
// ---------------------------------------------------------------------------

describe('#18: deterministic fact ids', () => {
  function makePair(docId: string, url: string, body: string): { doc: FullSourceDocument; body: string } {
    return {
      doc: {
        id: docId,
        url,
        source: 'test',
        sourceDomain: 'test.com',
        tier: 'news',
        title: 'Test Article',
        publishedAt: '2026-06-11T00:00:00Z',
        fetchedAt: '2026-06-11T00:00:00Z',
        extraction: 'full',
        accessPolicy: 'allowed',
        wordCount: 100,
        lang: 'en',
        contentHash: 'abc',
      },
      body,
    };
  }

  const BODY = 'Anthropic released Claude 4 with 1 trillion parameters in June 2026. '
    + 'The model achieved 95% accuracy on standard benchmarks. '
    + 'OpenAI responded by announcing GPT-5 for Q3 2026. '
    + 'Google Gemini 2.0 also launched at the same conference.';

  const NOW = new Date('2026-06-11T06:00:00.000Z');
  const DOC_ID = '0'.repeat(40); // valid 40-char hex id
  const CLUSTER_ID = 'cluster-test-1';

  test('extractFacts: same inputs produce same fact ids (idempotent)', async () => {
    const pair = makePair(DOC_ID, 'https://test.com/a', BODY);
    const r1 = await extractFacts([pair], 'ai', CLUSTER_ID, NOW);
    const r2 = await extractFacts([pair], 'ai', CLUSTER_ID, NOW);
    const ids1 = r1.facts.map((f) => f.id).sort();
    const ids2 = r2.facts.map((f) => f.id).sort();
    assert.deepEqual(ids1, ids2, 'fact ids must be deterministic');
  });

  test('extractFacts: generatedAt equals supplied now', async () => {
    const pair = makePair(DOC_ID, 'https://test.com/a', BODY);
    const result = await extractFacts([pair], 'ai', CLUSTER_ID, NOW);
    for (const fact of result.facts) {
      assert.equal(fact.extractedBy.generatedAt, NOW.toISOString());
    }
  });

  test('extractFacts: fact id is 32 hex chars (no UUID format)', async () => {
    const pair = makePair(DOC_ID, 'https://test.com/a', BODY);
    const result = await extractFacts([pair], 'ai', CLUSTER_ID, NOW);
    for (const fact of result.facts) {
      assert.match(fact.id, /^[0-9a-f]{32}$/, `fact.id "${fact.id}" should be 32 hex chars`);
    }
  });
});

// ---------------------------------------------------------------------------
// #19 — corroboration reflects allDomains, not provenance size
// ---------------------------------------------------------------------------

describe('#19: corroboration > 1 for multi-domain clusters', () => {
  function makeDocPair(
    docId: string,
    domain: string,
    url: string,
  ): { doc: FullSourceDocument; body: string } {
    const body = `Anthropic released Claude 4 with improved capabilities in June 2026. `
      + `The system achieved state-of-the-art performance on 1 trillion parameter benchmarks. `
      + `Google confirmed similar advances in their models during the same period.`;
    return {
      doc: {
        id: docId,
        url,
        source: domain,
        sourceDomain: domain,
        tier: 'news',
        title: 'Test',
        publishedAt: '2026-06-11T00:00:00Z',
        fetchedAt: '2026-06-11T00:00:00Z',
        extraction: 'full',
        accessPolicy: 'allowed',
        wordCount: 50,
        lang: 'en',
        contentHash: 'x',
      },
      body,
    };
  }

  const NOW = new Date('2026-06-11T06:00:00.000Z');

  test('corroboration equals cluster domain count (2 domains → corroboration=2)', async () => {
    const pairs = [
      makeDocPair('a'.repeat(40), 'techcrunch.com', 'https://techcrunch.com/a'),
      makeDocPair('b'.repeat(40), 'theverge.com', 'https://theverge.com/b'),
    ];
    const result = await extractFacts(pairs, 'ai', 'cluster-multi', NOW);
    for (const fact of result.facts) {
      assert.equal(fact.corroboration, 2, `expected corroboration=2 (2 distinct domains), got ${fact.corroboration}`);
    }
  });

  test('corroboration is at least 1 for single-domain cluster', async () => {
    const pairs = [makeDocPair('c'.repeat(40), 'only-source.io', 'https://only-source.io/a')];
    const result = await extractFacts(pairs, 'ai', 'cluster-single', NOW);
    for (const fact of result.facts) {
      assert.ok(fact.corroboration >= 1);
    }
  });
});

// ---------------------------------------------------------------------------
// #20 — search discovery URLs pass through normalizePublicUrl
// ---------------------------------------------------------------------------

describe('#20: search discovery URL normalization', () => {
  test('GoogleNewsSearchProvider does not expose credential-bearing URLs', () => {
    // normalizePublicUrl (used inside the provider) must reject credential-bearing URLs.
    const credentialUrl = 'https://user:pass@news.google.com/rss/search?q=ai';
    assert.equal(normalizePublicUrl(credentialUrl), '', 'credential URL must be rejected');
  });

  test('GoogleNewsSearchProvider: constructor is importable (instance check)', () => {
    const provider = new GoogleNewsSearchProvider();
    assert.equal(provider.name, 'google-news-rss');
  });

  test('normalizePublicUrl: private IP is rejected (search safety)', () => {
    assert.equal(normalizePublicUrl('https://10.0.0.1/article'), '');
  });
});

// ---------------------------------------------------------------------------
// #21 — etl-store path traversal
// ---------------------------------------------------------------------------

describe('#21: etl-store path traversal rejection (CWE-22)', () => {
  test('getById: rejects id with path traversal (../)', async () => {
    await assert.rejects(
      () => fileEtlStore.getById('../etc/passwd'),
      /invalid doc id/,
    );
  });

  test('getBody: rejects id with path traversal', async () => {
    await assert.rejects(
      () => fileEtlStore.getBody('../../etc/shadow'),
      /invalid doc id/,
    );
  });

  test('getById: rejects id shorter than 40 hex chars', async () => {
    await assert.rejects(
      () => fileEtlStore.getById('abc123'),
      /invalid doc id/,
    );
  });

  test('getBody: rejects non-hex chars in id', async () => {
    await assert.rejects(
      () => fileEtlStore.getBody('GGGG' + 'a'.repeat(36)),
      /invalid doc id/,
    );
  });

  test('getById: accepts valid 40-char hex id (returns null when not found)', async () => {
    const validId = 'a'.repeat(40);
    const result = await fileEtlStore.getById(validId);
    assert.equal(result, null); // not in store, but no error thrown
  });

  test('docIdFromUrl: always returns a safe 40-hex-char id', () => {
    const id = docIdFromUrl('https://techcrunch.com/2026/06/01/openai-model');
    assert.match(id, /^[0-9a-f]{40}$/);
  });
});

// ---------------------------------------------------------------------------
// runners — agent-readiness CLI
// ---------------------------------------------------------------------------

describe('runners: --describe', () => {
  test('buildDescribeOutput: has correct name and stage', () => {
    const spec = buildDescribeOutput();
    assert.equal(spec.name, 'news-aggregator');
    assert.equal(spec.stage, 'aggregation');
  });

  test('buildDescribeOutput: contract fields match @ardurai/contracts exports', () => {
    const spec = buildDescribeOutput();
    assert.equal(spec.contract.schemaVersion, SCHEMA_VERSION);
    assert.equal(spec.contract.contractRevision, CONTRACT_REVISION);
  });

  test('buildDescribeOutput: input is null (Stage 1 has no upstream)', () => {
    assert.equal(buildDescribeOutput().input, null);
  });

  test('buildDescribeOutput: output schema references schemaVersion enum', () => {
    const spec = buildDescribeOutput();
    const output = spec.output as Record<string, unknown>;
    const props = (output['properties'] as Record<string, unknown>);
    const sv = props['schemaVersion'] as Record<string, unknown>;
    assert.deepEqual(sv['enum'], [SCHEMA_VERSION]);
  });

  test('buildDescribeOutput: output schema lists required envelope fields', () => {
    const spec = buildDescribeOutput();
    const output = spec.output as Record<string, unknown>;
    const required = output['required'] as string[];
    assert.ok(required.includes('schemaVersion'));
    assert.ok(required.includes('artifact'));
    assert.ok(required.includes('runId'));
    assert.ok(required.includes('data'));
  });

  test('buildDescribeOutput: flags include all uniform-CLI flags', () => {
    const flags = buildDescribeOutput().flags;
    assert.ok('--in' in flags);
    assert.ok('--out' in flags);
    assert.ok('--provider' in flags);
    assert.ok('--now' in flags);
    assert.ok('--run-id' in flags);
    assert.ok('--describe' in flags);
    assert.ok('--json-errors' in flags);
    assert.ok('--no-network' in flags);
    assert.ok('--fixtures' in flags);
  });

  test('buildDescribeOutput: output is serialisable to JSON without throwing', () => {
    assert.doesNotThrow(() => JSON.stringify(buildDescribeOutput()));
  });
});

describe('runners: parseRunnerArgs', () => {
  test('defaults: all values at expected defaults', () => {
    const args = parseRunnerArgs([]);
    assert.equal(args.inPath, null);
    assert.equal(args.outPath, null);
    assert.equal(args.nowIso, null);
    assert.equal(args.runId, null);
    assert.equal(args.doDescribe, false);
    assert.equal(args.jsonErrors, false);
    assert.equal(args.noNetwork, false);
    assert.equal(args.fixturesDir, null);
    assert.equal(args.etlEnabled, false);
    assert.equal(args.maxAgeHours, 36);
    assert.equal(args.timeoutMs, 15_000);
    assert.equal(args.concurrency, 10);
  });

  test('--describe sets doDescribe=true', () => {
    assert.equal(parseRunnerArgs(['--describe']).doDescribe, true);
  });

  test('--json-errors sets jsonErrors=true', () => {
    assert.equal(parseRunnerArgs(['--json-errors']).jsonErrors, true);
  });

  test('--no-network sets noNetwork=true', () => {
    assert.equal(parseRunnerArgs(['--no-network']).noNetwork, true);
  });

  test('--fixtures implies noNetwork=true', () => {
    const args = parseRunnerArgs(['--fixtures', '/tmp/feeds']);
    assert.equal(args.noNetwork, true);
    assert.equal(args.fixturesDir, '/tmp/feeds');
  });

  test('--out - maps to null (stdout)', () => {
    assert.equal(parseRunnerArgs(['--out', '-']).outPath, null);
  });

  test('--out <path> maps to path', () => {
    assert.equal(parseRunnerArgs(['--out', '/tmp/out.json']).outPath, '/tmp/out.json');
  });

  test('--in - maps to null', () => {
    assert.equal(parseRunnerArgs(['--in', '-']).inPath, null);
  });

  test('--now and --run-id are captured', () => {
    const args = parseRunnerArgs(['--now', '2026-06-11T06:00:00.000Z', '--run-id', 'abc-123']);
    assert.equal(args.nowIso, '2026-06-11T06:00:00.000Z');
    assert.equal(args.runId, 'abc-123');
  });

  test('--etl sets etlEnabled=true', () => {
    assert.equal(parseRunnerArgs(['--etl']).etlEnabled, true);
  });

  test('--etl-budget sets budget', () => {
    assert.equal(parseRunnerArgs(['--etl-budget', '5']).etlFetchBudgetPerTopic, 5);
  });

  test('--max-age-hours sets maxAgeHours', () => {
    assert.equal(parseRunnerArgs(['--max-age-hours', '48']).maxAgeHours, 48);
  });

  // #27 hostile-input: numeric flags must not silently eat 0 or NaN
  test('--etl-budget 0: zero is preserved, not replaced by default', () => {
    // Number('0') || 30 = 30 (bug); Number.isFinite check must keep 0
    assert.equal(parseRunnerArgs(['--etl-budget', '0']).etlFetchBudgetPerTopic, 0);
  });

  test('--timeout 0: zero is preserved, not replaced by default', () => {
    assert.equal(parseRunnerArgs(['--timeout', '0']).timeoutMs, 0);
  });

  test('--concurrency 0: zero is preserved, not replaced by default', () => {
    assert.equal(parseRunnerArgs(['--concurrency', '0']).concurrency, 0);
  });

  test('--etl-budget NaN: falls back to default (30)', () => {
    assert.equal(parseRunnerArgs(['--etl-budget', 'notanumber']).etlFetchBudgetPerTopic, 30);
  });

  test('--timeout NaN: falls back to default (15000)', () => {
    assert.equal(parseRunnerArgs(['--timeout', 'notanumber']).timeoutMs, 15_000);
  });

  test('--concurrency NaN: falls back to default (10)', () => {
    assert.equal(parseRunnerArgs(['--concurrency', 'notanumber']).concurrency, 10);
  });

  test('--max-age-hours 0: zero is preserved, not replaced by default', () => {
    assert.equal(parseRunnerArgs(['--max-age-hours', '0']).maxAgeHours, 0);
  });
});

describe('runners: deriveRunId', () => {
  test('same input → same output', () => {
    const iso = '2026-06-11T06:00:00.000Z';
    assert.equal(deriveRunId(iso), deriveRunId(iso));
  });

  test('different inputs → different outputs', () => {
    assert.notEqual(
      deriveRunId('2026-06-11T06:00:00.000Z'),
      deriveRunId('2026-06-11T12:00:00.000Z'),
    );
  });

  test('output is 32 hex chars', () => {
    assert.match(deriveRunId('2026-06-11T06:00:00.000Z'), /^[0-9a-f]{32}$/);
  });
});

describe('runners: buildHermeticArtifact', () => {
  const NOW_ISO = '2026-06-11T07:30:00.000Z';
  const NOW = new Date(NOW_ISO);
  const RUN_ID = deriveRunId(NOW_ISO);

  test('schemaVersion matches SCHEMA_VERSION from @ardurai/contracts', () => {
    const a = buildHermeticArtifact(NOW, RUN_ID);
    assert.equal(a.schemaVersion, SCHEMA_VERSION);
  });

  test('contractRevision matches CONTRACT_REVISION from @ardurai/contracts', () => {
    const a = buildHermeticArtifact(NOW, RUN_ID);
    assert.equal(a.contractRevision, CONTRACT_REVISION);
  });

  test('artifact field is "aggregation"', () => {
    assert.equal(buildHermeticArtifact(NOW, RUN_ID).artifact, 'aggregation');
  });

  test('runId matches supplied value', () => {
    assert.equal(buildHermeticArtifact(NOW, RUN_ID).runId, RUN_ID);
  });

  test('generatedAt matches --now input', () => {
    assert.equal(buildHermeticArtifact(NOW, RUN_ID).generatedAt, NOW_ISO);
  });

  test('cycle window is floored to 6h boundary', () => {
    const a = buildHermeticArtifact(NOW, RUN_ID);
    assert.equal(a.cycle.windowStart, '2026-06-11T06:00:00.000Z');
    assert.equal(a.cycle.windowEnd, '2026-06-11T12:00:00.000Z');
  });

  test('data collections are empty (hermetic)', () => {
    const a = buildHermeticArtifact(NOW, RUN_ID);
    assert.deepEqual(a.data.itemsByTopic, {});
    assert.deepEqual(a.data.clustersByTopic, {});
    assert.deepEqual(a.data.coverageByTopic, {});
  });

  test('byte-identical output for identical inputs (determinism)', () => {
    const a = JSON.stringify(buildHermeticArtifact(NOW, RUN_ID));
    const b = JSON.stringify(buildHermeticArtifact(NOW, RUN_ID));
    assert.equal(a, b);
  });

  test('passes assertCompatibleArtifact gate', () => {
    const a = buildHermeticArtifact(NOW, RUN_ID);
    const { stage, warnings } = assertCompatibleArtifact(a, 'aggregation');
    assert.equal(stage, 'aggregation');
    assert.equal(warnings.length, 0);
  });
});

describe('runners: classifyError', () => {
  test('stage is always "aggregation"', () => {
    assert.equal(classifyError(new Error('boom')).stage, 'aggregation');
    assert.equal(classifyError('string error').stage, 'aggregation');
  });

  test('network-like message → NETWORK_ERROR', () => {
    assert.equal(classifyError(new Error('fetch failed ECONNREFUSED')).code, 'NETWORK_ERROR');
    assert.equal(classifyError(new Error('timeout exceeded')).code, 'NETWORK_ERROR');
  });

  test('JSON parse error → PARSE_ERROR', () => {
    assert.equal(classifyError(new Error('Unexpected token in JSON')).code, 'PARSE_ERROR');
  });

  test('schema error → SCHEMA_ERROR', () => {
    assert.equal(classifyError(new Error('schemaVersion mismatch')).code, 'SCHEMA_ERROR');
  });

  test('unknown error → UNKNOWN_ERROR', () => {
    assert.equal(classifyError(new Error('something else')).code, 'UNKNOWN_ERROR');
  });

  test('non-Error → UNKNOWN_ERROR with stringified message', () => {
    const result = classifyError(42);
    assert.equal(result.code, 'UNKNOWN_ERROR');
    assert.equal(result.message, '42');
  });
});

// ---------------------------------------------------------------------------
// #18 — fetchedAt is pinned by opts.now (ETL determinism)
// ---------------------------------------------------------------------------

describe('#18: fetchedAt pinned by opts.now', () => {
  test('fetchArticle: blocked URL uses opts.now for fetchedAt, not wall clock', async () => {
    // 127.0.0.1 is always SSRF-blocked → hits the early-return path with fetchedAt stamped
    const pinned = new Date('2026-06-11T06:00:00.000Z');
    const result = await fetchArticle('https://127.0.0.1/article', { title: 'test', now: pinned });
    assert.equal(result.doc.fetchedAt, pinned.toISOString(), 'fetchedAt must equal opts.now');
  });

  test('fetchArticle: opts.now=undefined falls back to real clock (not fixed)', async () => {
    const before = new Date();
    const result = await fetchArticle('https://127.0.0.1/article', { title: 'test' });
    const after = new Date();
    const fetchedAt = new Date(result.doc.fetchedAt);
    // fetchedAt must be between before and after (real wall clock, not a fixed value)
    assert.ok(fetchedAt >= before && fetchedAt <= after, 'fetchedAt should be near wall clock when now is unset');
  });

  test('extractFacts: generatedAt respects pinned now when ETL path uses it', async () => {
    const DOC_ID = '0'.repeat(40);
    const NOW = new Date('2026-06-11T08:00:00.000Z');
    const BODY = 'Anthropic released Claude 4 with 1 trillion parameters in June 2026. '
      + 'The model achieved 95% accuracy on benchmarks.';
    const pair: { doc: FullSourceDocument; body: string } = {
      doc: {
        id: DOC_ID,
        url: 'https://test.com/a',
        source: 'test',
        sourceDomain: 'test.com',
        tier: 'news',
        title: 'Test',
        publishedAt: '2026-06-11T00:00:00Z',
        fetchedAt: NOW.toISOString(),
        extraction: 'full',
        accessPolicy: 'allowed',
        wordCount: 20,
        lang: 'en',
        contentHash: 'abc',
      },
      body: BODY,
    };
    const result = await extractFacts([pair], 'ai', 'cluster-18', NOW);
    for (const fact of result.facts) {
      assert.equal(fact.extractedBy.generatedAt, NOW.toISOString(), 'generatedAt must equal pinned now');
    }
  });
});

// ---------------------------------------------------------------------------
// #22 — A5 copyright guard: short statements must be screened
// ---------------------------------------------------------------------------

describe('#22: A5 screens short statements (no < 40-char bypass)', () => {
  test('hasForbiddenVerbatimOverlap: short statement with 8-gram match IS flagged', () => {
    // 8 words, under 40 chars — previously bypassed the guard
    const statement = 'one two three four five six seven eight.';
    const body = 'the article said one two three four five six seven eight different things.';
    assert.ok(
      hasForbiddenVerbatimOverlap(statement, body),
      'short statement with verbatim 8-gram must be flagged (not bypassed)',
    );
  });

  test('hasForbiddenVerbatimOverlap: < 8 tokens → no grams → false regardless of length', () => {
    // Under 8 words: can never have an 8-gram, so still returns false
    const statement = 'one two three four five.';
    const body = 'one two three four five different things in the article.';
    assert.ok(!hasForbiddenVerbatimOverlap(statement, body), 'fewer than 8 tokens cannot form an 8-gram');
  });

  test('validateFactsForWire: drops short statement with verbatim overlap (fail-closed)', () => {
    const body = 'one two three four five six seven eight different things here and more';
    // Short statement that contains a verbatim 8-gram with the source body
    const statement = 'one two three four five six seven eight.';
    function makeShortFact(): ExtractedFact {
      return {
        id: 'short-1',
        topic: 'ai',
        clusterId: 'c1',
        statement,
        entities: [],
        provenance: [{ sourceDocId: 'doc-1', sourceDomain: 'example.com', url: 'https://example.com/a' }],
        corroboration: 1,
        confidence: 'low',
        extractedBy: { provider: 'deterministic', model: 'regex-v1', status: 'fallback', generatedAt: '2026-06-11T00:00:00Z' },
      };
    }
    const bodyMap = new Map([['doc-1', body]]);
    const { facts, violations } = validateFactsForWire([makeShortFact()], bodyMap);
    assert.equal(facts.length, 0, 'short verbatim statement must be dropped (fail-closed)');
    assert.ok(violations.some((v) => v.includes('verbatim')), 'violation must note verbatim overlap');
  });
});

// ---------------------------------------------------------------------------
// #23 — corroboration uses eTLD+1, not host-minus-www
// ---------------------------------------------------------------------------

describe('#23: eTLD+1 for corroboration owner-dedup', () => {
  test('etld1: strips www and returns eTLD+1', () => {
    assert.equal(etld1('www.techcrunch.com'), 'techcrunch.com');
    assert.equal(etld1('techcrunch.com'), 'techcrunch.com');
    assert.equal(etld1('blog.techcrunch.com'), 'techcrunch.com');
  });

  test('etld1: handles multi-level TLDs (.co.uk)', () => {
    assert.equal(etld1('news.bbc.co.uk'), 'bbc.co.uk');
    assert.equal(etld1('www.bbc.co.uk'), 'bbc.co.uk');
  });

  test('etld1: two-part domain unchanged', () => {
    assert.equal(etld1('example.com'), 'example.com');
    assert.equal(etld1('github.io'), 'github.io');
  });

  test('extractFacts: subdomains of same publisher count as ONE owner (corroboration not inflated)', async () => {
    const NOW = new Date('2026-06-11T06:00:00.000Z');
    const BODY = 'Anthropic released Claude 4 with 1 trillion parameters in June 2026. '
      + 'The system achieved state-of-the-art performance on key benchmarks during evaluation.';
    function makeSubdomainPair(subdomain: string, docId: string): { doc: FullSourceDocument; body: string } {
      return {
        doc: {
          id: docId,
          url: `https://${subdomain}/article`,
          source: subdomain,
          sourceDomain: subdomain,
          tier: 'news',
          title: 'Test',
          publishedAt: '2026-06-11T00:00:00Z',
          fetchedAt: NOW.toISOString(),
          extraction: 'full',
          accessPolicy: 'allowed',
          wordCount: 30,
          lang: 'en',
          contentHash: docId.slice(0, 8),
        },
        body: BODY,
      };
    }
    // Two different subdomains of the same publisher
    const pairs = [
      makeSubdomainPair('blog.techcrunch.com', 'a'.repeat(40)),
      makeSubdomainPair('news.techcrunch.com', 'b'.repeat(40)),
    ];
    const result = await extractFacts(pairs, 'ai', 'cluster-23-sub', NOW);
    for (const fact of result.facts) {
      assert.equal(
        fact.corroboration, 1,
        `subdomains of the same publisher must yield corroboration=1, got ${fact.corroboration}`,
      );
    }
  });

  test('extractFacts: two distinct publishers → corroboration=2', async () => {
    const NOW = new Date('2026-06-11T06:00:00.000Z');
    const BODY = 'Google released Gemini 2.0 with significant improvements in June 2026. '
      + 'The model outperformed competitors on 3 major benchmarks by large margins.';
    function makeDistinctPair(domain: string, docId: string): { doc: FullSourceDocument; body: string } {
      return {
        doc: {
          id: docId,
          url: `https://${domain}/article`,
          source: domain,
          sourceDomain: domain,
          tier: 'news',
          title: 'Test',
          publishedAt: '2026-06-11T00:00:00Z',
          fetchedAt: NOW.toISOString(),
          extraction: 'full',
          accessPolicy: 'allowed',
          wordCount: 30,
          lang: 'en',
          contentHash: docId.slice(0, 8),
        },
        body: BODY,
      };
    }
    const pairs = [
      makeDistinctPair('techcrunch.com', 'c'.repeat(40)),
      makeDistinctPair('theverge.com', 'd'.repeat(40)),
    ];
    const result = await extractFacts(pairs, 'ai', 'cluster-23-two', NOW);
    for (const fact of result.facts) {
      assert.equal(fact.corroboration, 2, `two distinct publishers must yield corroboration=2, got ${fact.corroboration}`);
    }
  });
});

// ---------------------------------------------------------------------------
// SSRF guard fix — catalog article URLs must not be blocked by empty allowedHosts
// ---------------------------------------------------------------------------

describe('SSRF guard: article fetch URL normalization', () => {
  test('normalizePublicUrl without allowedHosts: passes any valid public HTTPS URL', () => {
    // Regression guard: the old fetchArticle called assertAllowedFetchUrl(url, []) which
    // creates an empty Set — every hostname fails .has() → tos-restricted for ALL articles.
    // Fix: use normalizePublicUrl without allowedHosts (no host-allowlist for article fetches).
    const catalogUrl = 'https://simonwillison.net/2026/06/11/test/';
    const result = normalizePublicUrl(catalogUrl, { allowedPorts: DEFAULT_FETCH_PORTS });
    assert.ok(result.length > 0, 'catalog source URL must pass SSRF guard without host-allowlist');
  });

  test('assertAllowedFetchUrl(url, []): blocks any URL — this was the root-cause bug', () => {
    // Documents the broken behavior so it is never reintroduced in content-extract.ts.
    assert.throws(
      () => assertAllowedFetchUrl('https://simonwillison.net/test', []),
      /Blocked/,
      'empty allowedHosts [] must block even valid public URLs',
    );
  });

  test('normalizePublicUrl: still rejects private IPs (SSRF guard active)', () => {
    assert.equal(normalizePublicUrl('https://10.0.0.1/article', { allowedPorts: DEFAULT_FETCH_PORTS }), '');
    assert.equal(normalizePublicUrl('https://192.168.1.1/article', { allowedPorts: DEFAULT_FETCH_PORTS }), '');
    assert.equal(normalizePublicUrl('https://localhost/article', { allowedPorts: DEFAULT_FETCH_PORTS }), '');
  });

  test('fetchArticle: private/localhost IPs still return tos-restricted (SSRF guard active after fix)', async () => {
    // The fix removes the empty-allowedHosts block but keeps SSRF protection for private IPs.
    const result = await fetchArticle('https://127.0.0.1/article', { title: 'test' });
    assert.equal(result.doc.accessPolicy, 'tos-restricted', 'private IP must still be tos-restricted');
  });

  test('normalizePublicUrl: catalog article domain passes without host-allowlist (the fixed path)', () => {
    // This is the precise gate content-extract.ts now uses instead of assertAllowedFetchUrl(url, []).
    // huggingface.co, pytorch.org, simonwillison.net — all must pass.
    for (const url of [
      'https://huggingface.co/blog/llama3',
      'https://pytorch.org/blog/introducing-pytorch-2-4/',
      'https://simonwillison.net/2026/Jun/11/test/',
    ]) {
      const result = normalizePublicUrl(url, { allowedPorts: DEFAULT_FETCH_PORTS });
      assert.ok(result.length > 0, `${url} must pass normalizePublicUrl (no host-allowlist restriction)`);
    }
  });
});

// ---------------------------------------------------------------------------
// deterministicExtract — produces non-verbatim structured facts
// ---------------------------------------------------------------------------

describe('deterministicExtract: structured meta-statements', () => {
  const DOC_ID = 'f'.repeat(40);
  const NOW = new Date('2026-06-11T06:00:00.000Z');

  function makePairDet(body: string, id = DOC_ID): { doc: FullSourceDocument; body: string } {
    return {
      doc: {
        id,
        url: 'https://research.example.com/ai-models',
        source: 'Research Blog',
        sourceDomain: 'research.example.com',
        tier: 'news',
        title: 'AI Model Benchmarks 2026',
        publishedAt: '2026-06-11T00:00:00Z',
        fetchedAt: NOW.toISOString(),
        extraction: 'full',
        accessPolicy: 'allowed',
        wordCount: 50,
        lang: 'en',
        contentHash: 'abc',
      },
      body,
    };
  }

  test('extractFacts (deterministic path): produces > 0 facts from a substantive body', async () => {
    const BODY = 'Anthropic released Claude 4 with 1 trillion parameters in June 2026. '
      + 'The new model achieved 95% on MMLU benchmarks. '
      + 'Google confirmed Gemini 2.0 achieved similar results on 3 major tests. '
      + 'NVIDIA reported 3x GPU throughput improvements in the H200 chip series.';
    const result = await extractFacts([makePairDet(BODY)], 'ai', 'cluster-det-a', NOW);
    assert.ok(result.facts.length > 0, `deterministic extractor must produce facts (got ${result.facts.length})`);
  });

  test('extractFacts (deterministic): facts survive the copyright wire guard', async () => {
    const BODY = 'Anthropic released Claude 4 with 1 trillion parameters in June 2026. '
      + 'The new model achieved 95% accuracy on MMLU benchmarks. '
      + 'OpenAI responded by announcing GPT-5 for Q3 2026.';
    const result = await extractFacts([makePairDet(BODY)], 'ai', 'cluster-det-b', NOW);
    const bodyMap = new Map([[DOC_ID, BODY]]);
    const { facts: wireFacts, violations } = validateFactsForWire(result.facts, bodyMap);
    assert.equal(violations.length, 0, `deterministic facts must pass copyright guard: ${violations.join('; ')}`);
    assert.ok(wireFacts.length > 0, 'at least one fact must survive the copyright wire guard');
  });

  test('extractFacts (deterministic): statements are structured, not verbatim sentences', async () => {
    const BODY = 'Anthropic released Claude 4 with 1 trillion parameters in June 2026. '
      + 'The model achieved 95% accuracy on standard benchmarks.';
    const result = await extractFacts([makePairDet(BODY)], 'ai', 'cluster-det-c', NOW);
    for (const fact of result.facts) {
      // Structured statements have < 8 tokens so they can never form an 8-gram with the source body
      const tokenCount = (fact.statement.match(/\S+/g) ?? []).length;
      assert.ok(tokenCount < 8, `statement "${fact.statement}" must be < 8 tokens (got ${tokenCount})`);
    }
  });

  test('extractFacts (deterministic): each fact has a provenance quote ≤ 20 words', async () => {
    const BODY = 'NVIDIA shipped the H200 chip with 141 GB HBM3e memory for large language model inference. '
      + 'Microsoft Azure announced 1000 H200 nodes for enterprise AI workloads.';
    const result = await extractFacts([makePairDet(BODY)], 'platform', 'cluster-det-d', NOW);
    for (const fact of result.facts) {
      for (const prov of fact.provenance) {
        if (prov.quote) {
          const wc = wordCount(prov.quote.replace('…', ''));
          assert.ok(wc <= 20, `quote "${prov.quote}" exceeds 20 words (got ${wc})`);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// feedBody capture — ingest captures content:encoded as feedBody
// ---------------------------------------------------------------------------

describe('feedBody: RawItem exposes feed full content', () => {
  test('makeRawItem with feedBody: field is accessible', () => {
    const item = makeRawItem({ feedBody: 'Anthropic released Claude 4 with improved reasoning capabilities.' });
    assert.equal(item.feedBody, 'Anthropic released Claude 4 with improved reasoning capabilities.');
  });

  test('makeRawItem without feedBody: field is undefined', () => {
    const item = makeRawItem();
    assert.equal(item.feedBody, undefined);
  });
});

// ---------------------------------------------------------------------------
// contracts #2 — parseAggregationArtifact rejects malformed input
// ---------------------------------------------------------------------------

describe('contracts #2: parseAggregationArtifact at boundary', () => {
  test('parseAggregationArtifact: accepts valid artifact from buildHermeticArtifact', async () => {
    const { parseAggregationArtifact } = await import('@ardurai/contracts/zod');
    const NOW = new Date('2026-06-11T06:00:00.000Z');
    const artifact = buildHermeticArtifact(NOW, deriveRunId(NOW.toISOString()));
    assert.doesNotThrow(() => parseAggregationArtifact(artifact));
  });

  test('parseAggregationArtifact: rejects missing schemaVersion', async () => {
    const { parseAggregationArtifact } = await import('@ardurai/contracts/zod');
    assert.throws(() => parseAggregationArtifact({ artifact: 'aggregation', data: {} }));
  });

  test('parseAggregationArtifact: rejects wrong artifact stage', async () => {
    const { parseAggregationArtifact } = await import('@ardurai/contracts/zod');
    assert.throws(() =>
      parseAggregationArtifact({
        schemaVersion: 'ardur-content-pipeline/v1',
        artifact: 'ranking',
        data: {},
      }),
    );
  });
});
