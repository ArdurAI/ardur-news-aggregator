/**
 * Fact extraction providers.
 *
 * Providers sit below the A4 aggregator orchestration and return candidate fact
 * JSON only. They never fetch source URLs, create ExtractedFact ids, attach
 * provenance, run the shared Zod schema, enforce copyright gates, or decide
 * fallback behavior.
 */

import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { SourceDocument } from './contracts-v3.ts';

export type FactExtractionProviderMode = 'deterministic' | 'ollama' | 'openai' | 'hermes';

export const FACT_PROVIDER_MODES: readonly FactExtractionProviderMode[] = [
  'deterministic',
  'ollama',
  'openai',
  'hermes',
];

export function isAiProviderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['ARDUR_AI_ENABLED'];
  if (raw === undefined) return true;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

export function resolveFactExtractionProviderMode(
  explicitMode?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): FactExtractionProviderMode {
  if (!isAiProviderEnabled(env)) return 'deterministic';
  const candidate = explicitMode ?? env['ARDUR_AI_PROVIDER'] ?? 'deterministic';
  return isFactExtractionProviderMode(candidate) ? candidate : 'deterministic';
}

export interface CandidateQuantityJson {
  metric: string;
  value: number;
  unit?: string;
  asOf?: string;
}

export interface CandidateFactJson {
  /** Atomic original-expression fact candidate. Aggregator may drop/normalize. */
  statement?: unknown;
  entities?: unknown;
  quantity?: unknown;
  /** Optional verbatim support. Aggregator enforces <=25 words and may omit/drop. */
  quote?: unknown;
  confidence?: unknown;
}

export interface CandidateFactPayloadJson {
  facts?: unknown;
}

export interface FactCandidateRequest {
  contractVersion: 'fact-candidate/v1';
  providerMode: FactExtractionProviderMode;
  topic: string;
  clusterId: string;
  nowIso: string;
  source: Pick<SourceDocument,
    'id' | 'title' | 'sourceDomain' | 'url' | 'extraction' | 'accessPolicy' | 'contentHash'
  >;
  /** Body text was already fetched/stored/gated by the aggregator. */
  body: string;
  /** Aggregator-owned prompt/schema keep safety and shape rules centralized. */
  prompt: string;
  responseSchema: object;
  timeoutMs: number;
  maxOutputTokens?: number;
}

export interface FactProviderSuccess {
  ok: true;
  provider: FactExtractionProviderMode;
  model: string;
  /** Candidate JSON only; not ExtractedFact[] and not Zod-validated. */
  candidateJson: CandidateFactPayloadJson | unknown;
  rawText?: string;
  durationMs: number;
  attempts: number;
}

export interface FactProviderFailure {
  ok: false;
  provider: FactExtractionProviderMode;
  model?: string;
  errorKind:
    | 'disabled'
    | 'timeout'
    | 'network'
    | 'http'
    | 'auth'
    | 'rate_limit'
    | 'bad_response'
    | 'unsupported_provider';
  message: string;
  retryable: boolean;
  durationMs: number;
  attempts: number;
}

export type FactProviderOutcome = FactProviderSuccess | FactProviderFailure;

export interface FactCandidateProvider {
  readonly mode: FactExtractionProviderMode;
  readonly model: string;
  extractCandidates(
    request: FactCandidateRequest,
    signal?: AbortSignal,
  ): Promise<FactProviderOutcome>;
}

export interface HermesCommandRunnerInput {
  command: string;
  args: string[];
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface HermesCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
}

export interface FactProviderConfig {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxOutputTokens?: number;

  ollamaHost?: string;
  ollamaModel?: string;
  ollamaApiKey?: string;

  openaiApiKey?: string;
  openaiModel?: string;
  openaiBaseUrl?: string;

  hermesCommand?: string;
  hermesArgs?: string[];
  hermesModel?: string;
  hermesCommandRunner?: (input: HermesCommandRunnerInput) => Promise<HermesCommandResult>;
}

// ── Provider mode helpers ────────────────────────────────────────────────────

export function isFactExtractionProviderMode(value: unknown): value is FactExtractionProviderMode {
  return typeof value === 'string' && FACT_PROVIDER_MODES.includes(value as FactExtractionProviderMode);
}

