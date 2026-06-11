/**
 * ETL Store — persistent, content-addressed store for SourceDocuments and
 * private article bodies.
 *
 * Layout under data/etl-store/ (gitignored, never on the wire):
 *   docs/{docId}.json     — SourceDocument metadata (no body)
 *   bodies/{docId}.txt    — Private extracted body text
 *   hash-index.ndjson     — running contentHash → docId index (append-only)
 *
 * Callers MUST use getBody() to read a body; it is never included in the
 * serialized SourceDocument.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceDocument } from './contracts-v3.ts';

const STORE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'etl-store',
);

const DOCS_DIR = join(STORE_ROOT, 'docs');
const BODIES_DIR = join(STORE_ROOT, 'bodies');
const HASH_INDEX_PATH = join(STORE_ROOT, 'hash-index.ndjson');

function ensureDirs(): void {
  for (const dir of [STORE_ROOT, DOCS_DIR, BODIES_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

/** Build a stable document id from the canonical URL. */
export function docIdFromUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 40);
}

/** SHA-256 hex digest of text content — used as contentHash. */
export function contentHashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface EtlStore {
  getByContentHash(hash: string): Promise<SourceDocument | null>;
  getById(id: string): Promise<SourceDocument | null>;
  getBody(sourceDocId: string): Promise<string | null>;
  put(doc: SourceDocument, body: string | null): Promise<void>;
  /** Returns true if we have a fresh (non-expired) version of this URL. */
  hasFresh(
    url: string,
    opts?: { etag?: string; lastModified?: string; maxAgeMs?: number },
  ): Promise<boolean>;
}

// In-memory hash index cache to avoid re-parsing NDJSON on every lookup
const hashIndexCache = new Map<string, string>(); // contentHash → docId
let hashIndexLoaded = false;

function loadHashIndex(): void {
  if (hashIndexLoaded) return;
  hashIndexLoaded = true;
  if (!existsSync(HASH_INDEX_PATH)) return;
  const lines = readFileSync(HASH_INDEX_PATH, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const { hash, id } = JSON.parse(line) as { hash: string; id: string };
      hashIndexCache.set(hash, id);
    } catch {
      // ignore malformed lines
    }
  }
}

function appendHashIndex(hash: string, id: string): void {
  ensureDirs();
  appendFileSync(HASH_INDEX_PATH, JSON.stringify({ hash, id }) + '\n', 'utf8');
  hashIndexCache.set(hash, id);
}

export const fileEtlStore: EtlStore = {
  async getByContentHash(hash: string): Promise<SourceDocument | null> {
    loadHashIndex();
    const id = hashIndexCache.get(hash);
    if (!id) return null;
    return this.getById(id);
  },

  async getById(id: string): Promise<SourceDocument | null> {
    const path = join(DOCS_DIR, `${id}.json`);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as SourceDocument;
    } catch {
      return null;
    }
  },

  async getBody(sourceDocId: string): Promise<string | null> {
    const path = join(BODIES_DIR, `${sourceDocId}.txt`);
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8');
  },

  async put(doc: SourceDocument, body: string | null): Promise<void> {
    ensureDirs();
    loadHashIndex();
    // Write doc metadata (no body field)
    writeFileSync(join(DOCS_DIR, `${doc.id}.json`), JSON.stringify(doc, null, 2), 'utf8');
    // Write body privately
    if (body !== null) {
      writeFileSync(join(BODIES_DIR, `${doc.id}.txt`), body, 'utf8');
    }
    // Update hash index
    if (!hashIndexCache.has(doc.contentHash)) {
      appendHashIndex(doc.contentHash, doc.id);
    }
  },

  async hasFresh(
    url: string,
    opts: { etag?: string; lastModified?: string; maxAgeMs?: number } = {},
  ): Promise<boolean> {
    const id = docIdFromUrl(url);
    const doc = await this.getById(id);
    if (!doc) return false;
    // If the server provided an ETag and it matches, we're fresh
    if (opts.etag && doc.etag && opts.etag === doc.etag) return true;
    // If maxAgeMs provided, check age
    if (opts.maxAgeMs !== undefined) {
      const age = Date.now() - new Date(doc.fetchedAt).valueOf();
      return age < opts.maxAgeMs;
    }
    return true;
  },
};

/** List all stored document ids (for diagnostics). */
export function listStoredDocIds(): string[] {
  if (!existsSync(DOCS_DIR)) return [];
  return readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5));
}
