import crypto from 'node:crypto';
import {
  validateRuntimeContract,
  type InternalWorkerAttempt,
  type InternalWorkerQueueBatch,
  type SotRpgjobCard,
  type SotRpgworkerResult,
  type SotTurnResolution
} from '@nyx/contracts';
import { canonicalJson } from '@nyx/domain';
import type { OperationalLogger } from '@nyx/observability';
import type { LlmCancellation, LlmGatewayResult, LlmRequestOptions } from '../ports/llm-gateway.js';
import { validateJobDag } from '../scheduler/dag.js';
import { GovernedWorkerScheduler } from '../scheduler/scheduler.js';
import type { TurnExecutionContext, TurnPortResult, TurnWorkerPort } from '../turn/turn-orchestrator.js';

export interface WorkerInvoker {
  execute(
    job: SotRpgjobCard.RPGJobCard,
    context: readonly unknown[],
    options: LlmRequestOptions
  ): Promise<LlmGatewayResult<SotRpgworkerResult.RPGWorkerResult>>;
  cancel(correlationId: string): Promise<LlmGatewayResult<LlmCancellation>>;
}

export interface WorkerQueuePersistencePort {
  loadLatestJobs(context: TurnExecutionContext): Promise<TurnPortResult<readonly SotRpgjobCard.RPGJobCard[]>>;
  loadAttempts(context: TurnExecutionContext): Promise<TurnPortResult<readonly InternalWorkerAttempt.WorkerAttemptV1[]>>;
  recordBatch(
    context: TurnExecutionContext,
    batch: InternalWorkerQueueBatch.WorkerQueueBatchV1
  ): Promise<TurnPortResult<void>>;
  recordJob(context: TurnExecutionContext, job: SotRpgjobCard.RPGJobCard): Promise<TurnPortResult<void>>;
  recordResult(context: TurnExecutionContext, result: SotRpgworkerResult.RPGWorkerResult): Promise<TurnPortResult<void>>;
  recordAttempt(
    context: TurnExecutionContext,
    attempt: InternalWorkerAttempt.WorkerAttemptV1
  ): Promise<TurnPortResult<void>>;
}

export interface WorkerContextBuilderPort {
  build(
    job: SotRpgjobCard.RPGJobCard,
    context: TurnExecutionContext
  ): Promise<TurnPortResult<readonly unknown[]>>;
}

export interface ScheduledTurnWorkerPortOptions {
  readonly timeoutMs: number;
  readonly backgroundIdleGraceMs?: number;
  readonly persistence?: WorkerQueuePersistencePort;
  readonly contextBuilder?: WorkerContextBuilderPort;
  readonly nowMs?: () => number;
  readonly observability?: OperationalLogger;
}

interface BackgroundSession {
  context: TurnExecutionContext;
  readonly scheduler: GovernedWorkerScheduler;
}

interface ActiveBackgroundJob {
  readonly correlationId: string;
  readonly job: SotRpgjobCard.RPGJobCard;
  readonly session: BackgroundSession;
  readonly promise: Promise<void>;
}

