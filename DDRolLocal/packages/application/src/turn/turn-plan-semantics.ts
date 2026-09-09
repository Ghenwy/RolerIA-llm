import type { SotRpgjobCard, SotTurnPlan } from '@nyx/contracts';
import { validateJobDag } from '../scheduler/dag.js';

export interface TurnPlanExpectation {
  readonly turnId: string;
  readonly baseStateVersion: number;
}

export type TurnPlanSemanticResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] };

const PRIORITY_RANK: Readonly<Record<SotRpgjobCard.RPGJobCard['priority'], number>> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3
};

export function validateTurnPlanSemantics(
  plan: SotTurnPlan.TurnPlan,
  expected: TurnPlanExpectation
): TurnPlanSemanticResult {
  const errors: string[] = [];
  if (plan.turn_id !== expected.turnId) errors.push('plan:turn_id_mismatch');
  if (plan.base_state_version !== expected.baseStateVersion) errors.push('plan:base_state_version_mismatch');
  if (plan.decision === 'ASK_CLARIFICATION' && plan.player_intent.ambiguities.length === 0) {
    errors.push('plan:ask_requires_ambiguity');
  }
  if (plan.decision === 'DELEGATE' && plan.jobs.length === 0) errors.push('plan:delegate_requires_job');

  const jobsById = new Map<string, SotRpgjobCard.RPGJobCard>();
  const duplicateIds = new Set<string>();
  for (const job of plan.jobs) {
    // A worker cannot implement the DiceEngine port (physical C9 attempt 19).
    if (job.expected_output.type.toUpperCase() === 'ROLL_RESULT') {
      errors.push(`job:${job.job_id}:dice_engine_not_worker`);
    }
    if (jobsById.has(job.job_id)) duplicateIds.add(job.job_id);
    else jobsById.set(job.job_id, job);
    if (job.turn_id !== expected.turnId) errors.push(`job:${job.job_id}:turn_id_mismatch`);
    if (job.base_state_version !== expected.baseStateVersion) errors.push(`job:${job.job_id}:base_state_version_mismatch`);
  }
  for (const duplicateId of duplicateIds) errors.push(`plan:duplicate_job_id:${duplicateId}`);

  const blockingIds = new Set(plan.blocking_job_ids);
  for (const job of jobsById.values()) {
    if (job.blocking && !blockingIds.has(job.job_id)) errors.push(`plan:blocking_job_missing:${job.job_id}`);
    if (!job.blocking && blockingIds.has(job.job_id)) errors.push(`plan:blocking_job_not_blocking:${job.job_id}`);
  }
  for (const blockingId of blockingIds) {
    if (!jobsById.has(blockingId)) errors.push(`plan:blocking_job_unknown:${blockingId}`);
  }
  for (const job of jobsById.values()) {
    for (const dependency of job.dependencies) {
      const dependencyJob = jobsById.get(dependency);
      if (dependencyJob !== undefined && PRIORITY_RANK[dependencyJob.priority] > PRIORITY_RANK[job.priority]) {
        errors.push(`job:${job.job_id}:priority_inversion:${dependency}`);
      }
    }
  }
  const dag = validateJobDag(plan.jobs);
  if (!dag.ok) {
    errors.push(...dag.errors);
    // Preserve the plan diagnostic namespace without running a second graph traversal.
    const cycle = dag.errors.find(error => error.startsWith('dag:dependency_cycle:'));
    const self = dag.errors.find(error => error.endsWith(':self_dependency'));
    if (cycle !== undefined) errors.push(cycle.replace('dag:', 'plan:'));
    else if (self !== undefined) errors.push(`plan:dependency_cycle:${self.slice(4, -':self_dependency'.length)}`);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
