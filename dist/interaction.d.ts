/**
 * Interaction-metric capture — aggregate-only engagement signals.
 * PRIVACY-CRITICAL: aggregate counts only, no per-user data.
 */
import type { InteractionMetrics } from '@ardurai/contracts';
import { FORBIDDEN_METRIC_KEY_FRAGMENTS } from '@ardurai/contracts';
export { FORBIDDEN_METRIC_KEY_FRAGMENTS };
export declare function isForbiddenMetricKey(key: string): boolean;
export declare function captureInteractionMetrics(input: {
    feedRank: number;
    engagement?: Record<string, number>;
}, opts: {
    capturedAt: Date;
    provenance: string;
}): InteractionMetrics;