const noPersistence: WorkerQueuePersistencePort = {
  loadLatestJobs: async () => ({ ok: true, value: [] }),
  loadAttempts: async () => ({ ok: true, value: [] }),
  recordBatch: async () => ({ ok: true, value: undefined }),
  recordJob: async () => ({ ok: true, value: undefined }),
  recordResult: async () => ({ ok: true, value: undefined }),
  recordAttempt: async () => ({ ok: true, value: undefined })
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure<T>(code: string, message: string): TurnPortResult<T> {
  return { ok: false, error: { code, message } };
}

function awaitedJob(
  resolution: SotTurnResolution.TurnResolution,
  context: TurnExecutionContext
): TurnPortResult<SotRpgjobCard.RPGJobCard> {
  const markers = resolution.open_threads.filter(
    record => isRecord(record) && record['kind'] === 'required_worker_job'
  );
  if (markers.length !== 1) {
    return failure('AWAITED_JOB_UNSPECIFIED', 'AWAITING_WORKER debe declarar exactamente un required_worker_job.');
  }
  const candidate = markers[0]?.['job'];
  if (!isRecord(candidate)) {
    return failure('AWAITED_JOB_INVALID', 'El required_worker_job debe contener un Job Card.');
  }
  const contract = validateRuntimeContract('RPGJobCard', candidate);
  if (!contract.ok) return failure('AWAITED_JOB_INVALID', contract.errors.join(','));
  const job = candidate as unknown as SotRpgjobCard.RPGJobCard;
  if (
    job.turn_id !== context.turnId
    || job.base_state_version !== context.baseStateVersion
    || job.priority !== 'P0'
    || !job.blocking
    || job.budget.deadline_class !== 'before_resolution'
  ) {
    return failure('AWAITED_JOB_INVALID', 'El required_worker_job no coincide con turno/versión o no es P0 bloqueante.');
  }
  const dag = validateJobDag([job]);
  if (!dag.ok) return failure('AWAITED_JOB_INVALID', dag.errors.join(','));
  return { ok: true, value: job };
}

function executionContext(job: SotRpgjobCard.RPGJobCard, context: TurnExecutionContext): readonly unknown[] {
  return [{
    campaign_id: context.campaignId,
    turn_id: job.turn_id,
    base_state_version: job.base_state_version,
    inputs: job.inputs,
    constraints: job.constraints
  }];
}

const defaultContextBuilder: WorkerContextBuilderPort = {
  async build(job, context) {
    return { ok: true, value: executionContext(job, context) };
  }
};

function correlationId(context: TurnExecutionContext, job: SotRpgjobCard.RPGJobCard): string {
  return `${context.campaignId}-${job.turn_id}-${job.job_id}-WORKER`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function batchRecord(
  context: TurnExecutionContext,
  jobs: readonly SotRpgjobCard.RPGJobCard[],
  status: InternalWorkerQueueBatch.WorkerQueueBatchV1['status']
): InternalWorkerQueueBatch.WorkerQueueBatchV1 {
  const jobIds = jobs.map(job => job.job_id).sort();
  return {
    schema_version: '1.0',
    batch_id: `BATCH-${digest({
      campaign_id: context.campaignId,
      turn_id: context.turnId,
      base_state_version: context.baseStateVersion,
      job_ids: jobIds
    })}`,
    campaign_id: context.campaignId,
    turn_id: context.turnId,
    base_state_version: context.baseStateVersion,
    job_ids: jobIds as [string, ...string[]],
    status
  };
}

function attemptKey(campaignId: string, jobId: string): string {
  return `${campaignId}:${jobId}`;
}

async function within<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<{ readonly timedOut: false; readonly value: T } | { readonly timedOut: true }> {
  return await Promise.race([
    promise.then(value => ({ timedOut: false as const, value })),
    delay(timeoutMs).then(() => ({ timedOut: true as const }))
  ]);
}

export class ScheduledTurnWorkerPort implements TurnWorkerPort {
  readonly #invoker: WorkerInvoker;
  readonly #timeoutMs: number;
  readonly #backgroundIdleGraceMs: number;
  readonly #persistence: WorkerQueuePersistencePort;
  readonly #contextBuilder: WorkerContextBuilderPort;
  readonly #nowMs: () => number;
  readonly #observability: OperationalLogger | undefined;
  readonly #backgroundSessions = new Map<string, BackgroundSession>();
  readonly #activeBackground = new Map<string, ActiveBackgroundJob>();
  readonly #recoveredCampaigns = new Set<string>();
  readonly #attempts = new Map<string, InternalWorkerAttempt.WorkerAttemptV1[]>();
  readonly #foregroundCancellations = new Set<string>();
  #foregroundActive = false;
  #idleSinceMs: number | null = null;
  #backgroundPump: Promise<void> = Promise.resolve();
  #backgroundFailure: TurnPortResult<void> | undefined;

  constructor(invoker: WorkerInvoker, options: ScheduledTurnWorkerPortOptions) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new RangeError('timeoutMs debe ser un entero seguro positivo.');
    }
    const grace = options.backgroundIdleGraceMs ?? 20_000;
    if (!Number.isSafeInteger(grace) || grace < 0) {
      throw new RangeError('backgroundIdleGraceMs debe ser un entero seguro no negativo.');
    }
    this.#invoker = invoker;
    this.#timeoutMs = options.timeoutMs;
    this.#backgroundIdleGraceMs = grace;
    this.#persistence = options.persistence ?? noPersistence;
    this.#contextBuilder = options.contextBuilder ?? defaultContextBuilder;
    this.#nowMs = options.nowMs ?? Date.now;
    this.#observability = options.observability;
  }

  async beginTurn(context: TurnExecutionContext): Promise<TurnPortResult<void>> {
    this.#foregroundActive = true;
    this.#idleSinceMs = null;
    const recovered = await this.#recoverCampaign(context);
    if (!recovered.ok) return recovered;
    const runningP3 = [...this.#activeBackground.values()].filter(active => active.job.priority === 'P3');
    const cancellationTimeoutMs = Math.min(this.#timeoutMs, 500);
    for (const active of runningP3) {
      this.#foregroundCancellations.add(active.correlationId);
      const cancelled = await within(this.#invoker.cancel(active.correlationId), cancellationTimeoutMs);
      if (cancelled.timedOut) {
        this.#foregroundCancellations.delete(active.correlationId);
        return failure('WORKER_CANCEL_TIMEOUT', `La cancelación de ${active.job.job_id} no terminó en tiempo acotado.`);
      }
      if (!cancelled.value.ok) {
        this.#foregroundCancellations.delete(active.correlationId);
        return failure(`WORKER_${cancelled.value.error.code}`, `No se pudo cancelar ${active.job.job_id} al comenzar ${context.turnId}.`);
      }
      if (!cancelled.value.value.cancelled) {
        this.#foregroundCancellations.delete(active.correlationId);
        return failure('WORKER_CANCEL_INCONSISTENT', `El gateway no confirmó la cancelación activa de ${active.job.job_id}.`);
      }
      const settled = await within(active.promise, cancellationTimeoutMs);
      this.#foregroundCancellations.delete(active.correlationId);
      if (settled.timedOut) {
        return failure('WORKER_CANCEL_TIMEOUT', `El worker ${active.job.job_id} no liberó su slot tras cancelar.`);
      }
      const disposition = active.session.scheduler.beginForegroundTurn([active.job.job_id]);
      if (!disposition.requeuedJobIds.includes(active.job.job_id)) {
        return failure('WORKER_CANCEL_INCONSISTENT', `El scheduler no reencoló ${active.job.job_id} tras cancelar.`);
      }
      const cancelledRecord = await this.#persistence.recordJob(active.session.context, {
        ...active.job,
        status: 'CANCELLED'
      });
      if (!cancelledRecord.ok) return cancelledRecord;
      const attemptRecorded = await this.#recordTerminalAttempt(
        active.session.context,
        active.job,
        'CANCELLED',
        'FOREGROUND_TURN',
        true
      );
      if (!attemptRecorded.ok) return attemptRecorded;
      const snapshot = active.session.scheduler.snapshot().find(job => job.job_id === active.job.job_id);
      if (snapshot !== undefined) {
        const recorded = await this.#persistence.recordJob(active.session.context, snapshot);
        if (!recorded.ok) return recorded;
      }
    }
    return { ok: true, value: undefined };
  }

  executeForeground(
    jobs: readonly SotRpgjobCard.RPGJobCard[],
    context: TurnExecutionContext
  ): Promise<TurnPortResult<readonly SotRpgworkerResult.RPGWorkerResult[]>> {
    if (jobs.some(job => job.priority !== 'P0' && job.priority !== 'P1')) {
      return Promise.resolve(failure('WORKER_PRIORITY_INVALID', 'Foreground sólo admite jobs P0/P1.'));
    }
    if (jobs.some(job => job.turn_id !== context.turnId || job.base_state_version !== context.baseStateVersion)) {
      return Promise.resolve(failure('WORKER_IDENTITY_INVALID', 'Foreground contiene jobs de otro turno o versión.'));
    }
    return this.#executeBatch(jobs, context);
  }

  async executeAwaited(
    resolution: SotTurnResolution.TurnResolution,
    context: TurnExecutionContext
  ): Promise<TurnPortResult<readonly SotRpgworkerResult.RPGWorkerResult[]>> {
    const extracted = awaitedJob(resolution, context);
    if (!extracted.ok) return extracted;
    return this.#executeBatch([extracted.value], context);
  }

  async schedulePostResponse(
    jobs: readonly SotRpgjobCard.RPGJobCard[],
    context: TurnExecutionContext
  ): Promise<TurnPortResult<void>> {
    const validation = validateJobDag(jobs);
    if (!validation.ok) return failure('WORKER_QUEUE_INVALID', validation.errors.join(','));
    const rebasedExisting = await this.#rebasePendingBackground(context);
    if (!rebasedExisting.ok) return rebasedExisting;
    const background = jobs.filter(job => job.priority === 'P2' || job.priority === 'P3');
    if (background.length === 0) {
      return { ok: true, value: undefined };
    }

    const preparedBatch = batchRecord(context, background, 'PREPARED');
    const prepared = await this.#persistence.recordBatch(context, preparedBatch);
    if (!prepared.ok) return prepared;

    const backgroundIds = new Set(background.map(job => job.job_id));
    const schedulerJobs = jobs.map(job => {
      if (!backgroundIds.has(job.job_id)) {
        return { ...job, base_state_version: context.baseStateVersion, status: 'COMPLETED' as const };
      }
      return {
        ...job,
        base_state_version: context.baseStateVersion,
        status: job.dependencies.length === 0 ? 'READY' as const : 'PENDING' as const
      };
    });
    const scheduler = new GovernedWorkerScheduler({
      backgroundIdleGraceMs: this.#backgroundIdleGraceMs,
      ...(this.#observability === undefined ? {} : { observability: this.#observability })
    });
    const enqueued = scheduler.enqueue(schedulerJobs);
    if (!enqueued.ok) return failure('WORKER_QUEUE_INVALID', enqueued.error);
    const session: BackgroundSession = { context: { ...context }, scheduler };
    for (const job of scheduler.snapshot().filter(candidate => backgroundIds.has(candidate.job_id))) {
      const recorded = await this.#persistence.recordJob(context, job);
      if (!recorded.ok) {
        this.#recoveredCampaigns.delete(context.campaignId);
        return recorded;
      }
    }
    const committed = await this.#persistence.recordBatch(context, { ...preparedBatch, status: 'COMMITTED' });
    if (!committed.ok) {
      this.#recoveredCampaigns.delete(context.campaignId);
      return committed;
    }
    this.#backgroundSessions.set(`${context.campaignId}:${context.turnId}`, session);
    return { ok: true, value: undefined };
  }

  releasePostResponse(): void {
    this.#foregroundActive = false;
    this.#idleSinceMs = this.#nowMs();
    this.#backgroundFailure = undefined;
    this.#backgroundPump = this.#backgroundPump
      .catch(error => {
        this.#backgroundFailure = failure('WORKER_BACKGROUND_UNEXPECTED', String(error));
      })
      .then(() => delay(0))
      .then(() => this.#pumpBackground())
      .catch(error => {
        this.#backgroundFailure = failure('WORKER_BACKGROUND_UNEXPECTED', String(error));
      });
  }

  async waitForBackgroundIdle(): Promise<TurnPortResult<void>> {
    await this.#backgroundPump;
    return this.#backgroundFailure ?? { ok: true, value: undefined };
  }

  resumeAfterBlockedTurn(context: TurnExecutionContext): Promise<TurnPortResult<void>> {
    return this.schedulePostResponse([], context);
  }

  async #executeBatch(
    jobs: readonly SotRpgjobCard.RPGJobCard[],
    context: TurnExecutionContext
  ): Promise<TurnPortResult<readonly SotRpgworkerResult.RPGWorkerResult[]>> {
    if (jobs.length === 0) return { ok: true, value: [] };
    if (jobs.some(job => job.status !== 'PENDING' && job.status !== 'READY')) {
      return failure('WORKER_INITIAL_STATUS_INVALID', 'Los jobs nuevos deben estar PENDING o READY.');
    }
    const scheduler = new GovernedWorkerScheduler(
      this.#observability === undefined ? {} : { observability: this.#observability }
    );
    const enqueued = scheduler.enqueue(jobs);
    if (!enqueued.ok) return failure('WORKER_QUEUE_INVALID', enqueued.error);
    for (const job of scheduler.snapshot()) {
      const recorded = await this.#persistence.recordJob(context, job);
      if (!recorded.ok) return recorded;
    }
    const completed: SotRpgworkerResult.RPGWorkerResult[] = [];

    for (let wave = 0; wave <= jobs.length;) {
      const availableSlots = Math.max(0, 2 - this.#activeBackground.size);
      if (availableSlots === 0) {
        await Promise.race([...this.#activeBackground.values()].map(active => active.promise));
        continue;
      }
      const dispatched = scheduler.dispatchReady({
        nowMs: wave,
        idleSinceMs: null,
        foregroundTurnActive: true,
        maxJobs: availableSlots
      });
      if (dispatched.length === 0) {
        const unresolved = scheduler.snapshot().filter(job => job.status !== 'COMPLETED');
        return unresolved.length === 0
          ? { ok: true, value: completed }
          : failure('WORKER_QUEUE_BLOCKED', `No hay jobs READY; pendientes=${unresolved.map(job => job.job_id).join(',')}.`);
      }
      wave += 1;

      for (const job of dispatched) {
        const recorded = await this.#persistence.recordJob(context, job);
        if (!recorded.ok) return recorded;
      }
      const contexts = new Map<string, readonly unknown[]>();
      for (const job of dispatched) {
        const built = await this.#contextBuilder.build(job, context);
        if (!built.ok) {
          for (const aborted of dispatched) {
            scheduler.fail(
              aborted.job_id,
              aborted.job_id === job.job_id
                ? `context:${built.error.code}`
                : `context_wave_aborted:${job.job_id}`
            );
            const failed = scheduler.snapshot().find(candidate => candidate.job_id === aborted.job_id);
            if (failed !== undefined) {
              const recorded = await this.#persistence.recordJob(context, failed);
              if (!recorded.ok) return recorded;
            }
          }
          return built;
        }
        contexts.set(job.job_id, built.value);
      }
      const waveResults = await Promise.all(dispatched.map(async job => ({
        job,
        result: await this.#invoker.execute(
          job,
          contexts.get(job.job_id) ?? [],
          { correlationId: correlationId(context, job), timeoutMs: this.#timeoutMs }
        )
      })));

      for (const execution of waveResults) {
        if (!execution.result.ok) {
          scheduler.fail(execution.job.job_id, `gateway:${execution.result.error.code}`);
          const snapshot = scheduler.snapshot().find(job => job.job_id === execution.job.job_id);
          if (snapshot !== undefined) await this.#persistence.recordJob(context, snapshot);
          return failure(`WORKER_${execution.result.error.code}`, `Worker ${execution.job.job_id} falló.`);
        }
        const recordedResult = await this.#persistence.recordResult(context, execution.result.value);
        if (!recordedResult.ok) {
          scheduler.fail(execution.job.job_id, 'persistence:worker_result');
          const failed = scheduler.snapshot().find(job => job.job_id === execution.job.job_id);
          if (failed !== undefined) await this.#persistence.recordJob(context, failed);
          return recordedResult;
        }
        const disposition = scheduler.complete(execution.result.value, context.baseStateVersion);
        if (!disposition.ok) return failure('WORKER_RESULT_REJECTED', disposition.error);
        const snapshot = scheduler.snapshot().find(job => job.job_id === execution.job.job_id);
        if (snapshot !== undefined) {
          const recorded = await this.#persistence.recordJob(context, snapshot);
          if (!recorded.ok) return recorded;
        }
        if (!disposition.value.integrable) {
          return failure(`WORKER_${disposition.value.status}`, `Worker ${execution.job.job_id} no produjo un resultado integrable.`);
        }
        if (!execution.result.value.dod.passed || execution.result.value.dod.missing.length > 0) {
          return failure('WORKER_DOD_FAILED', `Worker ${execution.job.job_id} no cumplió su Definition of Done.`);
        }
        completed.push(execution.result.value);
      }
    }
    return failure('WORKER_QUEUE_EXHAUSTED', 'El pipeline excedió el número seguro de waves.');
  }

  async #recoverCampaign(context: TurnExecutionContext): Promise<TurnPortResult<void>> {
    if (this.#recoveredCampaigns.has(context.campaignId)) return { ok: true, value: undefined };
    const loadedAttempts = await this.#persistence.loadAttempts(context);
    if (!loadedAttempts.ok) return loadedAttempts;
    for (const attempt of loadedAttempts.value) {
      const key = attemptKey(attempt.campaign_id, attempt.job_id);
      const records = this.#attempts.get(key) ?? [];
      records.push(structuredClone(attempt));
      this.#attempts.set(key, records);
    }
    const loaded = await this.#persistence.loadLatestJobs(context);
    if (!loaded.ok) return loaded;
    const recoverable = loaded.value.filter(job =>
      job.status === 'COMPLETED' || job.priority === 'P2' || job.priority === 'P3'
    );
    const scheduler = new GovernedWorkerScheduler({
      backgroundIdleGraceMs: this.#backgroundIdleGraceMs,
      ...(this.#observability === undefined ? {} : { observability: this.#observability })
    });
    const enqueued = scheduler.enqueue(recoverable);
    if (!enqueued.ok) return failure('WORKER_QUEUE_RECOVERY_INVALID', enqueued.error);
    const session: BackgroundSession = { context: { ...context }, scheduler };
    this.#backgroundSessions.set(`${context.campaignId}:recovered`, session);
    for (const job of scheduler.snapshot()) {
      if (job.priority !== 'P2' && job.priority !== 'P3') continue;
      let latestAttempt = this.#latestAttempt(context.campaignId, job.job_id);
      if (job.status === 'COMPLETED') {
        if (latestAttempt?.status === 'RUNNING') {
          const reconciled = await this.#recordTerminalAttempt(
            context,
            job,
            'COMPLETED',
            'RECOVERED_JOB_STATUS',
            false
          );
          if (!reconciled.ok) return reconciled;
        }
        continue;
      }
      if (job.status === 'FAILED' || job.status === 'PARTIAL' || job.status === 'BLOCKED') {
        if (latestAttempt?.status === 'RUNNING') {
          const reconciled = await this.#recordTerminalAttempt(
            context,
            job,
            job.status,
            'RECOVERED_JOB_STATUS',
            false
          );
          if (!reconciled.ok) return reconciled;
        }
        continue;
      }
      if (job.status === 'STALE') {
        if (latestAttempt?.status === 'RUNNING') {
          const reconciled = await this.#recordTerminalAttempt(
            context,
            job,
            'STALE',
            'RECOVERED_JOB_STATUS',
            this.#staleCount(context.campaignId, job.job_id) === 0
          );
          if (!reconciled.ok) return reconciled;
        }
        if (this.#staleCount(context.campaignId, job.job_id) >= 2) continue;
      }
      if (job.status === 'CANCELLED' && latestAttempt?.status === 'RUNNING') {
        const reconciled = await this.#recordTerminalAttempt(
          context,
          job,
          'CANCELLED',
          'RECOVERED_JOB_STATUS',
          true
        );
        if (!reconciled.ok) return reconciled;
        latestAttempt = this.#latestAttempt(context.campaignId, job.job_id);
      }
      if (job.status === 'CANCELLED' && latestAttempt?.retry_authorized !== true) continue;
      if (job.status === 'RUNNING' || latestAttempt?.status === 'RUNNING') {
        const cancelled = scheduler.cancel(job.job_id, 'process_recovery');
        if (!cancelled.ok) return failure('WORKER_QUEUE_RECOVERY_INVALID', cancelled.error);
        const cancelledRecord = await this.#persistence.recordJob(context, { ...job, status: 'CANCELLED' });
        if (!cancelledRecord.ok) return cancelledRecord;
        const attemptRecorded = await this.#recordTerminalAttempt(
          context,
          job,
          'CANCELLED',
          'PROCESS_RECOVERY',
          true
        );
        if (!attemptRecorded.ok) return attemptRecorded;
      }
      const current = scheduler.statusOf(job.job_id);
      if (current !== 'PENDING' && current !== 'READY') {
        const requeued = scheduler.requeue(job.job_id);
        if (!requeued.ok) return failure('WORKER_QUEUE_RECOVERY_INVALID', requeued.error);
      }
      const rebased = scheduler.rebase(job.job_id, context.baseStateVersion);
      if (!rebased.ok) return failure('WORKER_QUEUE_RECOVERY_INVALID', rebased.error);
      const snapshot = scheduler.snapshot().find(candidate => candidate.job_id === job.job_id);
      if (snapshot !== undefined) {
        const recorded = await this.#persistence.recordJob(context, snapshot);
        if (!recorded.ok) return recorded;
      }
    }
    const blocked = await this.#persistBlockedDependents(session);
    if (!blocked.ok) return blocked;
    this.#recoveredCampaigns.add(context.campaignId);
    return { ok: true, value: undefined };
  }

  #latestAttempt(campaignId: string, jobId: string): InternalWorkerAttempt.WorkerAttemptV1 | undefined {
    return this.#attempts.get(attemptKey(campaignId, jobId))?.at(-1);
  }

  #staleCount(campaignId: string, jobId: string): number {
    return (this.#attempts.get(attemptKey(campaignId, jobId)) ?? [])
      .filter(attempt => attempt.status === 'STALE').length;
  }

  async #startAttempt(
    context: TurnExecutionContext,
    job: SotRpgjobCard.RPGJobCard
  ): Promise<TurnPortResult<InternalWorkerAttempt.WorkerAttemptV1>> {
    const existing = this.#attempts.get(attemptKey(context.campaignId, job.job_id)) ?? [];
    const ordinal = existing.reduce((maximum, attempt) => Math.max(maximum, attempt.ordinal), 0) + 1;
    const attempt: InternalWorkerAttempt.WorkerAttemptV1 = {
      schema_version: '1.0',
      attempt_id: `ATTEMPT-${digest({
        campaign_id: context.campaignId,
        turn_id: job.turn_id,
        job_id: job.job_id,
        ordinal
      })}`,
      campaign_id: context.campaignId,
      turn_id: job.turn_id,
      job_id: job.job_id,
      ordinal,
      status: 'RUNNING',
      reason_code: 'EXECUTION_STARTED',
      retry_authorized: false
    };
    const recorded = await this.#persistence.recordAttempt(context, attempt);
    if (!recorded.ok) return recorded;
    existing.push(attempt);
    this.#attempts.set(attemptKey(context.campaignId, job.job_id), existing);
    return { ok: true, value: attempt };
  }

  async #recordTerminalAttempt(
    context: TurnExecutionContext,
    job: SotRpgjobCard.RPGJobCard,
    status: Exclude<InternalWorkerAttempt.WorkerAttemptV1['status'], 'RUNNING'>,
    reasonCode: string,
    retryAuthorized: boolean
  ): Promise<TurnPortResult<void>> {
    let running = this.#latestAttempt(context.campaignId, job.job_id);
    if (running?.status !== 'RUNNING') {
      const started = await this.#startAttempt(context, job);
      if (!started.ok) return started;
      running = started.value;
    }
    const terminal: InternalWorkerAttempt.WorkerAttemptV1 = {
      ...running,
      status,
      reason_code: reasonCode,
      retry_authorized: retryAuthorized
    };
    const recorded = await this.#persistence.recordAttempt(context, terminal);
    if (!recorded.ok) return recorded;
    const records = this.#attempts.get(attemptKey(context.campaignId, job.job_id)) ?? [];
    records.push(terminal);
    this.#attempts.set(attemptKey(context.campaignId, job.job_id), records);
    return { ok: true, value: undefined };
  }

  async #rebasePendingBackground(context: TurnExecutionContext): Promise<TurnPortResult<void>> {
    for (const session of this.#backgroundSessions.values()) {
      if (session.context.campaignId !== context.campaignId) continue;
      session.context = { ...session.context, baseStateVersion: context.baseStateVersion };
      for (const job of session.scheduler.snapshot()) {
        if ((job.priority !== 'P2' && job.priority !== 'P3') || job.status === 'COMPLETED') continue;
        if (job.status === 'RUNNING') continue;
        if (job.status !== 'PENDING' && job.status !== 'READY') continue;
        const rebased = session.scheduler.rebase(job.job_id, context.baseStateVersion);
        if (!rebased.ok) return failure('WORKER_QUEUE_REBASE_INVALID', rebased.error);
        const snapshot = session.scheduler.snapshot().find(candidate => candidate.job_id === job.job_id);
        if (snapshot !== undefined) {
          const recorded = await this.#persistence.recordJob(context, snapshot);
          if (!recorded.ok) return recorded;
        }
      }
    }
    return { ok: true, value: undefined };
  }

  async #pumpBackground(): Promise<void> {
    while (!this.#foregroundActive) {
      const now = this.#nowMs();
      const idleSince = this.#idleSinceMs ?? now;
      const globalLimit = now - idleSince >= this.#backgroundIdleGraceMs ? 2 : 1;
      let capacity = Math.max(0, globalLimit - this.#activeBackground.size);
      for (const session of this.#backgroundSessions.values()) {
        if (capacity === 0) break;
        const dispatched = session.scheduler.dispatchReady({
          nowMs: now,
          idleSinceMs: idleSince,
          foregroundTurnActive: false,
          maxJobs: capacity
        });
        for (const job of dispatched) {
          capacity -= 1;
          const active = this.#startBackground(job, session);
          this.#activeBackground.set(active.correlationId, active);
        }
      }

      if (this.#activeBackground.size === 0) {
        this.#pruneTerminalSessions();
        return;
      }
      const graceRemaining = Math.max(0, this.#backgroundIdleGraceMs - (this.#nowMs() - idleSince));
      const activePromises = [...this.#activeBackground.values()].map(active => active.promise);
      await (graceRemaining > 0 && globalLimit === 1
        ? Promise.race([...activePromises, delay(graceRemaining)])
        : Promise.race(activePromises));
    }
  }

  #startBackground(job: SotRpgjobCard.RPGJobCard, session: BackgroundSession): ActiveBackgroundJob {
    const id = correlationId(session.context, job);
    const promise = (async () => {
      const attempt = await this.#startAttempt(session.context, job);
      if (!attempt.ok) {
        this.#backgroundFailure = attempt;
        return;
      }
      const runningRecorded = await this.#persistence.recordJob(session.context, job);
      if (!runningRecorded.ok) {
        this.#backgroundFailure = runningRecorded;
        return;
      }
      const builtContext = await this.#contextBuilder.build(job, session.context);
      if (!builtContext.ok) {
        session.scheduler.fail(job.job_id, `context:${builtContext.error.code}`);
        const snapshot = session.scheduler.snapshot().find(candidate => candidate.job_id === job.job_id);
        if (snapshot !== undefined) await this.#persistence.recordJob(session.context, snapshot);
        const terminal = await this.#recordTerminalAttempt(
          session.context,
          job,
          'FAILED',
          `CONTEXT:${builtContext.error.code}`,
          false
        );
        this.#backgroundFailure = terminal.ok ? builtContext : terminal;
        return;
      }
      const executed = await this.#invoker.execute(
        job,
        builtContext.value,
        { correlationId: id, timeoutMs: this.#timeoutMs }
      );
      if (!executed.ok) {
        if (executed.error.code === 'CANCELLED' && this.#foregroundCancellations.has(id)) return;
        session.scheduler.fail(job.job_id, `gateway:${executed.error.code}`);
        const snapshot = session.scheduler.snapshot().find(candidate => candidate.job_id === job.job_id);
        if (snapshot !== undefined) {
          const recorded = await this.#persistence.recordJob(session.context, snapshot);
          if (!recorded.ok) {
            this.#backgroundFailure = recorded;
            return;
          }
        }
        const terminal = await this.#recordTerminalAttempt(
          session.context,
          job,
          executed.error.code === 'CANCELLED' ? 'CANCELLED' : 'FAILED',
          `GATEWAY:${executed.error.code}`,
          false
        );
        this.#backgroundFailure = terminal.ok
          ? failure(`WORKER_${executed.error.code}`, `Background ${job.job_id} falló.`)
          : terminal;
        return;
      } else {
        const resultRecorded = await this.#persistence.recordResult(session.context, executed.value);
        if (!resultRecorded.ok) {
          this.#backgroundFailure = resultRecorded;
          session.scheduler.fail(job.job_id, 'persistence:worker_result');
          const snapshot = session.scheduler.snapshot().find(candidate => candidate.job_id === job.job_id);
          if (snapshot !== undefined) await this.#persistence.recordJob(session.context, snapshot);
          await this.#recordTerminalAttempt(session.context, job, 'FAILED', 'RESULT_PERSISTENCE', false);
          return;
        } else {
          const disposition = session.scheduler.complete(executed.value, session.context.baseStateVersion);
          if (!disposition.ok) {
            this.#backgroundFailure = failure('WORKER_RESULT_REJECTED', disposition.error);
            session.scheduler.fail(job.job_id, 'worker_result_rejected');
            const snapshot = session.scheduler.snapshot().find(candidate => candidate.job_id === job.job_id);
            if (snapshot !== undefined) await this.#persistence.recordJob(session.context, snapshot);
            await this.#recordTerminalAttempt(session.context, job, 'FAILED', 'WORKER_RESULT_REJECTED', false);
            return;
          } else if (!disposition.value.integrable) {
            const retryAuthorized = disposition.value.status === 'STALE'
              && this.#staleCount(session.context.campaignId, job.job_id) === 0;
            const snapshot = session.scheduler.snapshot().find(candidate => candidate.job_id === job.job_id);
            if (snapshot !== undefined) {
              const recorded = await this.#persistence.recordJob(session.context, snapshot);
              if (!recorded.ok) {
                this.#backgroundFailure = recorded;
                return;
              }
            }
            const terminal = await this.#recordTerminalAttempt(
              session.context,
              job,
              disposition.value.status,
              `WORKER_RESULT:${disposition.value.status}`,
              retryAuthorized
            );
            if (!terminal.ok) {
              this.#backgroundFailure = terminal;
              return;
            }
            if (disposition.value.status === 'STALE') {
              if (retryAuthorized) {
                const requeued = session.scheduler.requeue(job.job_id);
                if (!requeued.ok) {
                  this.#backgroundFailure = failure(
                    'WORKER_QUEUE_REBASE_INVALID',
                    requeued.error
                  );
                } else {
                  const rebased = session.scheduler.rebase(job.job_id, session.context.baseStateVersion);
                  if (!rebased.ok) {
                    this.#backgroundFailure = failure('WORKER_QUEUE_REBASE_INVALID', rebased.error);
                  } else {
                    const pending = session.scheduler.snapshot().find(candidate => candidate.job_id === job.job_id);
                    if (pending !== undefined) {
                      const recorded = await this.#persistence.recordJob(session.context, pending);
                      if (!recorded.ok) this.#backgroundFailure = recorded;
                    }
                  }
                }
              } else {
                this.#backgroundFailure = failure('WORKER_STALE', `Background ${job.job_id} siguió STALE tras un rerun.`);
              }
            } else {
              this.#backgroundFailure = failure(
                `WORKER_${disposition.value.status}`,
                `Background ${job.job_id} terminó ${disposition.value.status}.`
              );
            }
            return;
          }
        }
      }
      const snapshot = session.scheduler.snapshot().find(candidate => candidate.job_id === job.job_id);
      if (snapshot !== undefined) {
        const recorded = await this.#persistence.recordJob(session.context, snapshot);
        if (!recorded.ok) {
          this.#backgroundFailure = recorded;
          return;
        }
      }
      const terminal = await this.#recordTerminalAttempt(session.context, job, 'COMPLETED', 'WORKER_RESULT:COMPLETED', false);
      if (!terminal.ok) this.#backgroundFailure = terminal;
    })().catch(error => {
      this.#backgroundFailure = failure('WORKER_BACKGROUND_UNEXPECTED', String(error));
    }).finally(async () => {
      const blocked = await this.#persistBlockedDependents(session);
      if (!blocked.ok) this.#backgroundFailure = blocked;
      this.#activeBackground.delete(id);
    });
    return { correlationId: id, job, session, promise };
  }

  async #persistBlockedDependents(session: BackgroundSession): Promise<TurnPortResult<void>> {
    const blockedJobIds = session.scheduler.blockUnreachableDependents();
    for (const jobId of blockedJobIds) {
      const blocked = session.scheduler.snapshot().find(candidate => candidate.job_id === jobId);
      if (blocked === undefined) {
        return failure('WORKER_QUEUE_BLOCK_INVALID', `El scheduler perdió el job bloqueado ${jobId}.`);
      }
      const recorded = await this.#persistence.recordJob(session.context, blocked);
      if (!recorded.ok) return recorded;
    }
    return { ok: true, value: undefined };
  }

  #pruneTerminalSessions(): void {
    for (const [key, session] of this.#backgroundSessions) {
      const backgroundJobs = session.scheduler.snapshot().filter(job =>
        job.priority === 'P2' || job.priority === 'P3'
      );
      const hasRunnableBackground = backgroundJobs.some(job =>
        job.status === 'PENDING' || job.status === 'READY' || job.status === 'RUNNING'
      );
      if (!hasRunnableBackground) {
        this.#backgroundSessions.delete(key);
      }
    }
  }
}
