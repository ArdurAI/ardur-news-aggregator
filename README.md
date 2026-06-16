# ardur-news-aggregator

> **Stage 1 of the [Ardur AI content pipeline](./ARCHITECTURE.md).** Global
> multi-source ingestion, dedup, clustering, and aggregate interaction-metric
> capture. Produces an `AggregationArtifact` consumed by
> [`ardur-ranking-engine`](https://github.com/ArdurAI/ardur-ranking-engine).

This repository is a **design specification + minimal scaffold**. Interfaces and
wiring are final; engine logic is intentionally unimplemented (every module
throws `not implemented`). See [`docs/spec.md`](./docs/spec.md) for the full
design and [`ARCHITECTURE.md`](./ARCHITECTURE.md) for how the four engines wire
together.

## What it does

For each topic, every 6-hour cycle:

1. **Ingest** ≥ 20–30 curated global sources (primary vendor/standards feeds,
   news + financial press, technical/security press, arXiv, and the Google News
   RSS meta-feed) over an **SSRF-safe** fetch path.
2. **Dedup** exact repeats while *keeping* the same story from different sources
   (corroboration is signal, not noise).
3. **Cluster** items that cover the same story using token-overlap similarity
   with an entity boost (threshold ≈ 0.82).
4. **Capture** aggregate-only interaction metrics (feed position, cross-source
   mentions, velocity) — **never** any PII.

## Pipeline position

```mermaid
flowchart LR
  SRC[20–30 sources / topic] --> A[ardur-news-aggregator]
  A -->|AggregationArtifact| R[ardur-ranking-engine]
  R --> T[ardur-top10-engine]
  T --> S[ardur-article-synthesizer]
```

## Output contract

`runAggregation()` returns an `AggregationArtifact` — a versioned envelope (see
[`src/contracts.ts`](./src/contracts.ts)) with, per topic:

- `itemsByTopic` — normalized `AggregatedItem[]` (title, source, tier, canonical
  URL, metadata-derived `summaryHint`, interaction metrics, `clusterId`).
- `clustersByTopic` — `Cluster[]` with distinct-source/domain counts and tier
  histogram (the corroboration signal ranking uses).
- `coverageByTopic` — `SourceCoverage` (configured/queried/responded/distinct,
  `degraded` flag when below the diversity floor).

## Project layout

| Path | Role |
|------|------|
| `src/contracts.ts` | Shared pipeline contract (identical across all 4 repos). |
| `src/index.ts` | `runAggregation()` entrypoint + wiring. |
| `src/sources.ts` | Curated tiered source + topic registry (≥ 20/topic). |
| `src/ingest.ts` | Per-source fetch + parse → `RawItem[]`. |
| `src/dedup.ts` | Fingerprinting + duplicate collapse. |
| `src/cluster.ts` | Same-story clustering. |
| `src/interaction.ts` | Aggregate interaction-metric capture + PII screening. |
| `src/source-safety.ts` | SSRF-safe fetch primitives. |
| `src/cli.ts` | Run one cycle, emit JSON. |

## Grounding in the existing system

This engine **extracts and generalizes** working code on
[`ardur.ai`](https://github.com/ArdurAI/ardur.ai) `main`:

- `scripts/refresh-news.mjs` → `ingest.ts` (fetch/parse/score), `dedup.ts`
  (`uniqueByTitle` → fingerprinting).
- `scripts/news-sources.mjs` → `sources.ts` (the allow-list/topics are the
  trusted **core**; expand each topic to ≥ 20–30).
- `scripts/source-safety.mjs` → `source-safety.ts` (port verbatim).
- `scripts/build-news-digests.mjs` clustering (`clusterItems`/`similarity`) →
  `cluster.ts`.

The existing single-meta-feed approach (Google News RSS only) is the **migration
starting point**; the standalone engine broadens to direct publisher feeds to
hit the 20–30-source diversity target. See `docs/spec.md` §"Migration".

## Getting started

```bash
npm install
npm run typecheck
npm test          # contract + wiring smoke tests
npm run build
```

Configuration is environment-driven; copy `.env.example` to `.env`. The default
path is deterministic and zero-cost. Fact extraction can opt into
`ARDUR_AI_PROVIDER=ollama|openai|hermes` when ETL is enabled; `ARDUR_AI_ENABLED=0`
forces deterministic extraction and prevents external provider calls.

Hermes support is explicit-only and below the aggregator boundary: Hermes returns
candidate JSON only, while this repo still creates fact IDs, provenance,
corroboration, shared Zod validation, copyright checks, and deterministic
fallback. CLI usage:

```bash
ARDUR_ETL_ENABLED=true ARDUR_AI_PROVIDER=hermes npm run aggregate -- --provider hermes
npm run aggregate -- --provider hermes --etl --out data/hermes-sample.json
```

Hermes command configuration uses `HERMES_FACT_EXTRACT_COMMAND`,
`HERMES_FACT_EXTRACT_ARGS`, and `HERMES_FACT_EXTRACT_MODEL`; no keys, raw prompts,
or raw completions are written to artifacts.

## Guarantees

- **Copyright-safe** — captures metadata/feed hints and canonical links only;
  never the article body.
- **Privacy** — no PII in URLs or logs; metric keys screened against
  `FORBIDDEN_METRIC_KEY_FRAGMENTS`.
- **Source-safe** — HTTPS-only, allow-listed hosts, blocked private IPs, bounded
  reads.
- **Degrades, never aborts** — a failing source becomes a `warning` + degraded
  coverage, not a failed cycle.

## License

MIT © 2026 ArdurAI
