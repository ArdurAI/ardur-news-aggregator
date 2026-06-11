/**
 * Copyright guard — A5.
 *
 * Enforces the Ardur copyright posture:
 *   - Bodies are fetched and stored PRIVATELY; never emitted on the wire.
 *   - Wire carries original-expression facts + short quotes (< 25 words) + canonical links.
 *   - 8-gram verbatim screen flags near-verbatim body reproduction in statements.
 *
 * All serialization of ExtractedFact[] MUST pass through validateFactsForWire()
 * before inclusion in any AggregationArtifact.
 */
export const MAX_QUOTE_WORDS = 25;
// ── Quote length guard ───────────────────────────────────────────────────────
function wordCount(text) {
    return text.trim().split(/\s+/).filter(Boolean).length;
}
/** Throws if the quote exceeds 25 words. */
export function assertQuoteLength(quote, context) {
    const wc = wordCount(quote);
    if (wc > MAX_QUOTE_WORDS) {
        throw new Error(`Copyright violation: quote in ${context} is ${wc} words (max ${MAX_QUOTE_WORDS}): ` +
            `"${quote.slice(0, 80)}…"`);
    }
}
/** Truncate a quote to MAX_QUOTE_WORDS (for defensive trimming, not for bypassing the guard). */
export function trimQuoteToLimit(quote) {
    const words = quote.trim().split(/\s+/);
    if (words.length <= MAX_QUOTE_WORDS)
        return quote;
    return words.slice(0, MAX_QUOTE_WORDS).join(' ') + '…';
}
// ── 8-gram verbatim screen ───────────────────────────────────────────────────
function ngrams(text, n) {
    const words = text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
    const grams = new Set();
    for (let i = 0; i <= words.length - n; i++) {
        grams.add(words.slice(i, i + n).join(' '));
    }
    return grams;
}
/**
 * Returns true if the statement shares ≥1 8-gram with the source body —
 * a signal that the statement may be lifting verbatim text rather than
 * re-expressing the fact in original language.
 */
export function hasForbiddenVerbatimOverlap(statement, sourceBody) {
    if (!sourceBody || statement.length < 40)
        return false;
    const statementGrams = ngrams(statement, 8);
    if (statementGrams.size === 0)
        return false;
    const bodyGrams = ngrams(sourceBody, 8);
    for (const gram of statementGrams) {
        if (bodyGrams.has(gram))
            return true;
    }
    return false;
}
/**
 * Validates a batch of ExtractedFacts for wire serialization.
 * Strips or truncates non-compliant quotes. Logs violations but does not throw —
 * the caller decides whether violations block publication.
 */
export function validateFactsForWire(facts) {
    const violations = [];
    const clean = [];
    for (const fact of facts) {
        if (fact.provenance.length === 0) {
            violations.push(`fact ${fact.id}: no provenance — dropped`);
            continue;
        }
        const cleanProvenance = [];
        let provenanceViolation = false;
        for (const prov of fact.provenance) {
            if (!prov.url) {
                violations.push(`fact ${fact.id}: provenance missing url — dropped`);
                provenanceViolation = true;
                break;
            }
            if (prov.quote !== undefined) {
                const wc = wordCount(prov.quote);
                if (wc > MAX_QUOTE_WORDS) {
                    violations.push(`fact ${fact.id}: quote is ${wc} words in provenance from ${prov.sourceDomain} — truncated`);
                    cleanProvenance.push({ ...prov, quote: trimQuoteToLimit(prov.quote) });
                    continue;
                }
            }
            cleanProvenance.push(prov);
        }
        if (provenanceViolation)
            continue;
        clean.push({ ...fact, provenance: cleanProvenance });
    }
    return { facts: clean, violations };
}
/**
 * Scrub a body string to ensure it is NOT embedded in any wire artifact.
 * Call this if you ever need to log a fact's context for debugging —
 * use this function to ensure you never accidentally embed body text.
 */
export function assertNotBodyText(_body, location) {
    throw new Error(`Copyright guard: attempted to serialize article body at ${location}. ` +
        `Bodies must remain in the private ETL store only.`);
}
