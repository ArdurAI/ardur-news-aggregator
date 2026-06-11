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
import type { SourceDocument } from '@ardurai/contracts';
/** Build a stable document id from the canonical URL. */
export declare function docIdFromUrl(url: string): string;
/** SHA-256 hex digest of text content — used as contentHash. */
export declare function contentHashOf(text: string): string;
export interface PutOpts {
    etag?: string;
    lastModified?: string;
}
export interface EtlStore {
    getByContentHash(hash: string): Promise<SourceDocument | null>;
    getById(id: string): Promise<SourceDocument | null>;
    getBody(sourceDocId: string): Promise<string | null>;
    put(doc: SourceDocument, body: string | null, opts?: PutOpts): Promise<void>;
    /** Returns true if we have a fresh (non-expired) version of this URL. */
    hasFresh(url: string, opts?: {
        etag?: string;
        lastModified?: string;
        maxAgeMs?: number;
    }): Promise<boolean>;
}
export declare const fileEtlStore: EtlStore;
/** List all stored document ids (for diagnostics). */
export declare function listStoredDocIds(): string[];
