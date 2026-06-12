/**
 * Fact extractor — A4.
 *
 * AI-primary (Ollama) → ExtractedFact[] with per-source provenance.
 * Deterministic floor: regex-based entity/number/date extraction for when
 * the LLM is unavailable — but synthesis treats a fact-poor cluster as HOLD,
 * not as license to invent.
 *
 * Hard rules:
 *   - Every ExtractedFact has provenance.length >= 1.
 *   - No fact is emitted that is not grounded in a real source body.
 *   - The statement is original expression — not a copied sentence.
 *   - Quotes in provenance are validated to < 25 words by the copyright guard.
 *   - Fact ids are content-derived (deterministic given the same inputs).
 *   - Paywalled / ToS-restricted / robots-disallowed bodies are never mined.
 */

import { createHash } from 'node:crypto';
import type { SourceDocument, ExtractedFact, FactProvenance } from './contracts-v3.ts';
import type { ProviderMeta, Confidence } from '@ardurai/contracts';
import { validateFactsForWire, hasForbiddenVerbatimOverlap, wordCount } from './copyright-guard.ts';
import { ExtractedFactSchema } from '@ardurai/contracts/zod';

// ── Environment config ───────────────────────────────────────────────────────

const OLLAMA_HOST = process.env['OLLAMA_HOST'] ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env['OLLAMA_MODEL'] ?? 'llama3.1:8b';
const OLLAMA_API_KEY = process.env['OLLAMA_API_KEY'];
const OLLAMA_TIMEOUT_MS = Number(process.env['OLLAMA_TIMEOUT_MS'] ?? '60000');

// ── Types ────────────────────────────────────────────────────────────────────

export interface SourceBodyPair {
  doc: SourceDocument;
  body: string;
}

export interface FactExtractionResult {
  facts: ExtractedFact[];
  provider: ProviderMeta;
  warnings: string[];
}

// JSON schema shape expected from Ollama
interface RawFactFromLlm {
  statement: string;
  entities?: string[];
  quantity?: {
    metric: string;
    value: number;
    unit?: string;
    asOf?: string;
  };
  quote?: string;
  confidence?: string;
}

// ── Deterministic fact id ────────────────────────────────────────────────────

/**
 * Content-derived fact id: SHA-256(clusterId | statement | primaryDocId).
 * Same inputs always produce the same id — no randomness, no wall-clock.
 */
function factIdFrom(clusterId: string, statement: string, primaryDocId: string): string {
  return createHash('sha256')
    .update(`${clusterId}|${statement}|${primaryDocId}`)
    .digest('hex')
    .slice(0, 32);
}

// ── Ollama client ────────────────────────────────────────────────────────────

async function ollamaGenerate(prompt: string, schema: object): Promise<string | null> {
  const endpoint = `${OLLAMA_HOST.replace(/\/$/, '')}/api/generate`;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (OLLAMA_API_KEY) headers['authorization'] = `Bearer ${OLLAMA_API_KEY}`;

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        format: schema,
        stream: false,
        options: { temperature: 0.1, num_predict: 2048 },
      }),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as { response?: string };
    return data.response ?? null;
  } catch {
    return null;
  }
}

