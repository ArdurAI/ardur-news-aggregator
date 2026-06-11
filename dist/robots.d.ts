/**
 * robots.txt — per-host cache and path checker.
 *
 * Honors the User-Agent "ArdurContentBot" (falling back to "*").
 * Caches parsed results for the lifetime of the process (one 6-hour cycle).
 * Respects Crawl-delay (returned to callers; callers must enforce it).
 */
export interface RobotsResult {
    /** Whether our bot is allowed to fetch this URL. */
    allowed: boolean;
    /** Crawl-delay in seconds, if specified. */
    crawlDelaySeconds: number | null;
}
/**
 * Check whether our bot is allowed to fetch the given URL.
 * Results are cached per-host for the lifetime of the process.
 */
export declare function checkRobots(url: string): Promise<RobotsResult>;
/** Clear the robots cache (for testing). */
export declare function clearRobotsCache(): void;
