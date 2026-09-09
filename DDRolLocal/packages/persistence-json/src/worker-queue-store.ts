import fs from 'node:fs/promises';
import path from 'node:path';
import {
  validateRuntimeContract,
  type InternalWorkerAttempt,
  type InternalWorkerQueueBatch,
  type RuntimeContractName,
  type SotRpgjobCard,
  type SotRpgworkerResult
} from '@nyx/contracts';
import { err, ok, type Result } from '@nyx/domain';
import { canonicalJson } from './canonical-json.js';
import { ensureDirectory, exists } from './durable-files.js';
import type { PersistenceError } from './types.js';

export class JsonWorkerQueueStore {
  readonly #directory: string;
  readonly #jobsFile: string;
  readonly #resultsFile: string;
  readonly #batchesFile: string;
  readonly #attemptsFile: string;
  #jobsAppend: Promise<void> = Promise.resolve();
  #resultsAppend: Promise<void> = Promise.resolve();
  #batchesAppend: Promise<void> = Promise.resolve();
  #attemptsAppend: Promise<void> = Promise.resolve();

  constructor(campaignRoot: string) {
    this.#directory = path.join(path.resolve(campaignRoot), 'queue');
    this.#jobsFile = path.join(this.#directory, 'jobs.jsonl');
    this.#resultsFile = path.join(this.#directory, 'results.jsonl');
    this.#batchesFile = path.join(this.#directory, 'batches.jsonl');
    this.#attemptsFile = path.join(this.#directory, 'attempts.jsonl');
  }

  async latestJobs(): Promise<Result<readonly SotRpgjobCard.RPGJobCard[], PersistenceError>> {
    const records = await this.#read<SotRpgjobCard.RPGJobCard>(this.#jobsFile, 'RPGJobCard', 'jobs');
    if (!records.ok) return records;
    const latest = new Map<string, SotRpgjobCard.RPGJobCard>();
    for (const record of records.value) {
      const previous = latest.get(record.job_id);
      if (previous !== undefined && previous.turn_id !== record.turn_id) {
        return err({
          code: 'CORRUPT_DATA',
          message: `queue/jobs.jsonl reutiliza ${record.job_id} en más de un turno.`
        });
      }
      latest.set(record.job_id, record);
    }
    return ok([...latest.values()].map(record => structuredClone(record)));
  }

  results(): Promise<Result<readonly SotRpgworkerResult.RPGWorkerResult[], PersistenceError>> {
    return this.#read<SotRpgworkerResult.RPGWorkerResult>(this.#resultsFile, 'RPGWorkerResult', 'results');
  }

