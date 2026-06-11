/**
 * CLI — run one aggregation cycle and write the artifact to stdout or a file.
 *
 * Usage:
 *   npm run aggregate                       # → stdout
 *   npm run aggregate -- --out data/golden-sample.json
 *   npm run aggregate -- --max-age-hours 48 --timeout 10000
 */

import { writeFileSync } from 'node:fs';
import { runAggregation } from './index.ts';

function parseArgs(): {
  outPath: string | null;
  maxAgeHours: number;
  timeoutMs: number;
  concurrency: number;
} {
  const args = process.argv.slice(2);
  let outPath: string | null = null;
  let maxAgeHours = 36;
  let timeoutMs = 15_000;
  let concurrency = 10;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--out' && args[i + 1]) { outPath = args[++i] ?? null; }
    else if (a === '--max-age-hours' && args[i + 1]) { maxAgeHours = Number(args[++i]) || 36; }
    else if (a === '--timeout' && args[i + 1]) { timeoutMs = Number(args[++i]) || 15_000; }
    else if (a === '--concurrency' && args[i + 1]) { concurrency = Number(args[++i]) || 10; }
  }
  return { outPath, maxAgeHours, timeoutMs, concurrency };
}

async function main(): Promise<void> {
  const { outPath, maxAgeHours, timeoutMs, concurrency } = parseArgs();
  const now = new Date();

  process.stderr.write(`[ardur-news-aggregator] starting cycle at ${now.toISOString()}\n`);
  process.stderr.write(`  maxAgeHours=${maxAgeHours} timeout=${timeoutMs}ms concurrency=${concurrency}\n`);

  const artifact = await runAggregation({
    now,
    maxAgeMs: maxAgeHours * 60 * 60 * 1000,
    perSourceTimeoutMs: timeoutMs,
    concurrency,
  });

  const topicIds = Object.keys(artifact.data.itemsByTopic).filter((t) => t !== 'all');
  for (const id of topicIds) {
    const items = artifact.data.itemsByTopic[id] ?? [];
    const clusters = artifact.data.clustersByTopic[id] ?? [];
    const cov = artifact.data.coverageByTopic[id];
    process.stderr.write(
      `  [${id}] ${items.length} items · ${clusters.length} clusters · ` +
      `${cov?.sourcesResponded ?? 0}/${cov?.sourcesConfigured ?? 0} sources responded` +
      (cov?.degraded ? ' ⚠ degraded' : '') + '\n',
    );
  }
  const allItems = artifact.data.itemsByTopic['all'] ?? [];
  process.stderr.write(`  [all] ${allItems.length} merged items · ${artifact.warnings.length} warnings\n`);

  const json = JSON.stringify(artifact, null, 2);
  if (outPath) {
    writeFileSync(outPath, json, 'utf-8');
    process.stderr.write(`[ardur-news-aggregator] wrote ${json.length} bytes → ${outPath}\n`);
  } else {
    process.stdout.write(json);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
