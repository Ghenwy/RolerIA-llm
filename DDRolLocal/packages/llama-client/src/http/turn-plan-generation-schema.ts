import { runtimeContractSchema } from '@nyx/contracts';

export interface TurnPlanGenerationExpectation {
  readonly turnId: string;
  readonly baseStateVersion: number;
}

type JsonObject = Record<string, unknown>;
type TurnPlanDecision = 'DIRECT' | 'DELEGATE' | 'ASK_CLARIFICATION' | 'BLOCKED';
type JobPriority = 'P0' | 'P1' | 'P2' | 'P3';

const DEADLINE_BY_PRIORITY: Readonly<Record<JobPriority, string>> = {
  P0: 'before_resolution',
  P1: 'before_narration',
  P2: 'after_response',
  P3: 'idle'
};

function objectAt(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`Invalid protected TurnPlan schema at ${path}.`);
  }
  return value as JsonObject;
}

function withoutSchemaIdentifiers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSchemaIdentifiers);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== '$schema' && key !== '$id')
      .map(([key, nested]) => [key, withoutSchemaIdentifiers(nested)])
  );
}

/** Generation must supply the explicit scope required by the independent worker guard. */
export function npcScopedJobSchema(value: JsonObject): JsonObject {
  const npc = structuredClone(value);
  const other = structuredClone(value);
  const npcProperties = objectAt(npc['properties'], '/job/properties');
  const otherProperties = objectAt(other['properties'], '/job/properties');
  const workerTypes = objectAt(otherProperties['worker_id'], '/worker_id')['enum'] as string[];
  npcProperties['worker_id'] = { const: 'rpg.npc_director' };
  otherProperties['worker_id'] = { enum: workerTypes.filter(id => id !== 'rpg.npc_director') };
  const inputs = objectAt(objectAt(npcProperties['inputs'], '/inputs')['properties'], '/inputs/properties');
  inputs['state_refs'] = { type: 'array', minItems: 1, items: { type: 'string', pattern: '^subject:[A-Za-z0-9_-]+$' } };
  return { oneOf: [npc, other] };
}

function jobPriorityBranch(value: JsonObject, priority: JobPriority): JsonObject {
  const branch = objectAt(withoutSchemaIdentifiers(value), '/properties/jobs/items/oneOf');
  const properties = objectAt(branch['properties'], '/properties/jobs/items/oneOf/properties');
  properties['priority'] = { const: priority };
  const budget = objectAt(properties['budget'], '/properties/jobs/items/oneOf/properties/budget');
  const budgetProperties = objectAt(
    budget['properties'],
    '/properties/jobs/items/oneOf/properties/budget/properties'
  );
  budgetProperties['deadline_class'] = { const: DEADLINE_BY_PRIORITY[priority] };
  if (priority === 'P0') properties['blocking'] = { const: true };
  if (priority === 'P2' || priority === 'P3') properties['blocking'] = { const: false };
  return npcScopedJobSchema(branch);
}

function decisionBranch(
  decision: TurnPlanDecision,
  expected: TurnPlanGenerationExpectation
): JsonObject {
  const branch = objectAt(withoutSchemaIdentifiers(runtimeContractSchema('TurnPlan')), '/');
  const properties = objectAt(branch['properties'], '/properties');
  properties['decision'] = { const: decision };
  properties['turn_id'] = { ...objectAt(properties['turn_id'], '/properties/turn_id'), const: expected.turnId };
  properties['base_state_version'] = {
    ...objectAt(properties['base_state_version'], '/properties/base_state_version'),
    const: expected.baseStateVersion
  };

  const jobs = objectAt(properties['jobs'], '/properties/jobs');
  const job = objectAt(jobs['items'], '/properties/jobs/items');
  const jobProperties = objectAt(job['properties'], '/properties/jobs/items/properties');
  jobProperties['turn_id'] = {
    ...objectAt(jobProperties['turn_id'], '/properties/jobs/items/properties/turn_id'),
    const: expected.turnId
  };
  jobProperties['base_state_version'] = {
    ...objectAt(jobProperties['base_state_version'], '/properties/jobs/items/properties/base_state_version'),
    const: expected.baseStateVersion
  };
  jobs['items'] = {
    oneOf: (['P0', 'P1', 'P2', 'P3'] as const).map(priority => jobPriorityBranch(job, priority))
  };

  if (decision === 'DELEGATE') {
    jobs['minItems'] = 1;
  } else {
    jobs['maxItems'] = 0;
    const blockingJobIds = objectAt(properties['blocking_job_ids'], '/properties/blocking_job_ids');
    blockingJobIds['maxItems'] = 0;
  }

  if (decision === 'ASK_CLARIFICATION') {
    const playerIntent = objectAt(properties['player_intent'], '/properties/player_intent');
    const intentProperties = objectAt(playerIntent['properties'], '/properties/player_intent/properties');
    const ambiguities = objectAt(intentProperties['ambiguities'], '/properties/player_intent/properties/ambiguities');
    ambiguities['minItems'] = 1;
  }
  return branch;
}

/**
 * [DESIGN] Generation-only semantic overlay. The protected SOT schema remains
 * the runtime contract; this disjoint union narrows what llama.cpp may emit.
 */
export function turnPlanGenerationSchema(expected: TurnPlanGenerationExpectation): object {
  if (expected.turnId.length === 0 || !Number.isSafeInteger(expected.baseStateVersion) || expected.baseStateVersion < 0) {
    throw new TypeError('TurnPlan generation expectation is invalid.');
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'TurnPlanGenerationOverlay',
    oneOf: (['DIRECT', 'DELEGATE', 'ASK_CLARIFICATION', 'BLOCKED'] as const)
      .map(decision => decisionBranch(decision, expected))
  };
}