export function createFactCandidateProvider(
  mode: FactExtractionProviderMode,
  config: FactProviderConfig = {},
): FactCandidateProvider {
  switch (mode) {
    case 'deterministic':
      return new DeterministicFactCandidateProvider(config);
    case 'ollama':
      return new OllamaFactCandidateProvider(config);
    case 'openai':
      return new OpenAiFactCandidateProvider(config);
    case 'hermes':
      return new HermesFactCandidateProvider(config);
    default: {
      const _exhaustive: never = mode;
      throw new Error(`unsupported fact provider: ${String(_exhaustive)}`);
    }
  }
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function elapsedMs(start: number): number {
  return Math.max(0, Math.round(performance.now() - start));
}

function makeFailure(
  provider: FactExtractionProviderMode,
  errorKind: FactProviderFailure['errorKind'],
  message: string,
  retryable: boolean,
  start: number,
  attempts: number,
  model?: string,
): FactProviderFailure {
  const failure: FactProviderFailure = {
    ok: false,
    provider,
    errorKind,
    message,
    retryable,
    durationMs: elapsedMs(start),
    attempts,
  };
  if (model !== undefined) failure.model = model;
  return failure;
}

function makeSuccess(
  provider: FactExtractionProviderMode,
  model: string,
  candidateJson: unknown,
  start: number,
  attempts: number,
  rawText?: string,
): FactProviderSuccess {
  const success: FactProviderSuccess = {
    ok: true,
    provider,
    model,
    candidateJson,
    durationMs: elapsedMs(start),
    attempts,
  };
  if (rawText !== undefined) success.rawText = rawText;
  return success;
}

function timeoutMsFor(request: FactCandidateRequest, configured?: number): number {
  const value = configured ?? request.timeoutMs;
  return Number.isFinite(value) && value >= 0 ? value : 60_000;
}

function maxOutputTokensFor(request: FactCandidateRequest, configured?: number): number {
  const value = configured ?? request.maxOutputTokens ?? 2_048;
  return Number.isFinite(value) && value > 0 ? value : 2_048;
}

function signalWithTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (signal === undefined) return timeoutSignal;
  return AbortSignal.any([signal, timeoutSignal]);
}

function isAbortLikeError(err: unknown): boolean {
  return err instanceof Error && /AbortError|TimeoutError|aborted|timeout/i.test(`${err.name} ${err.message}`);
}

function parseJsonText(rawText: string): unknown | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(unfenced) as unknown;
  } catch {
    return null;
  }
}

function httpFailureKind(status: number): {
  kind: FactProviderFailure['errorKind'];
  retryable: boolean;
} {
  if (status === 401 || status === 403) return { kind: 'auth', retryable: false };
  if (status === 429) return { kind: 'rate_limit', retryable: true };
  return { kind: 'http', retryable: status >= 500 };
}

function textFromOpenAiResponse(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj['output_text'] === 'string') return obj['output_text'];

  const output = obj['output'];
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!item || typeof item !== 'object') continue;
      const content = (item as Record<string, unknown>)['content'];
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const text = (part as Record<string, unknown>)['text'];
        if (typeof text === 'string') return text;
      }
    }
  }

  // Compatible with chat-completions-like fixtures if a custom OpenAI-compatible
  // endpoint returns that shape.
  const choices = obj['choices'];
  if (Array.isArray(choices)) {
    const first = choices[0];
    if (first && typeof first === 'object') {
      const message = (first as Record<string, unknown>)['message'];
      if (message && typeof message === 'object') {
        const content = (message as Record<string, unknown>)['content'];
        if (typeof content === 'string') return content;
      }
    }
  }

  return null;
}

// ── Deterministic provider ───────────────────────────────────────────────────

const NUMBER_WITH_UNIT_RE = /(\b\d[\d,.]*\s*(?:billion|million|thousand|trillion|%|percent|ms|GB|TB|MB|KB|K|B|M|T|x|×)\b)/gi;
const NAMED_ENTITY_RE = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/g;
const IMPORTANT_DOMAINS_RE = /\b(OpenAI|Anthropic|Google|Microsoft|Amazon|NVIDIA|Meta|Apple|Kubernetes|CNCF|GitHub)\b/gi;

export class DeterministicFactCandidateProvider implements FactCandidateProvider {
  readonly mode = 'deterministic' as const;
  readonly model = 'regex-v1';

  constructor(_config: FactProviderConfig = {}) {}

