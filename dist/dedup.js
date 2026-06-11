/**
 * Dedup — collapse exact duplicates; keep cross-source corroboration.
 * Ported and generalized from uniqueByTitle in refresh-news.mjs.
 */
function stripMarkup(text) {
    return text
        .replace(/<[^>]+>/g, ' ')
        .replace(/[*_~`#[\]()!]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
function normalizeTitle(title) {
    return stripMarkup(title).toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}
function normalizeUrlPath(url) {
    try {
        const parsed = new URL(url);
        return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/$/, '')}`;
    }
    catch {
        return url.toLowerCase().slice(0, 200);
    }
}
export function fingerprint(item) {
    return `${normalizeTitle(item.title)}|${normalizeUrlPath(item.url)}`;
}
export function dedupe(items) {
    const withFingerprints = items.map((item) => ({ ...item, fingerprint: fingerprint(item) }));
    // Key: fingerprint + sourceDomain — same story from same source is a dup
    const seen = new Map();
    const output = [];
    let duplicatesRemoved = 0;
    for (const item of withFingerprints) {
        const sameSourceKey = `${item.fingerprint}::${item.sourceDomain}`;
        if (seen.has(sameSourceKey)) {
            duplicatesRemoved++;
            continue;
        }
        seen.set(sameSourceKey, true);
        output.push(item);
    }
    return { items: output, duplicatesRemoved };
}
