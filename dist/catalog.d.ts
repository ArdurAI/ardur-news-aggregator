/**
 * Source Catalog loader — reads data/sources.json (155 curated, tiered sources)
 * and maps each entry to a SourceDefinition understood by the aggregator.
 *
 * Catalog schema (data/sources.json):
 *   name, owner, category, tier (1|2|3), sourceType, feedUrl, type (RSS|Atom|JSON),
 *   cadence, compliance, verified, lastChecked
 *
 * Category → topic mapping:
 *   "AI/ML"                   → ['ai', 'models']
 *   "Platform Engineering"    → ['platform']
 *   "Kubernetes/Cloud-Native" → ['kubernetes']
 *   "DevOps"                  → ['platform', 'kubernetes']
 *   "Security/Vulnerabilities"→ ['security']
 *   "Software Engineering"    → ['platform']
 */
import type { SourceDefinition } from './source-types.ts';
export declare function loadCatalogSources(): SourceDefinition[];
