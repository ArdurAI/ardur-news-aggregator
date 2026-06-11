/**
 * Interaction-metric capture — aggregate-only engagement signals.
 * PRIVACY-CRITICAL: aggregate counts only, no per-user data.
 */

import type { InteractionMetrics } from '@ardurai/contracts';
import { FORBIDDEN_METRIC_KEY_FRAGMENTS } from '@ardurai/contracts';

export { FORBIDDEN_METRIC_KEY_FRAGMENTS };

export function isForbiddenMetricKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_\-\s]/g, '');
  return FORBIDDEN_METRIC_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

const SHARES_KEYS = new Set(['shares', 'sharecount', 'share']);
const COMMENTS_KEYS = new Set(['comments', 'commentcount', 'comment']);
const REACTIONS_KEYS = new Set(['reactions', 'reactioncount', 'likes', 'like', 'hearts']);

export function captureInteractionMetrics(
  input: { feedRank: number; engagement?: Record<string, number> },
  opts: { capturedAt: Date; provenance: string },
): InteractionMetrics {
  let shares: number | null = null;
  let comments: number | null = null;
  let reactions: number | null = null;

  if (input.engagement) {
    for (const [key, value] of Object.entries(input.engagement)) {
      if (isForbiddenMetricKey(key)) continue;
      const normalized = key.toLowerCase().replace(/[_\-\s]/g, '');
      if (SHARES_KEYS.has(normalized)) shares = value;
      else if (COMMENTS_KEYS.has(normalized)) comments = value;
      else if (REACTIONS_KEYS.has(normalized)) reactions = value;
    }
  }

  return {
    feedRank: input.feedRank,
    shares,
    comments,
    reactions,
    crossSourceMentions: 0,
    velocity: null,
    capturedAt: opts.capturedAt.toISOString(),
    provenance: opts.provenance,
  };
}
