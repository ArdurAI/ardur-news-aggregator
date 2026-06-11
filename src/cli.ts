/**
 * CLI — run one aggregation cycle and write the artifact to stdout or a file.
 *
 * SCAFFOLD ONLY. Usage (once implemented):
 *   node --experimental-strip-types src/cli.ts > data/runtime/aggregation.json
 */

import { runAggregation } from './index.ts';

async function main(): Promise<void> {
  const artifact = await runAggregation();
  process.stdout.write(JSON.stringify(artifact, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
