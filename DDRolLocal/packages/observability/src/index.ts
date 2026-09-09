import fs from 'node:fs/promises';
import path from 'node:path';

export const packageId = '@nyx/observability' as const;

export interface OperationalLogInput {
  readonly correlationId: string;
  readonly component: string;
  readonly operation: string;
  readonly code: string;
  readonly status: string;
  readonly campaignId?: string;
  readonly turnId?: string;
  readonly jobId?: string;
  readonly stateVersion?: number;
  readonly retryCount?: number;
  readonly checkpointId?: string;
  readonly hashes?: Readonly<Record<string, unknown>>;
  readonly metrics?: Readonly<Record<string, unknown>>;
  readonly [field: string]: unknown;
}

export interface OperationalLogEntry {
  readonly timestamp: string;
  readonly correlation_id: string;
  readonly component: string;
  readonly operation: string;
  readonly code: string;
  readonly status: string;
  readonly campaign_id?: string;
  readonly turn_id?: string;
  readonly job_id?: string;
  readonly state_version?: number;
  readonly retry_count?: number;
  readonly checkpoint_id?: string;
  readonly hashes?: Readonly<Record<string, string>>;
  readonly metrics?: Readonly<Record<string, number>>;
}

export interface OperationalLogSink {
  append(entry: OperationalLogEntry): Promise<void>;
}

export interface OperationalLogger {
  record(input: OperationalLogInput): void;
  flush?(): Promise<OperationalLogFlushResult>;
}

export type OperationalLogFlushResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: { readonly code: 'LOG_WRITE_FAILED'; readonly message: string } };

function safeText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 160
    ? value
    : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function safeHashes(value: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const hashes = Object.fromEntries(Object.entries(value)
    .filter(([key, hash]) => /^[a-z][a-z0-9_]{0,63}$/u.test(key)
      && typeof hash === 'string'
      && /^[a-f0-9]{64}$/u.test(hash)));
  return Object.keys(hashes).length === 0 ? undefined : hashes;
}

function safeMetrics(value: unknown): Readonly<Record<string, number>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const metrics = Object.fromEntries(Object.entries(value)
    .filter(([key, metric]) => /^[a-z][a-z0-9_]{0,63}$/u.test(key)
      && typeof metric === 'number'
      && Number.isFinite(metric)));
  return Object.keys(metrics).length === 0 ? undefined : metrics;
}

function allowlistedEntry(input: OperationalLogInput, now: () => Date): OperationalLogEntry {
  const required = {
    correlation_id: safeText(input.correlationId) ?? 'UNKNOWN',
    component: safeText(input.component) ?? 'unknown',
    operation: safeText(input.operation) ?? 'unknown',
    code: safeText(input.code) ?? 'UNKNOWN',
    status: safeText(input.status) ?? 'UNKNOWN'
  };
  const campaignId = safeText(input.campaignId);
  const turnId = safeText(input.turnId);
  const jobId = safeText(input.jobId);
  const stateVersion = safeInteger(input.stateVersion);
  const retryCount = safeInteger(input.retryCount);
  const checkpointId = safeText(input.checkpointId);
  const hashes = safeHashes(input.hashes);
  const metrics = safeMetrics(input.metrics);
  return {
    timestamp: now().toISOString(),
    ...required,
    ...(campaignId === undefined ? {} : { campaign_id: campaignId }),
    ...(turnId === undefined ? {} : { turn_id: turnId }),
    ...(jobId === undefined ? {} : { job_id: jobId }),
    ...(stateVersion === undefined ? {} : { state_version: stateVersion }),
    ...(retryCount === undefined ? {} : { retry_count: retryCount }),
    ...(checkpointId === undefined ? {} : { checkpoint_id: checkpointId }),
    ...(hashes === undefined ? {} : { hashes }),
    ...(metrics === undefined ? {} : { metrics })
  };
}

export class SafeOperationalLogger implements OperationalLogger {
  readonly #sink: OperationalLogSink;
  readonly #now: () => Date;
  #tail: Promise<void> = Promise.resolve();
  #lastFailure: string | undefined;

  constructor(sink: OperationalLogSink, options: { readonly now?: () => Date } = {}) {
    this.#sink = sink;
    this.#now = options.now ?? (() => new Date());
  }

  record(input: OperationalLogInput): void {
    let entry: OperationalLogEntry;
    try {
      entry = allowlistedEntry(input, this.#now);
    } catch (error) {
      this.#lastFailure = String(error);
      return;
    }
    this.#tail = this.#tail.then(async () => {
      try {
        await this.#sink.append(entry);
      } catch (error) {
        this.#lastFailure = String(error);
      }
    });
  }

  async flush(): Promise<OperationalLogFlushResult> {
    await this.#tail;
    return this.#lastFailure === undefined
      ? { ok: true }
      : { ok: false, error: { code: 'LOG_WRITE_FAILED', message: this.#lastFailure } };
  }
}

export class JsonlOperationalLogSink implements OperationalLogSink {
  readonly #directory: string;

  constructor(logDirectory: string) {
    this.#directory = path.resolve(logDirectory);
  }

  async append(entry: OperationalLogEntry): Promise<void> {
    await fs.mkdir(this.#directory, { recursive: true });
    const handle = await fs.open(path.join(this.#directory, 'operational.jsonl'), 'a');
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