// ── LLM extraction ───────────────────────────────────────────────────────────

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['statement'],
        properties: {
          statement: { type: 'string', description: 'Atomic, original-expression fact (not a copy of any sentence)' },
          entities: { type: 'array', items: { type: 'string' } },
          quantity: {
            type: 'object',
            properties: {
              metric: { type: 'string' },
              value: { type: 'number' },
              unit: { type: 'string' },
              asOf: { type: 'string' },
            },
            required: ['metric', 'value'],
          },
          quote: { type: 'string', description: 'Optional verbatim support, MUST be < 25 words' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
  required: ['facts'],
};

function buildExtractionPrompt(body: string, title: string, topic: string): string {
  const truncated = body.length > 6000 ? body.slice(0, 6000) + '…' : body;
  return `You are a precise fact extractor for a tech news pipeline.

Extract ATOMIC, VERIFIABLE facts from the article below. Rules:
1. Each fact must be stated in ORIGINAL EXPRESSION — rephrase, never copy sentences verbatim.
2. Include a quote ONLY if it adds essential context; if present, it MUST be under 25 words and verbatim from the article.
3. For any number/quantity/percentage/date, populate the "quantity" field.
4. Only extract facts that are directly stated or clearly implied in the article — NO assumptions.
5. Skip editorial opinions, predictions, and vague claims.
6. Target 3-8 facts per article.

Topic context: ${topic}
Title: ${title}

Article:
${truncated}

Return JSON matching the schema.`;
}

async function extractWithLlm(
  pairs: SourceBodyPair[],
  topic: string,
  clusterId: string,
  now: Date,
): Promise<{ facts: Omit<ExtractedFact, 'corroboration'>[]; providerMeta: ProviderMeta } | null> {
  const generatedAt = now.toISOString();

  // Batch: extract from each source independently, then cross-reference for corroboration
  const perSourceFacts: Map<string, RawFactFromLlm[]> = new Map();

  for (const { doc, body } of pairs) {
    if (!body || body.length < 100) continue;
    const prompt = buildExtractionPrompt(body, doc.title, topic);
    const raw = await ollamaGenerate(prompt, EXTRACTION_SCHEMA);
    if (!raw) continue;

    try {
      const parsed = JSON.parse(raw) as { facts?: RawFactFromLlm[] };
      const rawFacts = parsed.facts ?? [];
      perSourceFacts.set(doc.id, rawFacts);
    } catch {
      // malformed JSON — skip this source
    }
  }

  if (perSourceFacts.size === 0) return null;

  const providerMeta: ProviderMeta = {
    provider: 'ollama',
    model: OLLAMA_MODEL,
    status: 'generated',
    generatedAt,
  };

  const docById = new Map(pairs.map((p) => [p.doc.id, p.doc]));

  // Build facts with provenance from the source that produced them
  const results: Omit<ExtractedFact, 'corroboration'>[] = [];

  for (const [docId, rawFacts] of perSourceFacts) {
    const doc = docById.get(docId);
    if (!doc) continue;

    for (const rawFact of rawFacts) {
      if (!rawFact.statement || rawFact.statement.length < 10) continue;

      // Screen verbatim overlap with the source body
      const sourcePair = pairs.find((p) => p.doc.id === docId);
      if (sourcePair && hasForbiddenVerbatimOverlap(rawFact.statement, sourcePair.body)) {
        continue; // statement too verbatim — skip
      }

      const prov: FactProvenance = {
        sourceDocId: docId,
        sourceDomain: doc.sourceDomain,
        url: doc.url,
      };

      if (rawFact.quote) {
        const qWords = wordCount(rawFact.quote);
        if (qWords <= 25) {
          prov.quote = rawFact.quote;
        }
        // If over 25 words, omit the quote (don't truncate LLM quotes — they should be precise)
      }

      const entities = (rawFact.entities ?? []).filter(
        (e): e is string => typeof e === 'string' && e.length > 0,
      );
      const confidence: Confidence = rawFact.confidence === 'high'
        ? 'high'
        : rawFact.confidence === 'low'
          ? 'low'
          : 'medium';

      const fact: Omit<ExtractedFact, 'corroboration'> = {
        id: factIdFrom(clusterId, rawFact.statement, docId),
        topic,
        clusterId,
        statement: rawFact.statement,
        entities,
        provenance: [prov],
        confidence,
        extractedBy: providerMeta,
      };

      if (rawFact.quantity &&
          typeof rawFact.quantity.metric === 'string' &&
          typeof rawFact.quantity.value === 'number') {
        fact.quantity = {
          metric: rawFact.quantity.metric,
          value: rawFact.quantity.value,
          ...(rawFact.quantity.unit !== undefined ? { unit: rawFact.quantity.unit } : {}),
          ...(rawFact.quantity.asOf !== undefined ? { asOf: rawFact.quantity.asOf } : {}),
        };
      }

      results.push(fact);
    }
  }

  return { facts: results, providerMeta };
}

// ── Deterministic floor ───────────────────────────────────────────────────────

const NUMBER_WITH_UNIT_RE = /(\b\d[\d,.]*\s*(?:billion|million|thousand|trillion|%|percent|ms|GB|TB|MB|KB|K|B|M|T|x|×)\b)/gi;
const NAMED_ENTITY_RE = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/g;
const IMPORTANT_DOMAINS_RE = /\b(OpenAI|Anthropic|Google|Microsoft|Amazon|NVIDIA|Meta|Apple|Kubernetes|CNCF|GitHub)\b/gi;

function deterministicExtract(
  doc: SourceDocument,
  body: string,
  topic: string,
  clusterId: string,
  now: Date,
): ExtractedFact[] {
  const generatedAt = now.toISOString();
  const providerMeta: ProviderMeta = {
    provider: 'deterministic',
    model: 'regex-v1',
    status: 'fallback',
    generatedAt,
  };

  const facts: ExtractedFact[] = [];
  const seen = new Set<string>();
  const sentences = body.split(/(?<=[.!?])\s+/).filter((s) => s.length > 30 && s.length < 500);

  for (const sentence of sentences.slice(0, 20)) {
    const domainEntities: string[] = [];
    for (const match of sentence.matchAll(IMPORTANT_DOMAINS_RE)) {
      const e = (match[0] ?? '').trim();
      if (e) domainEntities.push(e);
    }
    const namedEntities: string[] = [];
    for (const match of sentence.matchAll(NAMED_ENTITY_RE)) {
      const e = (match[0] ?? '').trim();
      if (e.length > 3 && !domainEntities.some((d) => d.toLowerCase() === e.toLowerCase())) {
        namedEntities.push(e);
      }
    }
    const numbers = [...sentence.matchAll(NUMBER_WITH_UNIT_RE)].map((m) => m[0] ?? '');

    const allEntities = [...domainEntities, ...namedEntities];
    if (allEntities.length === 0 && numbers.length === 0) continue;

    // Build a SHORT STRUCTURED statement (< 8 tokens → can never form an 8-gram with the body).
    // This avoids the self-referential verbatim-overlap failure when the body and the statement
    // are both derived from the same source text.
    const primaryEntity = allEntities[0] ?? topic;
    let statement: string;
    if (numbers.length > 0) {
      statement = `${primaryEntity}: ${numbers[0]}`;
    } else if (allEntities.length >= 2) {
      statement = `${allEntities[0]} and ${allEntities[1]}`;
    } else {
      statement = `${primaryEntity} — ${topic}`;
    }
    // Trim to 80 chars max; normalize whitespace
    statement = statement.replace(/\s+/g, ' ').trim().slice(0, 80);

    const stmtKey = statement.toLowerCase();
    if (seen.has(stmtKey)) continue;
    seen.add(stmtKey);

    // Verbatim quote: first ≤ 20 words of the sentence, for provenance context.
    const sentenceWords = sentence.trim().match(/\S+/g) ?? [];
    const quoteWords = sentenceWords.slice(0, 20);
    const quote = quoteWords.join(' ') + (sentenceWords.length > 20 ? '…' : '');

    const prov: FactProvenance = {
      sourceDocId: doc.id,
      sourceDomain: doc.sourceDomain,
      url: doc.url,
      quote,
    };

    const fact: ExtractedFact = {
      id: factIdFrom(clusterId, statement, doc.id),
      topic,
      clusterId,
      statement,
      entities: [...new Set([...domainEntities, ...namedEntities])].slice(0, 8),
      provenance: [prov],
      corroboration: 1,
      confidence: 'low',
      extractedBy: providerMeta,
    };

    if (numbers.length > 0 && numbers[0]) {
      const numVal = parseFloat(numbers[0].replace(/[^\d.]/g, ''));
      if (!Number.isNaN(numVal)) {
        fact.quantity = { metric: primaryEntity, value: numVal };
      }
    }

    facts.push(fact);
    if (facts.length >= 8) break;
  }

  return facts;
}

// ── eTLD+1 helper ─────────────────────────────────────────────────────────────

// Known two-label public suffixes (heuristic subset of the ICANN Public Suffix List).
const MULTI_LEVEL_PUBLIC_SUFFIXES = new Set([
  'co.uk','org.uk','me.uk','net.uk','ltd.uk','plc.uk','sch.uk',
  'com.au','net.au','org.au','edu.au','gov.au','id.au','asn.au',
  'co.nz','net.nz','org.nz','edu.nz','govt.nz','geek.nz','school.nz',
  'co.in','org.in','net.in','nic.in','ac.in','edu.in','res.in',
  'co.jp','or.jp','ne.jp','ac.jp','ad.jp','ed.jp','go.jp',
  'co.za','org.za','net.za','ac.za','edu.za',
  'com.br','org.br','net.br','edu.br','gov.br',
  'com.cn','org.cn','net.cn','edu.cn','gov.cn',
  'com.mx','org.mx','net.mx','edu.mx',
  'com.sg','org.sg','net.sg','edu.sg',
  'co.id','or.id','net.id','ac.id','sch.id','go.id','mil.id','my.id',
]);

/**
 * Returns the registrable eTLD+1 for a hostname, stripping leading `www.`.
 * E.g.: `blog.techcrunch.com` → `techcrunch.com`, `news.bbc.co.uk` → `bbc.co.uk`.
 */
export function etld1(hostname: string): string {
  const h = hostname.toLowerCase().replace(/^www\./, '');
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const twoLabel = parts.slice(-2).join('.');
  if (MULTI_LEVEL_PUBLIC_SUFFIXES.has(twoLabel)) {
    return parts.slice(-3).join('.');
  }
  return twoLabel;
}

// ── Corroboration merging ────────────────────────────────────────────────────

/**
 * For each fact, corroboration = number of DISTINCT registrable eTLD+1 owners
 * across all docs in the cluster that contributed any content. Uses eTLD+1 so
 * a single publisher's subdomains (blog.example.com, news.example.com) count as
 * one owner, not two. Matches ardur-ranking-engine #23 definition.
 *
 * Coordination note: ardur-ranking-engine #15 expects this definition — do not
 * change the owner-dedup logic without updating the ranking engine in lockstep.
 */
function computeCorroboration(
  facts: Omit<ExtractedFact, 'corroboration'>[],
  allDocsInCluster: SourceDocument[],
): ExtractedFact[] {
  const allDomains = new Set(allDocsInCluster.map((d) => etld1(d.sourceDomain)));
  const clusterCorroboration = Math.max(allDomains.size, 1);

  return facts.map((fact) => {
    const confidence: Confidence =
      clusterCorroboration >= 2 ? (fact.confidence === 'high' ? 'high' : 'medium') : 'low';
    return { ...fact, corroboration: clusterCorroboration, confidence };
  });
}

// ── Zod validation helper ─────────────────────────────────────────────────────

/**
 * Run each ExtractedFact through the shared Tier-2 Zod schema.
 * Invalid facts are dropped with a warning (defensive — production LLM outputs
 * can be structurally surprising).
 */
function zodValidateFacts(facts: ExtractedFact[], warnings: string[]): ExtractedFact[] {
  const valid: ExtractedFact[] = [];
  for (const fact of facts) {
    const result = ExtractedFactSchema.safeParse(fact);
    if (result.success) {
      valid.push(result.data as ExtractedFact);
    } else {
      warnings.push(
        `fact ${fact.id}: Zod validation failed — dropped: ${result.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
  }
  return valid;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract facts from a cluster's source bodies.
 * Tries Ollama first; falls back to deterministic extraction.
 * All returned facts have provenance.length >= 1.
 * Wire safety is validated by copyright-guard before returning.
 *
 * @param pairs     Source body pairs (already filtered to 'allowed' accessPolicy).
 * @param topic     Topic id.
 * @param clusterId Cluster id.
 * @param now       Pinned wall-clock for deterministic generatedAt timestamps.
 */
export async function extractFacts(
  pairs: SourceBodyPair[],
  topic: string,
  clusterId: string,
  now: Date,
): Promise<FactExtractionResult> {
  const warnings: string[] = [];
  const activePairs = pairs.filter((p) => p.body && p.body.length >= 100);

  if (activePairs.length === 0) {
    return {
      facts: [],
      provider: {
        provider: 'deterministic',
        model: 'regex-v1',
        status: 'fallback',
        reason: 'no extractable bodies in cluster',
        generatedAt: now.toISOString(),
      },
      warnings: ['no extractable bodies in cluster — 0 facts'],
    };
  }

  // Try AI-primary
  const llmResult = await extractWithLlm(activePairs, topic, clusterId, now);

  let rawFacts: Omit<ExtractedFact, 'corroboration'>[];
  let provider: ProviderMeta;

  if (llmResult && llmResult.facts.length > 0) {
    rawFacts = llmResult.facts;
    provider = llmResult.providerMeta;
  } else {
    // Deterministic floor
    if (llmResult === null) {
      warnings.push('Ollama unavailable — falling back to deterministic extraction');
    } else {
      warnings.push('Ollama returned no facts — falling back to deterministic extraction');
    }

    const detFacts: ExtractedFact[] = [];
    for (const pair of activePairs) {
      detFacts.push(...deterministicExtract(pair.doc, pair.body, topic, clusterId, now));
    }

    // Deterministic facts already have corroboration=1; re-compute after merging
    const allDocs = activePairs.map((p) => p.doc);
    const withCorroboration = computeCorroboration(
      detFacts.map(({ corroboration: _c, ...rest }) => rest),
      allDocs,
    );
    const zodValid = zodValidateFacts(withCorroboration, warnings);
    const { facts: validated, violations } = validateFactsForWire(zodValid);
    warnings.push(...violations);

    return {
      facts: validated,
      provider: {
        provider: 'deterministic',
        model: 'regex-v1',
        status: 'fallback',
        reason: llmResult === null ? 'ollama-unavailable' : 'llm-returned-empty',
        generatedAt: now.toISOString(),
      },
      warnings,
    };
  }

  const allDocs = activePairs.map((p) => p.doc);
  const withCorroboration = computeCorroboration(rawFacts, allDocs);
  const zodValid = zodValidateFacts(withCorroboration, warnings);
  const { facts: validated, violations } = validateFactsForWire(zodValid);
  warnings.push(...violations);

  return { facts: validated, provider, warnings };
}
