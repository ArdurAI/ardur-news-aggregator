# Ardur AI Content Pipeline — Architecture

> Shared architecture document for the four Ardur content engines. This file is
> mirrored verbatim into each engine repo and should be edited in lockstep.
> Schema version: **`ardur-content-pipeline/v1`**.

## 1. Purpose

Ardur's in-app content is produced by an AI pipeline that, **every 6 hours**, for
each topic:

1. **Aggregates** the topic from **20–30 global sources**.
2. **Ranks** what it found by interaction, credibility, recency, and source diversity.
3. Computes a **Top-10** that refreshes on the 6-hour cadence.
4. **Synthesizes one original article** per Top-10 topic from the clustered sources,
   readable in-app with **no navigation away**.

AI powers both the ranking (signal weighting, corroboration, confidence) and the
writing (original synthesis). The pipeline is a **6-hour batch**, not real-time.

## 2. The four engines

| # | Repo | Responsibility | Consumes | Produces |
|---|------|----------------|----------|----------|
| 1 | [`ardur-news-aggregator`](https://github.com/ArdurAI/ardur-news-aggregator) | Multi-source ingestion (≥20–30/topic), dedup, clustering, interaction-metric capture | source feeds | `AggregationArtifact` |
| 2 | [`ardur-ranking-engine`](https://github.com/ArdurAI/ardur-ranking-engine) | Multi-signal scoring + audit trail | `AggregationArtifact` | `RankingArtifact` |
| 3 | [`ardur-top10-engine`](https://github.com/ArdurAI/ardur-top10-engine) | Top-10 selection + 6h refresh orchestration | `RankingArtifact` | `Top10Artifact` |
| 4 | [`ardur-article-synthesizer`](https://github.com/ArdurAI/ardur-article-synthesizer) | Original copyright-safe article per Top-10 entry | `Top10Artifact` + `AggregationArtifact` | `ArticleArtifact` |

Each engine is **independently developable**: it depends only on the shared
contract (`src/contracts.ts`, identical in all four repos), reads its upstream
artifact as JSON, and writes its own artifact as JSON. No engine imports another
engine's code.

## 3. End-to-end data flow

```mermaid
flowchart LR
  subgraph sources["20–30 sources / topic"]
    direction TB
    P[Primary vendor/standards feeds]
    N[News + financial press]
    T[Technical / security press]
    A[arXiv papers]
    G[Google News RSS meta-feed]
  end

  sources --> AGG

  subgraph AGG["1 · ardur-news-aggregator"]
    I[Ingest + SSRF-safe fetch] --> D[Dedup by fingerprint]
    D --> C[Cluster by similarity]
    C --> M[Capture interaction metrics]
  end

  AGG -->|AggregationArtifact| RANK

  subgraph RANK["2 · ardur-ranking-engine"]
    S[Score: interaction · credibility · recency · diversity · corroboration]
    S --> AU[Emit audit trail]
  end

  RANK -->|RankingArtifact| TOP

  subgraph TOP["3 · ardur-top10-engine"]
    SEL[Select Top-10 / topic + global] --> ST[Compute stability + deltas]
    ST --> SCH[6h refresh orchestration]
  end

  TOP -->|Top10Artifact| SYN
  AGG -.cluster members.-> SYN

  subgraph SYN["4 · ardur-article-synthesizer"]
    PR[Provider: deterministic | ollama | openai]
    PR --> WR[Synthesize 1 original article / entry]
    WR --> CG[Copyright + provenance guards]
  end

  SYN -->|ArticleArtifact| APP[(ardur.ai app · in-app read)]
```

## 4. The 6-hour refresh loop

```mermaid
sequenceDiagram
  autonumber
  participant Cron as Scheduler (cron: 0 */6 * * *)
  participant Agg as Aggregator
  participant Rank as Ranking
  participant Top as Top-10
  participant Syn as Synthesizer
  participant App as ardur.ai

  Cron->>Top: trigger cycle C (windowStart = floor(now, 6h))
  Top->>Agg: run aggregation for cycle C
  Agg-->>Top: AggregationArtifact (runId_a)
  Top->>Rank: run ranking(AggregationArtifact)
  Rank-->>Top: RankingArtifact (upstream = runId_a)
  Top->>Top: select Top-10 + deltas vs cycle C-1
  Top->>Syn: run synthesis(Top10Artifact, AggregationArtifact)
  Syn-->>Top: ArticleArtifact (upstream = top10 runId)
  Top->>App: publish artifacts for cycle C
  Note over App: App reads ArticleArtifact; nextRefreshAt = C + 6h
```

`ardur-top10-engine` owns orchestration. Each stage is **idempotent per
`cycle.id`** so a failed cycle can be safely re-run. The window boundary is
`floor(now, 6h)` in UTC: cycles start at 00:00, 06:00, 12:00, 18:00 UTC.

## 5. Shared contract

The wire format is the `ArtifactEnvelope<T>` defined in
[`src/contracts.ts`](./src/contracts.ts). Every artifact carries:

- `schemaVersion` — `ardur-content-pipeline/v1`; bump on any breaking change.
- `runId` / `upstreamRunId` — trace a single cycle across all four stages.
- `cycle` — the 6-hour window the artifact belongs to.
- `provider` — AI provenance (where applicable).
- `warnings` — non-fatal degradations (source timeouts, budget exhaustion).

Stage payloads: `AggregationData` → `RankingData` → `Top10Data` → `ArticleData`.

### Contract evolution rules

- **Additive** changes (new optional field) → no version bump; consumers ignore unknowns.
- **Breaking** changes (rename/remove/retype) → bump `SCHEMA_VERSION`, update all four
  repos in the same change set, and gate consumers on the version they accept.
- The contract file is **vendored**, not published as a package, to keep each repo
  buildable in isolation. A future `@ardurai/pipeline-contracts` package may replace it.

## 6. Cross-cutting guarantees (every engine enforces)

- **Copyright safety** — original text only; attribution + canonical links preserved;
  quotes < 25 words; **never** reproduce article bodies. Items carry metadata-derived
  hints, not source prose.
- **Pluggable, cost-guarded AI** — provider order: deterministic (default, zero-cost) →
  local Ollama → optional API. A per-run generation budget (`ARDUR_AI_MAX_GENERATIONS`)
  and per-call timeout fall back to deterministic output. CI always runs deterministic.
- **Privacy** — no PII in URLs or logs; interaction metrics are aggregate-only; metric
  keys are screened against `FORBIDDEN_METRIC_KEY_FRAGMENTS`.
- **Source safety** — SSRF-safe fetching: HTTPS-only, allow-listed hosts, blocked private
  IP ranges, bounded response reads (ported from `source-safety.mjs`).
- **Determinism & audit** — ranking is fully reproducible from its audit trail; synthesis
  records provider/model/status for every article.

## 7. Relationship to the existing `ardur.ai` system

These four engines **extract and generalize** working code already running on
[`ardur.ai`](https://github.com/ArdurAI/ardur.ai) `main`:

| Existing (`ardur.ai/main`) | Extracted into | Notes |
|----------------------------|----------------|-------|
| `scripts/refresh-news.mjs`, `scripts/news-sources.mjs` | `ardur-news-aggregator` | Generalize from a single Google News RSS meta-feed to ≥20–30 direct + meta sources/topic. |
| `scripts/source-safety.mjs` | shared `source-safety` in every engine | SSRF guard, bounded reads, URL normalization. |
| `scoreItem()` + `build-news-digests.mjs` clustering/quality | `ardur-ranking-engine` | Promote inline scoring to a weighted, audited model. |
| `build-news-digests.mjs` top-N + `hourly-intelligence.yml` | `ardur-top10-engine` | Move hourly → 6h; add stability/deltas. |
| `src/lib/aiProvider.mjs`, `generateSignalBrief()`, `build-news-digests.mjs` digest assembly | `ardur-article-synthesizer` | Promote single-paragraph briefs to full original articles. |
| `refresh-article-intelligence.mjs` privacy/metrics policy | shared privacy guards | Aggregate-only metrics, forbidden-key screening. |

Migration is **incremental**: the existing monolith keeps working while each engine
is stood up behind the same JSON-snapshot contract the app already consumes.

## 8. Performance / SLOs (batch run)

| Stage | Target p95 latency (per cycle) | Notes |
|-------|-------------------------------|-------|
| Aggregation | ≤ 8 min | ≥20 sources × ~11 topics, fetched concurrently with per-source timeout. |
| Ranking | ≤ 60 s | Pure compute over aggregated clusters. |
| Top-10 | ≤ 30 s | Selection + delta vs previous cycle. |
| Synthesis | ≤ 12 min | ≤ `ARDUR_AI_MAX_GENERATIONS` model calls; deterministic for the rest. |
| **Full cycle** | **≤ 25 min** | Comfortably inside the 6h window; ≥ 5h33m slack for retries. |

Freshness SLO: published `ArticleArtifact` is never older than **one cycle + 25 min**.
Availability SLO: if a cycle fails, the app continues serving the previous cycle's
artifacts (last-good-wins); no blank states.

## 9. Repository map

- `ardur-news-aggregator` — stage 1
- `ardur-ranking-engine` — stage 2
- `ardur-top10-engine` — stage 3 + orchestration
- `ardur-article-synthesizer` — stage 4
- Each repo: `README.md`, `docs/spec.md`, `ARCHITECTURE.md` (this file), `src/contracts.ts`
  (shared), typed `src/` stubs, MIT `LICENSE`, CI stub.

## 10. Product rules (aggregator-specific)

### Tech-only scope filter

The aggregator is scoped exclusively to technology content: AI/ML, developer tools,
cloud-native infrastructure, and security. Sources are curated and tier-classified;
no general-interest or non-tech outlets may be added to the source registry.

### Source taxonomy tiers

| Tier | Examples | Default credibilityHint |
|------|----------|------------------------|
| `primary` | openai.com, kubernetes.io, nist.gov, cisa.gov | 0.9 |
| `paper` | arxiv.org cs.AI / cs.LG / cs.CL / cs.CR | 0.85 |
| `technical-news` | thenewstack.io, infoq.com, huggingface.co | 0.75 |
| `news` | techcrunch.com, theverge.com, wired.com | 0.7 |
| `security-news` | thehackernews.com, bleepingcomputer.com | 0.75 |

`credibilityHint` is consumed by `ardur-ranking-engine` as the seed for the credibility
signal; it is not enforced by the aggregator.

### Article lifecycle state machine

```
               ┌──────────────┐
 ingested ────▶│  candidate   │
               └──────┬───────┘
                      │ ranked + selected into Top-10
               ┌──────▼───────┐
               │  top10_live  │◀─── refreshed each 6h cycle
               └──────┬───────┘
                      │ displaced by fresher Top-10 on next cycle
               ┌──────▼───────┐
               │archived_news │
               └──────────────┘
```

- **candidate**: any `AggregatedItem` that survived dedup + clustering.
- **top10_live**: selected into the current cycle's Top-10. `carriedOver=false` means
  it entered fresh this cycle; `carriedOver=true` means it persisted from the prior cycle
  within the stability margin (see `ardur-top10-engine`).
- **archived_news**: was `top10_live` but displaced on the next cycle; retained in the
  `AggregationArtifact` for audit and historical ranking.

### GenZ-professional voice

Synthesized articles (stage 4) target a **GenZ-professional tone**: technically precise,
no jargon for jargon's sake, direct and opinionated, short punchy sentences. Not informal
slang; not stiff corporate-speak. The aggregator does not enforce this — it is documented
here so that `summaryHint` extraction and `sources.ts` curation do not pre-bias the text.

### `claims[]` field rationale

`AggregatedItem` carries an optional `claims?: string[]` (≤5 key phrases extracted from
`title` + `summaryHint`). This is an additive change — no `SCHEMA_VERSION` bump required
(consumers ignore unknown fields per the contract evolution rules in §5). Downstream uses:

- `ardur-ranking-engine`: cross-reference claims across clusters for corroboration scoring.
- `ardur-article-synthesizer`: use claims as fact-check anchors for provenance attribution.

A sync issue should be filed against the other engine repos to document awareness of this
field; the field is populated by the aggregator and passively visible downstream.