  async extractCandidates(request: FactCandidateRequest): Promise<FactProviderOutcome> {
    const start = performance.now();
    const facts: CandidateFactJson[] = [];
    const seen = new Set<string>();
    const sentences = request.body
      .split(/(?<=[.!?])\s+/)
      .filter((s) => s.length > 30 && s.length < 500);

    for (const sentence of sentences.slice(0, 20)) {
      const domainEntities: string[] = [];
      for (const match of sentence.matchAll(IMPORTANT_DOMAINS_RE)) {
        const entity = (match[0] ?? '').trim();
        if (entity) domainEntities.push(entity);
      }

      const namedEntities: string[] = [];
      for (const match of sentence.matchAll(NAMED_ENTITY_RE)) {
        const entity = (match[0] ?? '').trim();
        if (
          entity.length > 3 &&
          !domainEntities.some((domainEntity) => domainEntity.toLowerCase() === entity.toLowerCase())
        ) {
          namedEntities.push(entity);
        }
      }

      const numbers = [...sentence.matchAll(NUMBER_WITH_UNIT_RE)].map((match) => match[0] ?? '');
      const allEntities = [...domainEntities, ...namedEntities];
      if (allEntities.length === 0 && numbers.length === 0) continue;

      const primaryEntity = allEntities[0] ?? request.topic;
      let statement: string;
      if (numbers.length > 0 && numbers[0]) {
        statement = `${primaryEntity}: ${numbers[0]}`;
      } else if (allEntities.length >= 2) {
        statement = `${allEntities[0]} and ${allEntities[1]}`;
      } else {
        statement = `${primaryEntity} — ${request.topic}`;
      }
      statement = statement.replace(/\s+/g, ' ').trim().slice(0, 80);

      const key = statement.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const sentenceWords = sentence.trim().match(/\S+/g) ?? [];
      const quoteWords = sentenceWords.slice(0, 20);
      const quote = quoteWords.join(' ') + (sentenceWords.length > 20 ? '…' : '');

      const candidate: CandidateFactJson = {
        statement,
        entities: [...new Set([...domainEntities, ...namedEntities])].slice(0, 8),
        quote,
        confidence: 'low',
      };

      if (numbers.length > 0 && numbers[0]) {
        const value = parseFloat(numbers[0].replace(/[^\d.]/g, ''));
        if (!Number.isNaN(value)) {
          candidate.quantity = { metric: primaryEntity, value };
        }
      }

      facts.push(candidate);
      if (facts.length >= 8) break;
    }

    return makeSuccess(this.mode, this.model, { facts }, start, 1);
  }
}

// ── Ollama provider ──────────────────────────────────────────────────────────

export class OllamaFactCandidateProvider implements FactCandidateProvider {
  readonly mode = 'ollama' as const;
  readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly host: string;
  private readonly apiKey: string | undefined;
  private readonly configuredTimeoutMs: number | undefined;
  private readonly configuredMaxOutputTokens: number | undefined;

  constructor(config: FactProviderConfig = {}) {
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.host = config.ollamaHost ?? process.env['OLLAMA_HOST'] ?? 'http://localhost:11434';
    this.model = config.ollamaModel ?? process.env['OLLAMA_MODEL'] ?? 'llama3.1:8b';
    this.apiKey = config.ollamaApiKey ?? process.env['OLLAMA_API_KEY'];
    this.configuredTimeoutMs = config.timeoutMs ?? numberFromEnv('OLLAMA_TIMEOUT_MS');
    this.configuredMaxOutputTokens = config.maxOutputTokens;
  }

  async extractCandidates(
    request: FactCandidateRequest,
    signal?: AbortSignal,
  ): Promise<FactProviderOutcome> {
    const start = performance.now();
    const timeoutMs = timeoutMsFor(request, this.configuredTimeoutMs);
    const endpoint = `${this.host.replace(/\/$/, '')}/api/generate`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey !== undefined && this.apiKey.length > 0) {
      headers['authorization'] = `Bearer ${this.apiKey}`;
    }

