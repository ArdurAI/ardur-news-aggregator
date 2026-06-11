/**
 * ETL Store — persistent, content-addressed store for SourceDocuments and
 * private article bodies.
 *
 * Layout under data/etl-store/ (gitignored, never on the wire):
 *   docs/{docId}.json     — StoredDoc wrapper (SourceDocument + HTTP cache headers)
 *   bodies/{docId}.txt    — Private extracted body text
 *   hash-index.ndjson     — running contentHash → docId index (append-only)
 *
 * Callers MUST use getBody() to read a body; it is never included in the
 * serialized SourceDocument or any wire artifact.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const STORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'etl-store');
const DOCS_DIR = join(STORE_ROOT, 'docs');
const BODIES_DIR = join(STORE_ROOT, 'bodies');
const HASH_INDEX_PATH = join(STORE_ROOT, 'hash-index.ndjson');
function ensureDirs() {
    for (const dir of [STORE_ROOT, DOCS_DIR, BODIES_DIR]) {
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
    }
}
/** Build a stable document id from the canonical URL. */
export function docIdFromUrl(url) {
    return createHash('sha256').update(url).digest('hex').slice(0, 40);
}
/** SHA-256 hex digest of text content — used as contentHash. */
export function contentHashOf(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}
// In-memory hash index cache to avoid re-parsing NDJSON on every lookup
const hashIndexCache = new Map(); // contentHash → docId
let hashIndexLoaded = false;
function loadHashIndex() {
    if (hashIndexLoaded)
        return;
    hashIndexLoaded = true;
    if (!existsSync(HASH_INDEX_PATH))
        return;
    const lines = readFileSync(HASH_INDEX_PATH, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
        try {
            const { hash, id } = JSON.parse(line);
            hashIndexCache.set(hash, id);
        }
        catch {
            // ignore malformed lines
        }
    }
}
function appendHashIndex(hash, id) {
    ensureDirs();
    appendFileSync(HASH_INDEX_PATH, JSON.stringify({ hash, id }) + '\n', 'utf8');
    hashIndexCache.set(hash, id);
}
function readStoredDoc(id) {
    const path = join(DOCS_DIR, `${id}.json`);
    if (!existsSync(path))
        return null;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return null;
    }
}
export const fileEtlStore = {
    async getByContentHash(hash) {
        loadHashIndex();
        const id = hashIndexCache.get(hash);
        if (!id)
            return null;
        return this.getById(id);
    },
    async getById(id) {
        const stored = readStoredDoc(id);
        return stored?.doc ?? null;
    },
    async getBody(sourceDocId) {
        const path = join(BODIES_DIR, `${sourceDocId}.txt`);
        if (!existsSync(path))
            return null;
        return readFileSync(path, 'utf8');
    },
    async put(doc, body, opts = {}) {
        ensureDirs();
        loadHashIndex();
        const stored = { doc };
        if (opts.etag !== undefined)
            stored.etag = opts.etag;
        if (opts.lastModified !== undefined)
            stored.lastModified = opts.lastModified;
        writeFileSync(join(DOCS_DIR, `${doc.id}.json`), JSON.stringify(stored, null, 2), 'utf8');
        if (body !== null) {
            writeFileSync(join(BODIES_DIR, `${doc.id}.txt`), body, 'utf8');
        }
        if (!hashIndexCache.has(doc.contentHash)) {
            appendHashIndex(doc.contentHash, doc.id);
        }
    },
    async hasFresh(url, opts = {}) {
        const id = docIdFromUrl(url);
        const stored = readStoredDoc(id);
        if (!stored)
            return false;
        // ETag match → definitely fresh
        if (opts.etag && stored.etag && opts.etag === stored.etag)
            return true;
        // Age check
        if (opts.maxAgeMs !== undefined) {
            const age = Date.now() - new Date(stored.doc.fetchedAt).valueOf();
            return age < opts.maxAgeMs;
        }
        return true;
    },
};
/** List all stored document ids (for diagnostics). */
export function listStoredDocIds() {
    if (!existsSync(DOCS_DIR))
        return [];
    return readdirSync(DOCS_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5));
}
