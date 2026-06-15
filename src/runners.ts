/**
 * runners.ts — Uniform agent-readiness CLI entry point for ardur-news-aggregator.
 *
 * All agent-facing invocations of this engine go through this module.
 * Implements the Hermes agent-layer interface contract (G1–G6, G9, G10):
 *
 *   --in  <path|->   Accepted but ignored (Stage 1 has no upstream input)
 *   --out <path|->   Write artifact to path, or stdout when omitted or '-'
 *   --provider <n>   AI provider: deterministic|ollama|openai (default: env / deterministic)
 *   --now <iso>      Pin wall-clock; drives cycle window + generatedAt deterministically
 *   --run-id <id>    Pin runId; combined with --now → byte-identical output on repeat runs
 *   --describe       Emit engine schema spec (derived from @ardurai/contracts) and exit
 *   --json-errors    Emit structured error envelope { error:{code,message,stage,detail} } to stdout on failure
 *   --no-network     Skip all live network calls; return a hermetic empty artifact for testing
 *   --fixtures <dir> Reserved: read canned feeds from directory (implies --no-network)
 *
 * All logs go to stderr. The JSON artifact (or --describe output) goes to stdout.
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runAggregation } from './index.ts';
import {
  SCHEMA_VERSION,
  CONTRACT_REVISION,
  type AggregationArtifact,
} from '@ardurai/contracts';
import { parseAggregationArtifact } from '@ardurai/contracts/zod';

// ---------------------------------------------------------------------------
// --describe: engine schema spec derived from @ardurai/contracts constants
// ---------------------------------------------------------------------------

export interface DescribeOutput {
  name: string;
  stage: 'aggregation';
  contract: { schemaVersion: string; contractRevision: number };
  input: null;
  output: object;
  flags: Record<string, object>;
}

export function buildDescribeOutput(): DescribeOutput {
  return {
    name: 'news-aggregator',
    stage: 'aggregation',
    contract: {
      schemaVersion: SCHEMA_VERSION,
      contractRevision: CONTRACT_REVISION,
    },
    input: null,
    output: {
      $schema: 'https://json-schema.org/draft-07/schema',
      type: 'object',
      required: [
        'schemaVersion', 'contractRevision', 'artifact', 'runId',
        'upstreamRunId', 'generatedAt', 'cycle', 'topics', 'warnings', 'data',
      ],
      properties: {
        schemaVersion: { type: 'string', enum: [SCHEMA_VERSION] },
        contractRevision: {
          type: 'integer',
          description: `Current producer revision: ${CONTRACT_REVISION}`,
        },
        artifact: { type: 'string', enum: ['aggregation'] },
        runId: {
          type: 'string',
          description: 'UUID; byte-deterministic when --run-id is supplied',
        },
        upstreamRunId: { type: ['string', 'null'] },
        generatedAt: { type: 'string', format: 'date-time', description: 'Pinned by --now' },
        cycle: {
          type: 'object',
          required: ['id', 'windowStart', 'windowEnd'],
          properties: {
            id: { type: 'string', format: 'date-time' },
            windowStart: { type: 'string', format: 'date-time' },
            windowEnd: {
              type: 'string',
              format: 'date-time',
              description: 'windowStart + 6h',
            },
          },
        },
        topics: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'label', 'description'],
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              description: { type: 'string' },
            },
          },
        },
        warnings: { type: 'array', items: { type: 'string' } },
        data: {
          type: 'object',
          required: ['itemsByTopic', 'clustersByTopic', 'coverageByTopic'],
          description: `AggregationData (contractRevision=${CONTRACT_REVISION})`,
          properties: {
            itemsByTopic: {
              type: 'object',
              description: 'Record<topicId, AggregatedItem[]> — all items, no source ceiling',
              additionalProperties: { type: 'array' },
            },
            clustersByTopic: {
              type: 'object',
              description: 'Record<topicId, Cluster[]>',
              additionalProperties: { type: 'array' },
            },
            coverageByTopic: {
              type: 'object',
              description: 'Record<topicId, SourceCoverage>',
              additionalProperties: { type: 'object' },
            },
            documentsByTopic: {
              type: 'object',
              description: '(ETL / Rev 3) Record<topicId, SourceDocument[]>',
              additionalProperties: { type: 'array' },
            },
            factsByCluster: {
              type: 'object',
              description: '(ETL / Rev 3) Record<clusterId, ExtractedFact[]>',
              additionalProperties: { type: 'array' },
            },
          },
        },
      },
    },
    flags: {
      '--in': {
        type: 'string',
        description: 'Ignored: Stage 1 has no upstream input; accepted for uniform orchestration',
      },
      '--out': { type: 'string', default: '-', description: 'Output path or - for stdout' },
      '--provider': {
        type: 'string',
        enum: ['deterministic', 'ollama', 'openai'],
        default: 'deterministic',
        description: 'AI provider override (also: ARDUR_AI_PROVIDER env var)',
      },
      '--now': {
        type: 'string',
        format: 'date-time',
        description: 'Pin wall-clock; makes cycle window and generatedAt deterministic',
      },
      '--run-id': {
        type: 'string',
        description: 'Pin runId; combined with --now yields byte-identical output on repeat runs',
      },
      '--describe': { type: 'boolean', description: 'Print this schema spec and exit' },
      '--json-errors': {
        type: 'boolean',
        description: 'Emit structured JSON error envelope to stdout on failure',
      },
      '--no-network': {
        type: 'boolean',
        description: 'Skip all live network calls; return hermetic empty artifact for testing',
      },
      '--fixtures': {
        type: 'string',
        description: 'Canned-feed directory (implies --no-network; reserved for future use)',
      },
      '--etl': { type: 'boolean', description: 'Enable full ETL (fetch bodies + extract facts)' },
      '--etl-budget': {
        type: 'integer',
        default: 30,
        description: 'Max article fetches per topic during ETL',
      },
      '--max-age-hours': {
        type: 'number',
        default: 36,
        description: 'Discard feed items older than N hours',
      },
      '--timeout': {
        type: 'integer',
        default: 15000,
        description: 'Per-source fetch timeout in ms',
      },
      '--concurrency': {
        type: 'integer',
        default: 10,
        description: 'Max concurrent source fetches',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Structured error envelope
// ---------------------------------------------------------------------------

export interface StructuredErrorEnvelope {
  error: {
    code: string;
    message: string;
    stage: 'aggregation';
    detail?: unknown;
  };
}

export function classifyError(err: unknown): StructuredErrorEnvelope['error'] {
  if (err instanceof Error) {
    const msg = err.message;
    let code = 'UNKNOWN_ERROR';
    if (/fetch|ECONNREFUSED|ENOTFOUND|timeout|ETIMEDOUT/i.test(msg)) {
      code = 'NETWORK_ERROR';
    } else if (/JSON|parse|Unexpected token/i.test(msg)) {
      code = 'PARSE_ERROR';
    } else if (/schema|Schema|schemaVersion/i.test(msg)) {
      code = 'SCHEMA_ERROR';
    }
    return { code, message: msg, stage: 'aggregation', detail: { stack: err.stack } };
  }
  return { code: 'UNKNOWN_ERROR', message: String(err), stage: 'aggregation' };
}

// ---------------------------------------------------------------------------
// Deterministic runId derivation (when --run-id not supplied but --now is)
// ---------------------------------------------------------------------------

export function deriveRunId(nowIso: string): string {
  return createHash('sha256')
    .update(`ardur-news-aggregator:${nowIso}`)
    .digest('hex')
    .slice(0, 32);
}

// ---------------------------------------------------------------------------
// Hermetic (no-network) artifact
// ---------------------------------------------------------------------------

const CYCLE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function buildHermeticArtifact(now: Date, runId: string): AggregationArtifact {
  const cycleMs = now.valueOf() - (now.valueOf() % CYCLE_INTERVAL_MS);
  const windowStart = new Date(cycleMs);
  const windowEnd = new Date(cycleMs + CYCLE_INTERVAL_MS);
  return {
    schemaVersion: SCHEMA_VERSION,
    contractRevision: CONTRACT_REVISION,
    artifact: 'aggregation',
    runId,
    upstreamRunId: null,
    generatedAt: now.toISOString(),
    cycle: {
      id: windowStart.toISOString(),
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
    },
    topics: [],
    warnings: ['[no-network] all live network calls skipped; artifact is intentionally empty'],
    data: { itemsByTopic: {}, clustersByTopic: {}, coverageByTopic: {} },
  };
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export interface ParsedRunnerArgs {
  inPath: string | null;
  outPath: string | null;
  provider: string;
  nowIso: string | null;
  runId: string | null;
  doDescribe: boolean;
  jsonErrors: boolean;
  noNetwork: boolean;
  fixturesDir: string | null;
  etlEnabled: boolean;
  etlFetchBudgetPerTopic: number;
  maxAgeHours: number;
  timeoutMs: number;
  concurrency: number;
}

export function parseRunnerArgs(argv: string[]): ParsedRunnerArgs {
  let inPath: string | null = null;
  let outPath: string | null = null;
  let provider = process.env['ARDUR_AI_PROVIDER'] ?? 'deterministic';
  let nowIso: string | null = null;
  let runId: string | null = null;
  let doDescribe = false;
  let jsonErrors = false;
  let noNetwork = false;
  let fixturesDir: string | null = null;
  let etlEnabled = process.env['ARDUR_ETL_ENABLED'] === 'true';
  let etlFetchBudgetPerTopic = 30;
  let maxAgeHours = 36;
  let timeoutMs = 15_000;
  let concurrency = 10;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    if (a === '--in' && next !== undefined) {
      inPath = next === '-' ? null : next;
      i++;
    } else if (a === '--out' && next !== undefined) {
      outPath = next === '-' ? null : next;
      i++;
    } else if (a === '--provider' && next !== undefined) {
      provider = next;
      i++;
    } else if (a === '--now' && next !== undefined) {
      nowIso = next;
      i++;
    } else if (a === '--run-id' && next !== undefined) {
      runId = next;
      i++;
    } else if (a === '--describe') {
      doDescribe = true;
    } else if (a === '--json-errors') {
      jsonErrors = true;
    } else if (a === '--no-network') {
      noNetwork = true;
    } else if (a === '--fixtures' && next !== undefined) {
      fixturesDir = next;
      noNetwork = true;
      i++;
    } else if (a === '--etl') {
      etlEnabled = true;
    } else if (a === '--etl-budget' && next !== undefined) {
      const parsed = Number(next);
      etlFetchBudgetPerTopic = Number.isFinite(parsed) ? parsed : 30;
      i++;
    } else if (a === '--max-age-hours' && next !== undefined) {
      const parsed = Number(next);
      maxAgeHours = Number.isFinite(parsed) ? parsed : 36;
      i++;
    } else if (a === '--timeout' && next !== undefined) {
      const parsed = Number(next);
      timeoutMs = Number.isFinite(parsed) ? parsed : 15_000;
      i++;
    } else if (a === '--concurrency' && next !== undefined) {
      const parsed = Number(next);
      concurrency = Number.isFinite(parsed) ? parsed : 10;
      i++;
    }
  }

  return {
    inPath,
    outPath,
    provider,
    nowIso,
    runId,
    doDescribe,
    jsonErrors,
    noNetwork,
    fixturesDir,
    etlEnabled,
    etlFetchBudgetPerTopic,
    maxAgeHours,
    timeoutMs,
    concurrency,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseRunnerArgs(process.argv.slice(2));

  if (args.doDescribe) {
    process.stdout.write(JSON.stringify(buildDescribeOutput(), null, 2) + '\n');
    return;
  }

  let now: Date;
  if (args.nowIso) {
    try {
      const parsed = new Date(args.nowIso);
      if (!Number.isFinite(parsed.valueOf())) {
        throw new RangeError(`Invalid date: "${args.nowIso}"`);
      }
      // Call toISOString() here to surface any RangeError from invalid dates early.
      parsed.toISOString();
      now = parsed;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (args.jsonErrors) {
        const envelope: StructuredErrorEnvelope = {
          error: { code: 'INVALID_ARGUMENT', message: `--now: ${msg}`, stage: 'aggregation' },
        };
        process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
      } else {
        process.stderr.write(`[ardur-news-aggregator] --now: invalid date "${args.nowIso}": ${msg}\n`);
      }
      process.exitCode = 1;
      return;
    }
  } else {
    now = new Date();
  }
  const resolvedRunId =
    args.runId ?? (args.nowIso ? deriveRunId(args.nowIso) : undefined);

  if (args.provider !== 'deterministic') {
    process.env['ARDUR_AI_PROVIDER'] = args.provider;
  }

  if (args.fixturesDir !== null) {
    process.stderr.write(
      '[ardur-news-aggregator] --fixtures is reserved for future implementation; ' +
        'running in --no-network mode\n',
    );
  }

  process.stderr.write(
    `[ardur-news-aggregator] starting cycle at ${now.toISOString()}` +
      (args.noNetwork ? ' (no-network/hermetic)' : '') +
      '\n',
  );

  let artifact: AggregationArtifact;

  try {
    if (args.noNetwork) {
      const pinned = resolvedRunId ?? deriveRunId(now.toISOString());
      artifact = buildHermeticArtifact(now, pinned);
    } else {
      artifact = await runAggregation({
        now,
        ...(resolvedRunId !== undefined ? { runId: resolvedRunId } : {}),
        maxAgeMs: args.maxAgeHours * 60 * 60 * 1000,
        perSourceTimeoutMs: args.timeoutMs,
        concurrency: args.concurrency,
        etlEnabled: args.etlEnabled,
        etlFetchBudgetPerTopic: args.etlFetchBudgetPerTopic,
      });
    }
  } catch (err: unknown) {
    if (args.jsonErrors) {
      const envelope: StructuredErrorEnvelope = { error: classifyError(err) };
      process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
    } else {
      process.stderr.write(
        `[ardur-news-aggregator] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    process.exitCode = 1;
    return;
  }

  // Contracts #2: Zod-validate the produced artifact before writing (fail-fast on schema regression).
  try {
    parseAggregationArtifact(artifact);
  } catch (parseErr: unknown) {
    if (args.jsonErrors) {
      const envelope: StructuredErrorEnvelope = { error: classifyError(parseErr) };
      process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
    } else {
      process.stderr.write(
        `[ardur-news-aggregator] schema error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}\n`,
      );
    }
    process.exitCode = 1;
    return;
  }

  // #22: A5 violations are fail-CLOSED — non-zero exit so CI catches copyright regressions.
  const a5Violations = artifact.warnings.filter((w) => w.startsWith('[A5]'));
  if (a5Violations.length > 0) {
    process.stderr.write(
      `[ardur-news-aggregator] ${a5Violations.length} A5 copyright violation(s) detected — exiting non-zero\n`,
    );
    process.exitCode = 1;
  }

  const json = JSON.stringify(artifact, null, 2) + '\n';
  if (args.outPath !== null) {
    writeFileSync(args.outPath, json, 'utf-8');
    process.stderr.write(
      `[ardur-news-aggregator] wrote ${json.length} bytes → ${args.outPath}\n`,
    );
  } else {
    process.stdout.write(json);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`[engine] unhandled: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