    try {
      const resp = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          prompt: request.prompt,
          format: request.responseSchema,
          stream: false,
          options: {
            temperature: 0.1,
            num_predict: maxOutputTokensFor(request, this.configuredMaxOutputTokens),
          },
        }),
        signal: signalWithTimeout(timeoutMs, signal),
      });

      if (!resp.ok) {
        const { kind, retryable } = httpFailureKind(resp.status);
        return makeFailure(this.mode, kind, `Ollama HTTP ${resp.status}`, retryable, start, 1, this.model);
      }

      const data = (await resp.json()) as { response?: unknown };
      if (typeof data.response !== 'string') {
        return makeFailure(this.mode, 'bad_response', 'Ollama response missing response text', false, start, 1, this.model);
      }

      const candidateJson = parseJsonText(data.response);
      if (candidateJson === null) {
        return makeFailure(this.mode, 'bad_response', 'Ollama response was not candidate JSON', false, start, 1, this.model);
      }

      return makeSuccess(this.mode, this.model, candidateJson, start, 1, data.response);
    } catch (err: unknown) {
      if (isAbortLikeError(err)) {
        return makeFailure(this.mode, 'timeout', `Ollama timed out after ${timeoutMs}ms`, true, start, 1, this.model);
      }
      return makeFailure(
        this.mode,
        'network',
        `Ollama request failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
        start,
        1,
        this.model,
      );
    }
  }
}

// ── OpenAI provider ──────────────────────────────────────────────────────────

export class OpenAiFactCandidateProvider implements FactCandidateProvider {
  readonly mode = 'openai' as const;
  readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly configuredTimeoutMs: number | undefined;
  private readonly configuredMaxOutputTokens: number | undefined;

  constructor(config: FactProviderConfig = {}) {
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.apiKey = config.openaiApiKey ?? process.env['ARDUR_OPENAI_API_KEY'] ?? process.env['OPENAI_API_KEY'];
    this.model = config.openaiModel ?? process.env['ARDUR_OPENAI_MODEL'] ?? process.env['OPENAI_MODEL'] ?? 'gpt-4o-mini';
    this.baseUrl = config.openaiBaseUrl ?? process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1';
    this.configuredTimeoutMs = config.timeoutMs ?? numberFromEnv('ARDUR_AI_TIMEOUT_MS');
    this.configuredMaxOutputTokens = config.maxOutputTokens;
  }

  async extractCandidates(
    request: FactCandidateRequest,
    signal?: AbortSignal,
  ): Promise<FactProviderOutcome> {
    const start = performance.now();
    const timeoutMs = timeoutMsFor(request, this.configuredTimeoutMs);

    if (this.apiKey === undefined || this.apiKey.length === 0) {
      return makeFailure(this.mode, 'disabled', 'OpenAI fact provider requires OPENAI_API_KEY', false, start, 1, this.model);
    }

    try {
      const resp = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: request.prompt,
          max_output_tokens: maxOutputTokensFor(request, this.configuredMaxOutputTokens),
          text: {
            format: {
              type: 'json_schema',
              name: 'fact_candidates',
              schema: request.responseSchema,
              strict: false,
            },
          },
          tools: [],
        }),
        signal: signalWithTimeout(timeoutMs, signal),
      });

      if (!resp.ok) {
        const { kind, retryable } = httpFailureKind(resp.status);
        return makeFailure(this.mode, kind, `OpenAI HTTP ${resp.status}`, retryable, start, 1, this.model);
      }

      const data = (await resp.json()) as unknown;
      const rawText = textFromOpenAiResponse(data);
      if (rawText === null) {
        return makeFailure(this.mode, 'bad_response', 'OpenAI response missing output text', false, start, 1, this.model);
      }

      const candidateJson = parseJsonText(rawText);
      if (candidateJson === null) {
        return makeFailure(this.mode, 'bad_response', 'OpenAI output was not candidate JSON', false, start, 1, this.model);
      }

      return makeSuccess(this.mode, this.model, candidateJson, start, 1, rawText);
    } catch (err: unknown) {
      if (isAbortLikeError(err)) {
        return makeFailure(this.mode, 'timeout', `OpenAI timed out after ${timeoutMs}ms`, true, start, 1, this.model);
      }
      return makeFailure(
        this.mode,
        'network',
        `OpenAI request failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
        start,
        1,
        this.model,
      );
    }
  }
}

// ── Hermes provider ──────────────────────────────────────────────────────────

export class HermesFactCandidateProvider implements FactCandidateProvider {
  readonly mode = 'hermes' as const;
  readonly model: string;
  private readonly command: string;
  private readonly args: string[];
  private readonly commandRunner: (input: HermesCommandRunnerInput) => Promise<HermesCommandResult>;
  private readonly configuredTimeoutMs: number | undefined;

