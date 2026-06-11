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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
const CATEGORY_TOPICS = {
    'AI/ML': ['ai', 'models'],
    'Platform Engineering': ['platform'],
    'Kubernetes/Cloud-Native': ['kubernetes'],
    DevOps: ['platform', 'kubernetes'],
    'Security/Vulnerabilities': ['security'],
    'Software Engineering': ['platform'],
};
function mapTier(catalogTier, sourceType, category) {
    if (sourceType === 'preprint')
        return 'paper';
    if (catalogTier === 1)
        return 'primary';
    if (catalogTier === 2) {
        if (category === 'Security/Vulnerabilities')
            return 'security-news';
        if (sourceType === 'press')
            return 'news';
        return 'technical-news';
    }
    // tier 3
    if (category === 'Security/Vulnerabilities')
        return 'security-news';
    return 'news';
}
function credibilityFor(catalogTier) {
    if (catalogTier === 1)
        return 0.9;
    if (catalogTier === 2)
        return 0.75;
    return 0.65;
}
export function loadCatalogSources() {
    const dir = dirname(fileURLToPath(import.meta.url));
    const catalogPath = join(dir, '..', 'data', 'sources.json');
    const raw = JSON.parse(readFileSync(catalogPath, 'utf-8'));
    const results = [];
    for (const e of raw) {
        // Skip unverified entries and non-RSS/Atom feeds (JSON APIs need custom parsers)
        if (e.verified === false)
            continue;
        if (!e.feedUrl.startsWith('https://'))
            continue;
        if (e.type === 'JSON')
            continue; // REST APIs; tracked for a future JSON-ingest wave
        const topics = CATEGORY_TOPICS[e.category] ?? ['platform'];
        const tier = mapTier(e.tier, e.sourceType, e.category);
        let domain;
        try {
            domain = new URL(e.feedUrl).hostname.replace(/^www\./, '');
        }
        catch {
            domain = e.feedUrl.slice(0, 80);
        }
        const strategy = { kind: 'rss', feedUrl: e.feedUrl };
        results.push({
            domain,
            label: e.name,
            tier,
            topics,
            strategy,
            credibilityHint: credibilityFor(e.tier),
        });
    }
    return results;
}
