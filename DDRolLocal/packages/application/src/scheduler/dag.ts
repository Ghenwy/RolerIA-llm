import { validateRuntimeContract, type SotRpgjobCard } from '@nyx/contracts';

export const JOB_STATUSES = [
  'PENDING',
  'READY',
  'RUNNING',
  'COMPLETED',
  'PARTIAL',
  'BLOCKED',
  'FAILED',
  'STALE',
  'CANCELLED'
] as const satisfies readonly SotRpgjobCard.RPGJobCard['status'][];

export type JobStatus = (typeof JOB_STATUSES)[number];
export type JobPriority = SotRpgjobCard.RPGJobCard['priority'];

export interface ValidatedJobDag {
  readonly orderedJobIds: readonly string[];
  readonly readyJobIds: readonly string[];
}

export type JobDagValidationResult =
  | { readonly ok: true; readonly value: ValidatedJobDag }
  | { readonly ok: false; readonly errors: readonly string[] };

export type JobStatusTransitionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

const PRIORITY_RANK: Readonly<Record<JobPriority, number>> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3
};

const DEADLINE_BY_PRIORITY: Readonly<
  Record<JobPriority, SotRpgjobCard.RPGJobCard['budget']['deadline_class']>
> = {
  P0: 'before_resolution',
  P1: 'before_narration',
  P2: 'after_response',
  P3: 'idle'
};

const ALLOWED_TRANSITIONS: Readonly<Record<JobStatus, ReadonlySet<JobStatus>>> = {
  PENDING: new Set(['READY', 'BLOCKED', 'CANCELLED']),
  READY: new Set(['RUNNING', 'BLOCKED', 'CANCELLED']),
  RUNNING: new Set(['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED', 'STALE', 'CANCELLED']),
  COMPLETED: new Set(),
  PARTIAL: new Set(['PENDING']),
  BLOCKED: new Set(['PENDING']),
  FAILED: new Set(['PENDING']),
  STALE: new Set(['PENDING']),
  CANCELLED: new Set(['PENDING'])
};

function compareJobs(left: SotRpgjobCard.RPGJobCard, right: SotRpgjobCard.RPGJobCard): number {
  return PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority]
    || left.job_id.localeCompare(right.job_id, 'en');
}

function cycleStart(jobs: ReadonlyMap<string, SotRpgjobCard.RPGJobCard>): string | undefined {
  const visited = new Set<string>();
  const active = new Set<string>();

  const visit = (jobId: string): string | undefined => {
    if (active.has(jobId)) return jobId;
    if (visited.has(jobId)) return undefined;
    visited.add(jobId);
    active.add(jobId);
    const job = jobs.get(jobId);
    if (job !== undefined) {
      for (const dependency of job.dependencies) {
        if (dependency === jobId || !jobs.has(dependency)) continue;
        const cycle = visit(dependency);
        if (cycle !== undefined) return cycle;
      }
    }
    active.delete(jobId);
    return undefined;
  };

  for (const jobId of jobs.keys()) {
    const cycle = visit(jobId);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

function topologicalOrder(jobs: ReadonlyMap<string, SotRpgjobCard.RPGJobCard>): string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const job of jobs.values()) {
    const dependencies = new Set(job.dependencies.filter(dependency => dependency !== job.job_id && jobs.has(dependency)));
    indegree.set(job.job_id, dependencies.size);
    for (const dependency of dependencies) {
      const current = dependents.get(dependency) ?? [];
      current.push(job.job_id);
      dependents.set(dependency, current);
    }
  }

  const available = [...jobs.values()].filter(job => indegree.get(job.job_id) === 0).sort(compareJobs);
  const ordered: string[] = [];
  while (available.length > 0) {
    const next = available.shift();
    if (next === undefined) break;
    ordered.push(next.job_id);
    for (const dependentId of dependents.get(next.job_id) ?? []) {
      const remaining = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, remaining);
      if (remaining === 0) {
        const dependent = jobs.get(dependentId);
        if (dependent !== undefined) {
          available.push(dependent);
          available.sort(compareJobs);
        }
      }
    }
  }
  return ordered;
}

export function validateJobDag(jobs: readonly SotRpgjobCard.RPGJobCard[]): JobDagValidationResult {
  const errors: string[] = [];
  const jobsById = new Map<string, SotRpgjobCard.RPGJobCard>();

  for (const [index, job] of jobs.entries()) {
    const contract = validateRuntimeContract('RPGJobCard', job);
    const jobId = typeof job.job_id === 'string' ? job.job_id : `INDEX-${index}`;
    if (!contract.ok) {
      errors.push(...contract.errors.map(error => `job:${jobId}:contract:${error}`));
    }
    if (jobsById.has(jobId)) {
      errors.push(`dag:duplicate_job_id:${jobId}`);
      continue;
    }
    jobsById.set(jobId, job);
  }

  for (const job of jobsById.values()) {
    const expectedDeadline = DEADLINE_BY_PRIORITY[job.priority];
    if (job.budget.deadline_class !== expectedDeadline) {
      errors.push(`job:${job.job_id}:deadline_class_mismatch:${expectedDeadline}`);
    }
    if (job.priority === 'P0' && !job.blocking) {
      errors.push(`job:${job.job_id}:p0_must_block_resolution`);
    }
    if ((job.priority === 'P2' || job.priority === 'P3') && job.blocking) {
      errors.push(`job:${job.job_id}:background_must_not_block`);
    }

    const seenDependencies = new Set<string>();
    for (const dependency of job.dependencies) {
      if (seenDependencies.has(dependency)) {
        errors.push(`job:${job.job_id}:duplicate_dependency:${dependency}`);
        continue;
      }
      seenDependencies.add(dependency);
      if (!jobsById.has(dependency)) errors.push(`job:${job.job_id}:unknown_dependency:${dependency}`);
      if (dependency === job.job_id) errors.push(`job:${job.job_id}:self_dependency`);
    }
  }

  const cycle = cycleStart(jobsById);
  if (cycle !== undefined) errors.push(`dag:dependency_cycle:${cycle}`);
  if (errors.length > 0) return { ok: false, errors };

  const orderedJobIds = topologicalOrder(jobsById);
  const readyJobIds = orderedJobIds.filter(jobId => {
    const job = jobsById.get(jobId);
    return job?.status === 'READY'
      && job.dependencies.every(dependency => jobsById.get(dependency)?.status === 'COMPLETED');
  });
  return { ok: true, value: { orderedJobIds, readyJobIds } };
}

export function validateJobStatusTransition(from: JobStatus, to: JobStatus): JobStatusTransitionResult {
  return ALLOWED_TRANSITIONS[from].has(to)
    ? { ok: true }
    : { ok: false, error: `transition:${from}->${to}:not_allowed` };
}