  constructor(config: FactProviderConfig = {}) {
    this.model = config.hermesModel ?? process.env['HERMES_FACT_EXTRACT_MODEL'] ?? 'hermes-agent';
    this.command = config.hermesCommand ?? process.env['HERMES_FACT_EXTRACT_COMMAND'] ?? 'hermes';
    this.args = config.hermesArgs ?? parseCommandArgs(process.env['HERMES_FACT_EXTRACT_ARGS']) ?? [
      'chat',
      '-Q',
      '--toolsets',
      'safe',
      '--query',
      '{prompt}',
    ];
    this.commandRunner = config.hermesCommandRunner ?? runHermesCommand;
    this.configuredTimeoutMs = config.timeoutMs ?? numberFromEnv('ARDUR_AI_TIMEOUT_MS');
  }

  async extractCandidates(
    request: FactCandidateRequest,
    signal?: AbortSignal,
  ): Promise<FactProviderOutcome> {
    const start = performance.now();
    const timeoutMs = timeoutMsFor(request, this.configuredTimeoutMs);
    const prompt = buildHermesCandidatePrompt(request);
    const args = this.args.map((arg) => arg.replaceAll('{prompt}', prompt));

    try {
      const result = await this.commandRunner({
        command: this.command,
        args,
        prompt,
        timeoutMs,
        ...(signal !== undefined ? { signal } : {}),
      });

      if (result.timedOut) {
        return makeFailure(this.mode, 'timeout', `Hermes timed out after ${timeoutMs}ms`, true, start, 1, this.model);
      }
      if (result.exitCode !== 0) {
        const exitLabel = result.exitCode === null ? 'unknown' : String(result.exitCode);
        return makeFailure(
          this.mode,
          'bad_response',
          `Hermes command failed with exit code ${exitLabel}`,
          false,
          start,
          1,
          this.model,
        );
      }

      const candidateJson = parseJsonText(result.stdout);
      if (candidateJson === null) {
        return makeFailure(this.mode, 'bad_response', 'Hermes output was not candidate JSON', false, start, 1, this.model);
      }

      return makeSuccess(this.mode, this.model, candidateJson, start, 1, result.stdout);
    } catch (err: unknown) {
      if (isAbortLikeError(err)) {
        return makeFailure(this.mode, 'timeout', `Hermes timed out after ${timeoutMs}ms`, true, start, 1, this.model);
      }
      return makeFailure(
        this.mode,
        'network',
        `Hermes command failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
        start,
        1,
        this.model,
      );
    }
  }
}

function buildHermesCandidatePrompt(request: FactCandidateRequest): string {
  return `${request.prompt}

Provider contract reminder:
- You are transforming an already-approved article body into candidate fact JSON.
- Do not browse, fetch URLs, read files, call tools, inspect pipeline state, or access any source outside the prompt.
- Do not create ExtractedFact ids, attach provenance, run schema validation, enforce copyright rules, or decide fallback behavior.
- Return only JSON matching this candidate shape: {"facts":[{"statement":"...","entities":["..."],"quantity":{"metric":"...","value":1},"quote":"...","confidence":"high|medium|low"}]}.

Source correlation fields (do not fetch the URL):
${JSON.stringify({
    id: request.source.id,
    title: request.source.title,
    sourceDomain: request.source.sourceDomain,
    contentHash: request.source.contentHash,
    extraction: request.source.extraction,
    accessPolicy: request.source.accessPolicy,
    topic: request.topic,
    clusterId: request.clusterId,
    nowIso: request.nowIso,
  })}

Return only JSON.`;
}

function parseCommandArgs(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')) {
      return parsed;
    }
  } catch {
    // Fall through to simple whitespace split.
  }
  return raw.split(/\s+/).filter(Boolean);
}

function runHermesCommand(input: HermesCommandRunnerInput): Promise<HermesCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const stdoutLimit = 1_000_000;
    const stderrLimit = 100_000;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({ stdout, stderr, exitCode: null, timedOut: true });
    }, input.timeoutMs);

    const abortHandler = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill('SIGTERM');
      resolve({ stdout, stderr, exitCode: null, timedOut: true });
    };
    input.signal?.addEventListener('abort', abortHandler, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < stdoutLimit) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < stderrLimit) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', abortHandler);
      reject(err);
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', abortHandler);
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function numberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}
