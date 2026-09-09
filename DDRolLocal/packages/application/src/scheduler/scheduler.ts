import { validateRuntimeContract, type SotRpgjobCard, type SotRpgworkerResult } from '@nyx/contracts';
import type { OperationalLogger } from '@nyx/observability';
import { validateJobDag, validateJobStatusTransition, type JobStatus } from './dag.js';

export type SchedulerResult<T = void> =
  | (T extends void ? { readonly ok: true } : { readonly ok: true; readonly value: T })
  | { readonly ok: false; readonly error: string };

export interface SchedulerOptions {
  readonly backgroundIdleGraceMs?: number;
  readonly observability?: OperationalLogger;
}

export interface DispatchContext {
  readonly nowMs: number;
  readonly idleSinceMs: number | null;
  readonly foregroundTurnActive: boolean;
  readonly maxJobs?: number;
}

export interface JobTransitionRecord {
  readonly from: JobStatus;
  readonly to: JobStatus;
  readonly reason: string;
}

export interface CompletionDisposition {
  readonly status: Extract<JobStatus, 'COMPLETED' | 'PARTIAL' | 'BLOCKED' | 'FAILED' | 'STALE'>;
  readonly integrable: boolean;
  readonly reason: string;
}

export interface ForegroundTurnDisposition {
  readonly cancelledJobIds: readonly string[];
  readonly requeuedJobIds: readonly string[];
}

const MAX_WORKER_SLOTS = 2;
const BACKGROUND_PRIORITIES = new Set<SotRpgjobCard.RPGJobCard['priority']>(['P2', 'P3']);
const TERMINAL_NON_SUCCESS = new Set<JobStatus>(['PARTIAL', 'BLOCKED', 'FAILED', 'STALE', 'CANCELLED']);
const PRIORITY_RANK: Readonly<Record<SotRpgjobCard.RPGJobCard['priority'], number>> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3
};

const RESULT_STATUS: Readonly<
  Record<SotRpgworkerResult.RPGWorkerResult['status'], CompletionDisposition['status']>
> = {
  completed: 'COMPLETED',
  partial: 'PARTIAL',
  blocked: 'BLOCKED',
  failed: 'FAILED',
  stale: 'STALE'
};

function cloneJob(job: SotRpgjobCard.RPGJobCard): SotRpgjobCard.RPGJobCard {
  return structuredClone(job);
}

function completionReason(status: CompletionDisposition['status']): string {
  switch (status) {
    case 'COMPLETED': return 'completed';
    case 'PARTIAL': return 'partial_requires_validation';
    case 'BLOCKED': return 'worker_blocked';
    case 'FAILED': return 'worker_failed';
    case 'STALE': return 'worker_reported_stale';
  }
}

export class GovernedWorkerScheduler {
  readonly #jobs = new Map<string, SotRpgjobCard.RPGJobCard>();
  readonly #transitions = new Map<string, JobTransitionRecord[]>();
  readonly #enqueueSequence = new Map<string, number>();
  readonly #backgroundIdleGraceMs: number;
  readonly #observability: OperationalLogger | undefined;
  #nextSequence = 0;

  constructor(options: SchedulerOptions = {}) {
    const grace = options.backgroundIdleGraceMs ?? 20_000;
    if (!Number.isSafeInteger(grace) || grace < 0) {
      throw new RangeError('backgroundIdleGraceMs debe ser un entero seguro no negativo.');
    }
    this.#backgroundIdleGraceMs = grace;
    this.#observability = options.observability;
  }

