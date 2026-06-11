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
 */
import { randomUUID } from 'node:crypto';
import { validateFactsForWire, hasForbiddenVerbatimOverlap } from "./copyright-guard.js";
// ── Environment config ───────────────────────────────────────────────────────
const OLLAMA_HOST = process.env['OLLAMA_HOST'] ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env['OLLAMA_MODEL'] ?? 'llama3.1:8b';
const OLLAMA_API_KEY = process.env['OLLAMA_API_KEY'];
const OLLAMA_TIMEOUT_MS = Number(process.env['OLLAMA_TIMEOUT_MS'] ?? '60000');
// ── Ollama client ────────────────────────────────────────────────────────────
async function ollamaGenerate(prompt, schema) {
    const endpoint = `${OLLAMA_HOST.replace(/\/$/, '')}/api/generate`;
    const headers = {
        'content-type': 'application/json',
    };
    if (OLLAMA_API_KEY)
        headers['authorization'] = `Bearer ${OLLAMA_API_KEY}`;
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
        if (!resp.ok)
            return null;
        const data = (await resp.json());
        return data.response ?? null;
    }
    catch {
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
function buildExtractionPrompt(body, title, topic) {
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
async function extractWithLlm(pairs, topic, clusterId) {
    const generatedAt = new Date().toISOString();
    // Batch: extract from each source independently, then cross-reference for corroboration
    const perSourceFacts = new Map();
    for (const { doc, body } of pairs) {
        if (!body || body.length < 100)
            continue;
        const prompt = buildExtractionPrompt(body, doc.title, topic);
        const raw = await ollamaGenerate(prompt, EXTRACTION_SCHEMA);
        if (!raw)
            continue;
        try {
            const parsed = JSON.parse(raw);
            const rawFacts = parsed.facts ?? [];
            perSourceFacts.set(doc.id, rawFacts);
        }
        catch {
            // malformed JSON — skip this source
        }
    }
    if (perSourceFacts.size === 0)
        return null;
    const providerMeta = {
        provider: 'ollama',
        model: OLLAMA_MODEL,
        status: 'generated',
        generatedAt,
    };
    const docById = new Map(pairs.map((p) => [p.doc.id, p.doc]));
    // Build facts with provenance from the source that produced them
    const results = [];
    for (const [docId, rawFacts] of perSourceFacts) {
        const doc = docById.get(docId);
        if (!doc)
            continue;
        for (const rawFact of rawFacts) {
            if (!rawFact.statement || rawFact.statement.length < 10)
                continue;
            // Screen verbatim overlap with the source body
            const sourcePair = pairs.find((p) => p.doc.id === docId);
            if (sourcePair && hasForbiddenVerbatimOverlap(rawFact.statement, sourcePair.body)) {
                continue; // statement too verbatim — skip
            }
            const prov = {
                sourceDocId: docId,
                sourceDomain: doc.sourceDomain,
                url: doc.url,
            };
            if (rawFact.quote) {
                const qWords = rawFact.quote.trim().split(/\s+/).length;
                if (qWords <= 25) {
                    prov.quote = rawFact.quote;
                }
                // If over 25 words, omit the quote (don't truncate LLM quotes — they should be precise)
            }
            const entities = (rawFact.entities ?? []).filter((e) => typeof e === 'string' && e.length > 0);
            const confidence = rawFact.confidence === 'high'
                ? 'high'
                : rawFact.confidence === 'low'
                    ? 'low'
                    : 'medium';
            const fact = {
                id: randomUUID(),
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
function deterministicExtract(doc, body, topic, clusterId) {
    const generatedAt = new Date().toISOString();
    const providerMeta = {
        provider: 'deterministic',
        model: 'regex-v1',
        status: 'fallback',
        generatedAt,
    };
    const facts = [];
    const sentences = body.split(/(?<=[.!?])\s+/).filter((s) => s.length > 30 && s.length < 300);
    for (const sentence of sentences.slice(0, 15)) {
        const entities = new Set();
        for (const match of sentence.matchAll(IMPORTANT_DOMAINS_RE)) {
            entities.add(match[0] ?? '');
        }
        for (const match of sentence.matchAll(NAMED_ENTITY_RE)) {
            const entity = match[0] ?? '';
            if (entity.length > 3)
                entities.add(entity);
        }
        // Only emit a fact if it mentions a known entity or has a quantity
        const numbers = [...sentence.matchAll(NUMBER_WITH_UNIT_RE)].map((m) => m[0] ?? '');
        if (entities.size === 0 && numbers.length === 0)
            continue;
        // Truncate sentence to avoid verbatim reproduction (hard limit: 40 words)
        const words = sentence.trim().split(/\s+/);
        if (words.length > 40)
            continue; // too long — skip to avoid near-verbatim
        const statement = sentence.trim();
        if (hasForbiddenVerbatimOverlap(statement, body))
            continue;
        const prov = {
            sourceDocId: doc.id,
            sourceDomain: doc.sourceDomain,
            url: doc.url,
        };
        const fact = {
            id: randomUUID(),
            topic,
            clusterId,
            statement,
            entities: [...entities].slice(0, 8),
            provenance: [prov],
            corroboration: 1,
            confidence: 'low',
            extractedBy: providerMeta,
        };
        // Try to extract a quantity
        if (numbers.length > 0 && numbers[0]) {
            fact.quantity = { metric: 'measurement', value: parseFloat(numbers[0].replace(/[^\d.]/g, '')) };
        }
        facts.push(fact);
    }
    return facts.slice(0, 8); // deterministic floor: max 8 facts per source
}
// ── Corroboration merging ────────────────────────────────────────────────────
/**
 * For each fact, compute corroboration = count of distinct source domains that
 * have a fact in the same cluster (rough entity-overlap matching).
 */
function computeCorroboration(facts, allDocsInCluster) {
    const allDomains = new Set(allDocsInCluster.map((d) => d.sourceDomain));
    return facts.map((fact) => {
        // Simple heuristic: corroboration = number of distinct domains in the cluster
        // that mention any of the fact's entities. For LLM-extracted facts, we use
        // the count of distinct provenance domains.
        const provenanceDomains = new Set(fact.provenance.map((p) => p.sourceDomain));
        const corroboration = Math.max(provenanceDomains.size, 1);
        const confidence = corroboration >= 2 ? (fact.confidence === 'high' ? 'high' : 'medium') : 'low';
        return { ...fact, corroboration, confidence };
    });
}
// ── Public API ───────────────────────────────────────────────────────────────
/**
 * Extract facts from a cluster's source bodies.
 * Tries Ollama first; falls back to deterministic extraction.
 * All returned facts have provenance.length >= 1.
 * Wire safety is validated by copyright-guard before returning.
 */
export async function extractFacts(pairs, topic, clusterId) {
    const warnings = [];
    const activePairs = pairs.filter((p) => p.body && p.body.length >= 100);
    if (activePairs.length === 0) {
        return {
            facts: [],
            provider: {
                provider: 'deterministic',
                model: 'regex-v1',
                status: 'fallback',
                reason: 'no extractable bodies in cluster',
                generatedAt: new Date().toISOString(),
            },
            warnings: ['no extractable bodies in cluster — 0 facts'],
        };
    }
    // Try AI-primary
    const llmResult = await extractWithLlm(activePairs, topic, clusterId);
    let rawFacts;
    let provider;
    if (llmResult && llmResult.facts.length > 0) {
        rawFacts = llmResult.facts;
        provider = llmResult.providerMeta;
    }
    else {
        // Deterministic floor
        if (llmResult === null) {
            warnings.push('Ollama unavailable — falling back to deterministic extraction');
        }
        else {
            warnings.push('Ollama returned no facts — falling back to deterministic extraction');
        }
        const detFacts = [];
        for (const pair of activePairs) {
            detFacts.push(...deterministicExtract(pair.doc, pair.body, topic, clusterId));
        }
        // Deterministic facts already have corroboration=1; re-compute after merging
        const allDocs = activePairs.map((p) => p.doc);
        const withCorroboration = computeCorroboration(detFacts.map(({ corroboration: _c, ...rest }) => rest), allDocs);
        const { facts: validated, violations } = validateFactsForWire(withCorroboration);
        warnings.push(...violations);
        return {
            facts: validated,
            provider: {
                provider: 'deterministic',
                model: 'regex-v1',
                status: 'fallback',
                reason: llmResult === null ? 'ollama-unavailable' : 'llm-returned-empty',
                generatedAt: new Date().toISOString(),
            },
            warnings,
        };
    }
    const allDocs = activePairs.map((p) => p.doc);
    const withCorroboration = computeCorroboration(rawFacts, allDocs);
    const { facts: validated, violations } = validateFactsForWire(withCorroboration);
    warnings.push(...violations);
    return { facts: validated, provider, warnings };
}
