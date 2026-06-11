/**
 * SSRF-safe fetching primitives — ported verbatim from source-safety.mjs.
 * Extended with port restriction (DEFAULT_FETCH_PORTS) and credential stripping.
 */
import net from 'node:net';
const BLOCKED_HOSTS = new Set([
    'localhost',
    'localhost.localdomain',
    'metadata.google.internal',
]);
const PRIVATE_IPV4_RANGES = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
];
function ipv4ToNumber(address) {
    return address.split('.').reduce((value, octet) => (value << 8) + Number(octet), 0) >>> 0;
}
function ipv4InRange(address, base, bits) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipv4ToNumber(address) & mask) === (ipv4ToNumber(base) & mask);
}
function isBlockedHostname(hostname) {
    const normalized = hostname.toLowerCase().replace(/\.$/, '');
    if (!normalized || BLOCKED_HOSTS.has(normalized) || normalized.endsWith('.localhost'))
        return true;
    if (!normalized.includes('.'))
        return true;
    if (/^(?:0x[0-9a-f]+|\d+)$/i.test(normalized))
        return true;
    const ipVersion = net.isIP(normalized);
    if (ipVersion === 6)
        return true;
    if (ipVersion === 4) {
        return PRIVATE_IPV4_RANGES.some(([base, bits]) => ipv4InRange(normalized, base, bits));
    }
    return false;
}
export const DEFAULT_FETCH_PORTS = new Set(['', '443']);
export const GOOGLE_NEWS_FETCH_HOSTS = new Set(['news.google.com']);
export function normalizePublicUrl(value, options = {}) {
    const raw = String(value ?? '').trim();
    if (!raw)
        return '';
    try {
        const url = new URL(raw);
        const allowHttp = options.allowHttp === true;
        if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:'))
            return '';
        if (url.username || url.password)
            return '';
        if (isBlockedHostname(url.hostname))
            return '';
        if (options.allowedPorts !== undefined && !options.allowedPorts.has(url.port))
            return '';
        if (options.allowedHosts !== undefined) {
            const set = options.allowedHosts instanceof Set
                ? options.allowedHosts
                : new Set(options.allowedHosts);
            if (!set.has(url.hostname.toLowerCase()))
                return '';
        }
        url.hash = '';
        url.username = '';
        url.password = '';
        return url.toString();
    }
    catch {
        return '';
    }
}
export function assertAllowedFetchUrl(value, allowedHosts, options = {}) {
    const normalized = normalizePublicUrl(value, {
        allowedHosts,
        allowedPorts: options.allowedPorts ?? DEFAULT_FETCH_PORTS,
    });
    if (!normalized) {
        throw new Error(`Blocked unsafe fetch URL: ${String(value ?? '').slice(0, 160)}`);
    }
    return normalized;
}
export async function readBoundedText(response, opts) {
    const { maxBytes, label } = opts;
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new Error(`${label} exceeded ${maxBytes} byte content-length limit`);
    }
    if (!response.body) {
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > maxBytes) {
            throw new Error(`${label} exceeded ${maxBytes} byte body limit`);
        }
        return text;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
            await reader.cancel();
            throw new Error(`${label} exceeded ${maxBytes} byte body limit`);
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, totalBytes).toString('utf8');
}
