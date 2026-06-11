/**
 * Source registry — loads the curated Source Catalog (data/sources.json, 155 sources)
 * and appends Google News RSS meta-feed entries for topic-query coverage.
 *
 * Tech-only scope: AI/ML, developer tools, cloud-native, security.
 * See ARCHITECTURE.md §10 for tier taxonomy and product rules.
 */

import { loadCatalogSources } from './catalog.ts';
import type { SourceDefinition, TopicDefinition, FetchStrategy } from './source-types.ts';
import type { TopicMeta } from './contracts.ts';

// Re-export types for backwards compat (ingest.ts, index.ts import from here)
export type { FetchStrategy, SourceDefinition, TopicDefinition };

// ---------------------------------------------------------------------------
// Topic definitions
// ---------------------------------------------------------------------------

const TOPICS: TopicDefinition[] = [
  {
    id: 'all',
    label: 'All Signals',
    description: 'AI, models, DevOps, platform engineering, Kubernetes, and security signals.',
    query: '',
    terms: [],
    diversityFloor: 20,
  },
  {
    id: 'ai',
    label: 'AI + LLMs',
    description: 'Frontier AI, LLMs, agents, tooling, and applied AI product moves.',
    query: '("AI agents" OR LLM OR "frontier AI" OR "generative AI" OR OpenAI OR Anthropic OR "AI model") when:1d',
    terms: ['ai', 'llm', 'agent', 'model', 'openai', 'anthropic', 'google', 'mistral'],
    diversityFloor: 20,
  },
  {
    id: 'models',
    label: 'Model Comparisons',
    description: 'New model releases, benchmark debates, inference changes, and evaluation signals.',
    query: '("LLM benchmark" OR "model comparison" OR "open model" OR "AI inference" OR "frontier model") when:7d',
    terms: ['model', 'benchmark', 'eval', 'inference', 'open model', 'llm'],
    diversityFloor: 20,
  },
  {
    id: 'platform',
    label: 'Platform Engineering',
    description: 'Internal developer platforms, SRE, CI/CD, GitOps, and production engineering.',
    query: '("platform engineering" OR "internal developer platform" OR GitOps OR "DevOps platform" OR "Kubernetes platform") when:7d',
    terms: ['platform', 'devops', 'sre', 'gitops', 'ci/cd', 'developer'],
    diversityFloor: 20,
  },
  {
    id: 'kubernetes',
    label: 'Kubernetes + Cloud Native',
    description: 'Kubernetes, CNCF, containers, service mesh, and cloud-native operations.',
    query: '(Kubernetes OR K8s OR CNCF OR "cloud native" OR "service mesh" OR containers) when:7d',
    terms: ['kubernetes', 'k8s', 'cncf', 'container', 'mesh', 'helm'],
    diversityFloor: 20,
  },
  {
    id: 'security',
    label: 'AI + Cloud Security',
    description: 'AI security, software supply chain, cloud posture, identity, and runtime defense.',
    query: '("AI security" OR "cloud security" OR "software supply chain security" OR "Kubernetes security" OR "identity security") when:7d',
    terms: ['security', 'cyber', 'supply chain', 'iam', 'cloud', 'vulnerability'],
    diversityFloor: 20,
  },
];

// ---------------------------------------------------------------------------
// Google News RSS meta-feed entries (one per non-'all' topic)
// These complement direct RSS feeds with live query-matched coverage.
// ---------------------------------------------------------------------------

const GOOGLE_NEWS_SOURCES: SourceDefinition[] = TOPICS.filter((t) => t.id !== 'all').map(
  (t): SourceDefinition => ({
    domain: 'news.google.com',
    label: `Google News (${t.label})`,
    tier: t.id === 'security' ? 'security-news' : 'news',
    topics: [t.id],
    strategy: { kind: 'google-news-rss' },
    credibilityHint: 0.65,
  }),
);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Merged at call time so catalog changes are reflected without module reload.
export function loadSources(): SourceDefinition[] {
  return [...loadCatalogSources(), ...GOOGLE_NEWS_SOURCES];
}

export function loadTopics(): TopicDefinition[] {
  return TOPICS;
}

export function sourcesForTopic(topicId: string): SourceDefinition[] {
  if (topicId === 'all') return [];
  return loadSources().filter((s) => s.topics.includes(topicId));
}

// Satisfy the TopicMeta re-export used downstream
export type { TopicMeta };
