import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_VERSION, CYCLE_INTERVAL_MS, FORBIDDEN_METRIC_KEY_FRAGMENTS } from './contracts.ts';
import { runAggregation } from './index.ts';

test('schema version is pinned', () => {
  assert.equal(SCHEMA_VERSION, 'ardur-content-pipeline/v1');
});

test('cycle interval is 6 hours', () => {
  assert.equal(CYCLE_INTERVAL_MS, 6 * 60 * 60 * 1000);
});

test('privacy guard lists known PII fragments', () => {
  assert.ok(FORBIDDEN_METRIC_KEY_FRAGMENTS.includes('email'));
  assert.ok(FORBIDDEN_METRIC_KEY_FRAGMENTS.includes('session'));
});

test('runAggregation is wired but not yet implemented', async () => {
  await assert.rejects(async () => runAggregation(), /not implemented/);
});
