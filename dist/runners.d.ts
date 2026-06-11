#!/usr/bin/env node
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
import { type AggregationArtifact } from '@ardurai/contracts';
export interface DescribeOutput {
    name: string;
    stage: 'aggregation';
    contract: {
        schemaVersion: string;
        contractRevision: number;
    };
    input: null;
    output: object;
    flags: Record<string, object>;
}
export declare function buildDescribeOutput(): DescribeOutput;
export interface StructuredErrorEnvelope {
    error: {
        code: string;
        message: string;
        stage: 'aggregation';
        detail?: unknown;
    };
}
export declare function classifyError(err: unknown): StructuredErrorEnvelope['error'];
export declare function deriveRunId(nowIso: string): string;
export declare function buildHermeticArtifact(now: Date, runId: string): AggregationArtifact;
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
export declare function parseRunnerArgs(argv: string[]): ParsedRunnerArgs;
