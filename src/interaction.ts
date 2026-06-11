/**
 * Interaction-metric capture — aggregate-only engagement signals.
 *
 * SCAFFOLD ONLY. PRIVACY-CRITICAL: capture only aggregate counts. NEVER store
 * user/session/device ids, IPs, emails, cookies, UTM, or referrers. Screen
 * every metric key against `FORBIDDEN_METRIC_KEY_FRAGMENTS` (see contracts.ts)
 * and drop the field if it matches.
 */

import type { InteractionMetrics } from './contracts.ts';
import { FORBIDDEN_METRIC_KEY_FRAGMENTS } from './contracts.ts';

export { FORBIDDEN_METRIC_KEY_FRAGMENTS };

/** True if a metric key looks like it could carry PII. */
export function isForbiddenMetricKey(_key: string): boolean {
  throw new Error('not implemented: normalize key, test against FORBIDDEN_METRIC_KEY_FRAGMENTS');
}

/**
 * Derive aggregate interaction metrics for one item from its feed position and
 * any allow-listed engagement counts. crossSourceMentions/velocity are filled
 * in after clustering (they are cluster-level signals projected onto members).
 */
export function captureInteractionMetrics(
  _input: { feedRank: number; engagement?: Record<string, number> },
  _opts: { capturedAt: Date; provenance: string },
): InteractionMetrics {
  throw new Error('not implemented');
}