  batchRecords(): Promise<Result<readonly InternalWorkerQueueBatch.WorkerQueueBatchV1[], PersistenceError>> {
    return this.#read<InternalWorkerQueueBatch.WorkerQueueBatchV1>(
      this.#batchesFile,
      'WorkerQueueBatch',
      'batches'
    );
  }

  async attempts(): Promise<Result<readonly InternalWorkerAttempt.WorkerAttemptV1[], PersistenceError>> {
    const records = await this.#read<InternalWorkerAttempt.WorkerAttemptV1>(
      this.#attemptsFile,
      'WorkerAttempt',
      'attempts'
    );
    if (!records.ok) return records;
    const lifecycle = new Map<string, {
      readonly maximumOrdinal: number;
      readonly running?: InternalWorkerAttempt.WorkerAttemptV1;
    }>();
    for (const record of records.value) {
      const key = `${record.campaign_id}:${record.job_id}`;
      const current = lifecycle.get(key) ?? { maximumOrdinal: 0 };
      if (record.status === 'RUNNING') {
        if (
          current.running !== undefined
          || record.ordinal !== current.maximumOrdinal + 1
          || record.retry_authorized
        ) {
          return err({
            code: 'CORRUPT_DATA',
            message: `queue/attempts.jsonl contiene un inicio de intento inválido para ${record.job_id}.`
          });
        }
        lifecycle.set(key, { maximumOrdinal: record.ordinal, running: record });
        continue;
      }
      if (
        current.running === undefined
        || !sameAttemptIdentity(current.running, record)
        || (record.retry_authorized && record.status !== 'STALE' && record.status !== 'CANCELLED')
      ) {
        return err({
          code: 'CORRUPT_DATA',
          message: `queue/attempts.jsonl contiene un cierre de intento inválido para ${record.job_id}.`
        });
      }
      lifecycle.set(key, { maximumOrdinal: record.ordinal });
    }
    return ok(records.value.map(record => structuredClone(record)));
  }

  async recoverableJobs(): Promise<Result<readonly SotRpgjobCard.RPGJobCard[], PersistenceError>> {
    const jobs = await this.latestJobs();
    if (!jobs.ok) return jobs;
    const batches = await this.batchRecords();
    if (!batches.ok) return batches;
    const prepared = new Map<string, InternalWorkerQueueBatch.WorkerQueueBatchV1>();
    const committedBatchIds = new Set<string>();
    const batchByJobId = new Map<string, string>();
    const committedJobIds = new Set<string>();
    const preparedJobIds = new Set<string>();
    for (const record of batches.value) {
      const previous = prepared.get(record.batch_id);
      if (record.status === 'PREPARED') {
        if (previous !== undefined) {
          return err({ code: 'CORRUPT_DATA', message: `queue/batches.jsonl repite PREPARED para ${record.batch_id}.` });
        }
        prepared.set(record.batch_id, record);
        for (const jobId of record.job_ids) {
          const owner = batchByJobId.get(jobId);
          if (owner !== undefined && owner !== record.batch_id) {
            return err({
              code: 'CORRUPT_DATA',
              message: `queue/batches.jsonl asigna ${jobId} a más de un lote.`
            });
          }
          batchByJobId.set(jobId, record.batch_id);
          preparedJobIds.add(jobId);
        }
        continue;
      }
      if (
        committedBatchIds.has(record.batch_id)
        || previous === undefined
        || !sameBatchIdentity(previous, record)
      ) {
        return err({ code: 'CORRUPT_DATA', message: `queue/batches.jsonl contiene COMMITTED sin PREPARED equivalente.` });
      }
      committedBatchIds.add(record.batch_id);
      for (const jobId of record.job_ids) committedJobIds.add(jobId);
    }
    const recoverable: SotRpgjobCard.RPGJobCard[] = [];
    for (const job of jobs.value) {
      if (job.priority !== 'P2' && job.priority !== 'P3') {
        if (job.status === 'COMPLETED') recoverable.push(job);
        continue;
      }
      if (committedJobIds.has(job.job_id)) {
        recoverable.push(job);
        continue;
      }
      if (preparedJobIds.has(job.job_id)) continue;
      if (job.status === 'COMPLETED') {
        recoverable.push(job);
        continue;
      }
      return err({
        code: 'CORRUPT_DATA',
        message: `queue/jobs.jsonl contiene ${job.job_id} activo sin lote durable confirmado.`
      });
    }
    return ok(recoverable.map(job => structuredClone(job)));
  }

  appendJob(job: SotRpgjobCard.RPGJobCard): Promise<Result<void, PersistenceError>> {
    const operation = this.#jobsAppend.then(() => this.#append(this.#jobsFile, 'RPGJobCard', job, 'job'));
    this.#jobsAppend = operation.then(() => undefined, () => undefined);
    return operation;
  }

  appendResult(result: SotRpgworkerResult.RPGWorkerResult): Promise<Result<void, PersistenceError>> {
    const operation = this.#resultsAppend.then(() => this.#append(this.#resultsFile, 'RPGWorkerResult', result, 'worker result'));
    this.#resultsAppend = operation.then(() => undefined, () => undefined);
    return operation;
  }

  appendBatch(batch: InternalWorkerQueueBatch.WorkerQueueBatchV1): Promise<Result<void, PersistenceError>> {
    const operation = this.#batchesAppend.then(() => this.#append(
      this.#batchesFile,
      'WorkerQueueBatch',
      batch,
      'worker queue batch'
    ));
    this.#batchesAppend = operation.then(() => undefined, () => undefined);
    return operation;
  }

  appendAttempt(attempt: InternalWorkerAttempt.WorkerAttemptV1): Promise<Result<void, PersistenceError>> {
    const operation = this.#attemptsAppend.then(() => this.#append(
      this.#attemptsFile,
      'WorkerAttempt',
      attempt,
      'worker attempt'
    ));
    this.#attemptsAppend = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #read<T>(
    file: string,
    contract: RuntimeContractName,
    label: string
  ): Promise<Result<T[], PersistenceError>> {
    try {
      if (!(await exists(file))) return ok([]);
      const text = await fs.readFile(file, 'utf8');
      if (text.length > 0 && !text.endsWith('\n')) {
        return err({ code: 'CORRUPT_DATA', message: `queue/${label}.jsonl contiene un tail parcial.` });
      }
      const records: T[] = [];
      for (const [index, line] of text.split('\n').entries()) {
        if (line.length === 0) continue;
        let value: unknown;
        try {
          value = JSON.parse(line) as unknown;
        } catch {
          return err({ code: 'CORRUPT_DATA', message: `queue/${label}.jsonl contiene JSON inválido en línea ${index + 1}.` });
        }
        const validation = validateRuntimeContract(contract, value);
        if (!validation.ok) {
          return err({
            code: 'CORRUPT_DATA',
            message: `queue/${label}.jsonl no cumple ${contract} en línea ${index + 1}.`,
            details: [...validation.errors]
          });
        }
        records.push(value as T);
      }
      return ok(records);
    } catch (error) {
      return err({ code: 'IO_ERROR', message: `No se pudo leer queue/${label}.jsonl.`, details: [String(error)] });
    }
  }

  async #append(
    file: string,
    contract: RuntimeContractName,
    value: unknown,
    label: string
  ): Promise<Result<void, PersistenceError>> {
    const validation = validateRuntimeContract(contract, value);
    if (!validation.ok) {
      return err({
        code: 'INVALID_EVENT',
        message: `El ${label} no cumple ${contract}.`,
        details: [...validation.errors]
      });
    }
    try {
      await ensureDirectory(this.#directory);
      const handle = await fs.open(file, 'a');
      try {
        await handle.writeFile(canonicalJson(value), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return ok(undefined);
    } catch (error) {
      return err({ code: 'IO_ERROR', message: `No se pudo anexar el ${label} a la cola.`, details: [String(error)] });
    }
  }
}

function sameBatchIdentity(
  prepared: InternalWorkerQueueBatch.WorkerQueueBatchV1,
  committed: InternalWorkerQueueBatch.WorkerQueueBatchV1
): boolean {
  return prepared.schema_version === committed.schema_version
    && prepared.batch_id === committed.batch_id
    && prepared.campaign_id === committed.campaign_id
    && prepared.turn_id === committed.turn_id
    && prepared.base_state_version === committed.base_state_version
    && prepared.job_ids.length === committed.job_ids.length
    && prepared.job_ids.every((jobId, index) => committed.job_ids[index] === jobId);
}

function sameAttemptIdentity(
  running: InternalWorkerAttempt.WorkerAttemptV1,
  terminal: InternalWorkerAttempt.WorkerAttemptV1
): boolean {
  return running.schema_version === terminal.schema_version
    && running.attempt_id === terminal.attempt_id
    && running.campaign_id === terminal.campaign_id
    && running.turn_id === terminal.turn_id
    && running.job_id === terminal.job_id
    && running.ordinal === terminal.ordinal;
}
