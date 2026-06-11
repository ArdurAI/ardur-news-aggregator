/**
 * SSRF-safe fetching primitives — ported verbatim from source-safety.mjs.
 * Extended with port restriction (DEFAULT_FETCH_PORTS) and credential stripping.
 */
export interface NormalizeOptions {
    allowHttp?: boolean;
    allowedProtocols?: string[];
    allowedHosts?: Iterable<string>;
    allowedPorts?: Set<string>;
}
export declare const DEFAULT_FETCH_PORTS: Set<string>;
export declare const GOOGLE_NEWS_FETCH_HOSTS: Set<string>;
export declare function normalizePublicUrl(value: unknown, options?: NormalizeOptions): string;
export declare function assertAllowedFetchUrl(value: unknown, allowedHosts: Iterable<string>, options?: {
    allowedPorts?: Set<string>;
}): string;
export declare function readBoundedText(response: Response, opts: {
    maxBytes: number;
    label: string;
}): Promise<string>;
