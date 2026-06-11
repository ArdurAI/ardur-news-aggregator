/**
 * SSRF-safe fetching primitives.
 *
 * SCAFFOLD ONLY — signatures are final; bodies are stubs.
 *
 * Port the implementation from `ardur.ai/main:scripts/source-safety.mjs`, which
 * already provides: HTTPS-only normalization, blocked private IPv4 ranges + all
 * IPv6, blocked internal hostnames/suffixes, allow-listed-host enforcement,
 * port restriction, and bounded streaming reads. That file is the canonical
 * reference; keep this module behaviorally identical.
 */

export interface NormalizeOptions {
  allowHttp?: boolean;
  allowedProtocols?: string[];
  allowedHosts?: Iterable<string>;
  allowedPorts?: Set<string>;
}

export const DEFAULT_FETCH_PORTS: Set<string> = new Set(['', '443']);

/** Allow-listed meta-feed host (Google News RSS). */
export const GOOGLE_NEWS_FETCH_HOSTS: Set<string> = new Set(['news.google.com']);

/**
 * Normalize a URL to a safe public https URL, stripping credentials and
 * fragments. Returns '' if the URL is unsafe (private IP, blocked host,
 * disallowed protocol/port, or not on the allow-list when one is given).
 */
export function normalizePublicUrl(_value: unknown, _options: NormalizeOptions = {}): string {
  throw new Error('not implemented: port from scripts/source-safety.mjs');
}

/** Like normalizePublicUrl but throws if the URL is not allow-listed/safe. */
export function assertAllowedFetchUrl(
  _value: unknown,
  _allowedHosts: Iterable<string>,
  _options: { allowedPorts?: Set<string> } = {},
): string {
  throw new Error('not implemented: port from scripts/source-safety.mjs');
}

/** Read a response body as text, enforcing a hard byte ceiling. */
export function readBoundedText(
  _response: Response,
  _opts: { maxBytes: number; label: string },
): Promise<string> {
  throw new Error('not implemented: port from scripts/source-safety.mjs');
}
