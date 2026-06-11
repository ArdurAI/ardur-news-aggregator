#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const keepTemp = process.env.ARDUR_KEEP_PACKAGE_TEST_TMP === '1';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  });

  if (result.status !== 0) {
    throw new Error([
      `$ ${command} ${args.join(' ')}`,
      result.stdout.trim(),
      result.stderr.trim(),
    ].filter(Boolean).join('\n'));
  }

  return result;
}

const tempRoot = await mkdtemp(join(tmpdir(), 'ardur-news-aggregator-pack-'));

try {
  const packResult = run('npm', ['pack', '--json', '--pack-destination', tempRoot]);
  const [{ filename }] = JSON.parse(packResult.stdout);
  const tarballPath = join(tempRoot, filename);
  const consumerRoot = join(tempRoot, 'consumer');
  await mkdir(consumerRoot);

  run('npm', ['init', '-y'], { cwd: consumerRoot });
  run('npm', ['install', tarballPath], { cwd: consumerRoot });

  const packageRoot = join(consumerRoot, 'node_modules', '@ardurai', 'news-aggregator');
  const sourceCatalog = JSON.parse(await readFile(join(packageRoot, 'data', 'sources.json'), 'utf8'));
  if (!Array.isArray(sourceCatalog) || sourceCatalog.length < 100) {
    throw new Error(`Expected packaged data/sources.json to include the source catalog; got ${sourceCatalog.length}`);
  }

  const importCheck = run(process.execPath, [
    '--input-type=module',
    '-e',
    [
      "import { runAggregation, SCHEMA_VERSION, CONTRACT_REVISION } from '@ardurai/news-aggregator';",
      "if (typeof runAggregation !== 'function') throw new Error('runAggregation export missing');",
      "if (SCHEMA_VERSION !== 'ardur-content-pipeline/v1') throw new Error(`Unexpected schema version ${SCHEMA_VERSION}`);",
      "if (CONTRACT_REVISION < 3) throw new Error(`Unexpected contract revision ${CONTRACT_REVISION}`);",
      "console.log(JSON.stringify({ ok: true, schemaVersion: SCHEMA_VERSION, contractRevision: CONTRACT_REVISION }));",
    ].join(' '),
  ], { cwd: consumerRoot });

  const exported = JSON.parse(importCheck.stdout);
  if (exported.ok !== true) {
    throw new Error('Package import smoke check failed');
  }

  const describeResult = run('npx', ['--no-install', 'ardur-news-aggregator', '--describe'], {
    cwd: consumerRoot,
  });
  const described = JSON.parse(describeResult.stdout);
  if (described.stage !== 'aggregation') {
    throw new Error(`Expected runner stage aggregation; got ${described.stage}`);
  }

  const noNetworkResult = run('npx', [
    '--no-install',
    'ardur-news-aggregator',
    '--no-network',
    '--now',
    '2026-06-11T00:00:00.000Z',
    '--run-id',
    'package-smoke',
  ], { cwd: consumerRoot });
  const artifact = JSON.parse(noNetworkResult.stdout);
  if (artifact.artifact !== 'aggregation' || artifact.runId !== 'package-smoke') {
    throw new Error('Installed runner did not emit the expected hermetic aggregation artifact');
  }

  console.log(JSON.stringify({
    ok: true,
    tarball: filename,
    sourceCatalogEntries: sourceCatalog.length,
    schemaVersion: exported.schemaVersion,
    contractRevision: exported.contractRevision,
  }));
} finally {
  if (keepTemp) {
    console.error(`[verify-package-install] kept temp root: ${tempRoot}`);
  } else {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