  enqueue(jobs: readonly SotRpgjobCard.RPGJobCard[]): SchedulerResult {
    const candidate = [...this.#jobs.values(), ...jobs].map(cloneJob);
    const validation = validateJobDag(candidate);
    if (!validation.ok) return { ok: false, error: validation.errors.join(',') };
    for (const job of jobs) {
      this.#jobs.set(job.job_id, cloneJob(job));
      this.#transitions.set(job.job_id, []);
      this.#enqueueSequence.set(job.job_id, this.#nextSequence);
      this.#nextSequence += 1;
    }
    return { ok: true };
  }

  dispatchReady(context: DispatchContext): readonly SotRpgjobCard.RPGJobCard[] {
    if (
      !Number.isSafeInteger(context.nowMs)
      || context.nowMs < 0
      || (context.idleSinceMs !== null && (!Number.isSafeInteger(context.idleSinceMs) || context.idleSinceMs < 0))
      || (context.maxJobs !== undefined && (!Number.isSafeInteger(context.maxJobs) || context.maxJobs < 0))
    ) {
      return [];
    }

    this.#promoteSatisfiedJobs();
    const jobs = [...this.#jobs.values()];
    const validation = validateJobDag(jobs);
    if (!validation.ok) return [];

    const running = jobs.filter(job => job.status === 'RUNNING');
    let globalCapacity = Math.min(
      Math.max(0, MAX_WORKER_SLOTS - running.length),
      context.maxJobs ?? MAX_WORKER_SLOTS
    );
    if (globalCapacity === 0) return [];

    const backgroundRunning = running.filter(job => BACKGROUND_PRIORITIES.has(job.priority)).length;
    const backgroundLimit = this.#backgroundLimit(context);
    let backgroundCapacity = Math.max(0, backgroundLimit - backgroundRunning);
    const selected: SotRpgjobCard.RPGJobCard[] = [];

    const readyJobIds = [...validation.value.readyJobIds].sort((leftId, rightId) => {
      const left = this.#jobs.get(leftId);
      const right = this.#jobs.get(rightId);
      if (left === undefined || right === undefined) return leftId.localeCompare(rightId, 'en');
      return PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority]
        || (this.#enqueueSequence.get(leftId) ?? 0) - (this.#enqueueSequence.get(rightId) ?? 0);
    });
    for (const jobId of readyJobIds) {
      if (globalCapacity === 0) break;
      const job = this.#jobs.get(jobId);
      if (job === undefined) continue;
      const isBackground = BACKGROUND_PRIORITIES.has(job.priority);
      if (isBackground && (context.foregroundTurnActive || backgroundCapacity === 0)) continue;
      if (!this.#transition(job.job_id, 'RUNNING', 'dispatch')) continue;
      const runningJob = this.#jobs.get(job.job_id);
      if (runningJob !== undefined) selected.push(cloneJob(runningJob));
      globalCapacity -= 1;
      if (isBackground) backgroundCapacity -= 1;
    }
    return selected;
  }

  complete(
    workerResult: SotRpgworkerResult.RPGWorkerResult,
    currentStateVersion: number
  ): SchedulerResult<CompletionDisposition> {
    const contract = validateRuntimeContract('RPGWorkerResult', workerResult);
    if (!contract.ok) {
      return { ok: false, error: `worker_result:contract:${contract.errors.join(',')}` };
    }
    const job = this.#jobs.get(workerResult.job_id);
    if (job === undefined) return { ok: false, error: `job:${workerResult.job_id}:unknown` };
    if (job.status !== 'RUNNING') {
      return { ok: false, error: `job:${job.job_id}:not_running:${job.status}` };
    }
    if (workerResult.turn_id !== job.turn_id) {
      return { ok: false, error: 'worker_result:identity_mismatch:turn_id' };
    }
    if (workerResult.worker_id !== job.worker_id) {
      return { ok: false, error: 'worker_result:identity_mismatch:worker_id' };
    }
    if (!Number.isSafeInteger(currentStateVersion) || currentStateVersion < 0) {
      return { ok: false, error: 'worker_result:current_state_version_invalid' };
    }
    if (
      workerResult.base_state_version !== currentStateVersion
      || workerResult.base_state_version !== job.base_state_version
    ) {
      if (!this.#transition(job.job_id, 'STALE', 'base_state_version_mismatch')) {
        return { ok: false, error: `job:${job.job_id}:stale_transition_rejected` };
      }
      return {
        ok: true,
        value: { status: 'STALE', integrable: false, reason: 'base_state_version_mismatch' }
      };
    }

    const status = RESULT_STATUS[workerResult.status];
    if (!this.#transition(job.job_id, status, `worker_result:${workerResult.status}`)) {
      return { ok: false, error: `job:${job.job_id}:completion_transition_rejected:${status}` };
    }
    return {
      ok: true,
      value: {
        status,
        integrable: status === 'COMPLETED',
        reason: completionReason(status)
      }
    };
  }

  cancel(jobId: string, reason = 'explicit_cancel'): SchedulerResult {
    const job = this.#jobs.get(jobId);
    if (job === undefined) return { ok: false, error: `job:${jobId}:unknown` };
    return this.#transition(jobId, 'CANCELLED', reason)
      ? { ok: true }
      : { ok: false, error: `job:${jobId}:cancel_not_allowed:${job.status}` };
  }

  requeue(jobId: string): SchedulerResult {
    const job = this.#jobs.get(jobId);
    if (job === undefined) return { ok: false, error: `job:${jobId}:unknown` };
    if (!this.#transition(jobId, 'PENDING', 'explicit_requeue')) {
      return { ok: false, error: `job:${jobId}:requeue_not_allowed:${job.status}` };
    }
    this.#moveToQueueTail(jobId);
    return { ok: true };
  }

  rebase(jobId: string, baseStateVersion: number): SchedulerResult {
    const job = this.#jobs.get(jobId);
    if (job === undefined) return { ok: false, error: `job:${jobId}:unknown` };
    if (!Number.isSafeInteger(baseStateVersion) || baseStateVersion < 0) {
      return { ok: false, error: `job:${jobId}:base_state_version_invalid` };
    }
    if (job.status === 'RUNNING' || job.status === 'COMPLETED') {
      return { ok: false, error: `job:${jobId}:rebase_not_allowed:${job.status}` };
    }
    this.#jobs.set(jobId, { ...job, base_state_version: baseStateVersion });
    return { ok: true };
  }

  fail(jobId: string, reason: string): SchedulerResult {
    const job = this.#jobs.get(jobId);
    if (job === undefined) return { ok: false, error: `job:${jobId}:unknown` };
    return this.#transition(jobId, 'FAILED', reason)
      ? { ok: true }
      : { ok: false, error: `job:${jobId}:fail_not_allowed:${job.status}` };
  }

  blockUnreachableDependents(): readonly string[] {
    const blocked: string[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const job of this.#jobs.values()) {
        if (job.status !== 'PENDING' && job.status !== 'READY') continue;
        const failedDependency = job.dependencies.find(dependency => {
          const status = this.#jobs.get(dependency)?.status;
          return status !== undefined && TERMINAL_NON_SUCCESS.has(status);
        });
        if (failedDependency === undefined) continue;
        if (this.#transition(job.job_id, 'BLOCKED', `dependency_terminal:${failedDependency}`)) {
          blocked.push(job.job_id);
          changed = true;
        }
      }
    }
    return blocked;
  }

  beginForegroundTurn(cancelableRunningP3JobIds: readonly string[]): ForegroundTurnDisposition {
    const requested = new Set(cancelableRunningP3JobIds);
    const cancelledJobIds: string[] = [];
    const requeuedJobIds: string[] = [];
    for (const job of this.#jobs.values()) {
      if (job.priority !== 'P3' || job.status !== 'RUNNING' || !requested.has(job.job_id)) continue;
      if (!this.#transition(job.job_id, 'CANCELLED', 'foreground_turn')) continue;
      cancelledJobIds.push(job.job_id);
      if (this.#transition(job.job_id, 'PENDING', 'explicit_requeue')) {
        this.#moveToQueueTail(job.job_id);
        requeuedJobIds.push(job.job_id);
      }
    }
    return { cancelledJobIds, requeuedJobIds };
  }

  statusOf(jobId: string): JobStatus | undefined {
    return this.#jobs.get(jobId)?.status;
  }

  transitionsFor(jobId: string): readonly JobTransitionRecord[] {
    return structuredClone(this.#transitions.get(jobId) ?? []);
  }

  snapshot(): readonly SotRpgjobCard.RPGJobCard[] {
    return [...this.#jobs.values()].map(cloneJob);
  }

  #backgroundLimit(context: DispatchContext): number {
    if (context.foregroundTurnActive || context.idleSinceMs === null || context.nowMs < context.idleSinceMs) return 0;
    return context.nowMs - context.idleSinceMs >= this.#backgroundIdleGraceMs ? 2 : 1;
  }

  #promoteSatisfiedJobs(): void {
    for (const job of this.#jobs.values()) {
      if (job.status !== 'PENDING') continue;
      const satisfied = job.dependencies.every(dependency => this.#jobs.get(dependency)?.status === 'COMPLETED');
      if (satisfied) this.#transition(job.job_id, 'READY', 'dependencies_satisfied');
    }
  }

  #transition(jobId: string, to: JobStatus, reason: string): boolean {
    const job = this.#jobs.get(jobId);
    if (job === undefined) return false;
    const validation = validateJobStatusTransition(job.status, to);
    if (!validation.ok) return false;
    this.#jobs.set(jobId, { ...job, status: to });
    const records = this.#transitions.get(jobId) ?? [];
    records.push({ from: job.status, to, reason });
    this.#transitions.set(jobId, records);
    try {
      this.#observability?.record({
        correlationId: `${job.turn_id}-${job.job_id}`,
        component: 'scheduler',
        operation: 'job.transition',
        code: reason,
        status: to,
        turnId: job.turn_id,
        jobId: job.job_id,
        stateVersion: job.base_state_version
      });
    } catch {
      // La observabilidad nunca participa en la transición canónica.
    }
    return true;
  }

  #moveToQueueTail(jobId: string): void {
    this.#enqueueSequence.set(jobId, this.#nextSequence);
    this.#nextSequence += 1;
  }
}
