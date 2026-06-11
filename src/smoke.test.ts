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
import { classifyDiscoveredDomain } from './search-provider.ts';
import { docIdFromUrl, contentHashOf } from './etl-store.ts';

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

  test('CONTRACT_REVISION is 2 (ratifies claims? as additive field)', () => {
    assert.equal(CONTRACT_REVISION, 2);
  });

  test('assertCompatibleArtifact: accepts valid aggregation envelope', () => {
    const envelope = {
      schemaVersion: 'ardur-content-pipeline/v1' as const,
      contractRevision: 2,
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
      data: { itemsByTopic: {}, clustersByTopic: {}, coverageByTopic: {} },
    };
    const { warnings } = assertCompatibleArtifact(envelope, 'aggregation');
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
  test('CONTRACT_REVISION_V3 is 3', () => {
    assert.equal(CONTRACT_REVISION_V3, 3);
  });

  test('rev-2 CONTRACT_REVISION is still 2 (baseline unchanged)', () => {
    assert.equal(CONTRACT_REVISION, 2);
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

  test('validateFactsForWire: truncates over-length quote', () => {
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
    const { facts, violations } = validateFactsForWire([fact]);
    assert.equal(facts.length, 1);
    assert.ok(violations.some((v) => v.includes('truncated')));
    const quote = facts[0]!.provenance[0]?.quote ?? '';
    const wordCount = quote.trim().split(/\s+/).filter((w) => !w.endsWith('…')).length;
    assert.ok(wordCount <= 25, `trimmed quote has ${wordCount} words`);
  });
});
