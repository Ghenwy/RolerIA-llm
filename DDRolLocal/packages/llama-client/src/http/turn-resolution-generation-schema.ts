import { runtimeContractSchema } from '@nyx/contracts';
import type { MechanicalAction } from '@nyx/application';
import { npcScopedJobSchema } from './turn-plan-generation-schema.js';
import { NARRATION_SENTENCE_PATTERN } from './narration-boundary.js';

export interface TurnResolutionGenerationExpectation {
  readonly turnId: string;
  readonly baseStateVersion: number;
  readonly pendingExplicitExpression?: string;
  readonly mechanicalAction?: MechanicalAction | null;
}

type JsonObject = Record<string, unknown>;
type ResolutionStatus = 'READY' | 'AWAITING_ROLL' | 'AWAITING_WORKER' | 'BLOCKED';

function objectAt(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`Invalid protected schema at ${path}.`);
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

function awaitedWorkerMarker(expected: TurnResolutionGenerationExpectation): JsonObject {
  const job = objectAt(withoutSchemaIdentifiers(runtimeContractSchema('RPGJobCard')), '/job');
  const properties = objectAt(job['properties'], '/job/properties');
  properties['turn_id'] = { ...objectAt(properties['turn_id'], '/job/turn_id'), const: expected.turnId };
  properties['base_state_version'] = {
    ...objectAt(properties['base_state_version'], '/job/base_state_version'),
    const: expected.baseStateVersion
  };
  properties['priority'] = { const: 'P0' };
  properties['blocking'] = { const: true };
  properties['status'] = { enum: ['PENDING', 'READY'] };
  const budget = objectAt(properties['budget'], '/job/budget');
  const budgetProperties = objectAt(budget['properties'], '/job/budget/properties');
  budgetProperties['deadline_class'] = { const: 'before_resolution' };
  const dependencies = objectAt(properties['dependencies'], '/job/dependencies');
  dependencies['maxItems'] = 0;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'job'],
    properties: {
      kind: { const: 'required_worker_job' },
      job: npcScopedJobSchema(job)
    }
  };
}

function statusBranch(status: ResolutionStatus, expected: TurnResolutionGenerationExpectation): JsonObject {
  const branch = objectAt(withoutSchemaIdentifiers(runtimeContractSchema('TurnResolution')), '/');
  const properties = objectAt(branch['properties'], '/properties');
  properties['resolution_status'] = { const: status };
  properties['turn_id'] = { ...objectAt(properties['turn_id'], '/turn_id'), const: expected.turnId };
  properties['base_state_version'] = {
    ...objectAt(properties['base_state_version'], '/base_state_version'),
    const: expected.baseStateVersion
  };
  const events = objectAt(properties['events_to_commit'], '/events_to_commit');
  const event = objectAt(withoutSchemaIdentifiers(runtimeContractSchema('DomainEvent')), '/event');
  const eventProperties = objectAt(event['properties'], '/event/properties');
  eventProperties['turn_id'] = { const: expected.turnId };
  const types = objectAt(eventProperties['event_type'], '/event/event_type')['enum'] as string[];
  const subjectEvents = ['NPC_KNOWLEDGE_ADDED', 'NPC_BELIEF_CHANGED'];
  // These payloads previously passed grammar as arbitrary objects and failed every StateEngine replan.
  const subjectBranches = subjectEvents.map(type => {
    const idKey = type === 'NPC_KNOWLEDGE_ADDED' ? 'knowledge_id' : 'belief_id';
    const isKnowledge = type === 'NPC_KNOWLEDGE_ADDED';
    return { ...event, properties: { ...eventProperties, event_type: { const: type }, payload: {
      type: 'object', additionalProperties: false, required: ['subject_id', idKey, 'value', ...(isKnowledge ? ['acquisition'] : [])],
      properties: { subject_id: { type: 'string', minLength: 1 }, [idKey]: { type: 'string', minLength: 1 },
        value: isKnowledge ? { type: 'object' } : { anyOf: [{ type: 'string', minLength: 1 }, { type: 'object' }] },
        ...(isKnowledge ? { acquisition: withoutSchemaIdentifiers(runtimeContractSchema('KnowledgeAcquisition')) } : {}) }
    } } };
  });
  events['items'] = { oneOf: [...subjectBranches, { ...event, properties: {
    ...eventProperties, event_type: { enum: types.filter(type => !subjectEvents.includes(type) && type !== 'DICE_ROLLED') }
  } }] };
  events['maxItems'] = status === 'READY' ? 32 : 0;
  const patches = objectAt(properties['patches_to_commit'], '/patches_to_commit');
  patches['maxItems'] = 0;
  const narration = objectAt(properties['player_facing_narration'], '/player_facing_narration');
  narration['maxLength'] = 1_200;
  if (status === 'READY') {
    narration['minLength'] = 1;
    narration['pattern'] = NARRATION_SENTENCE_PATTERN;
  }
  const requiredRolls = objectAt(properties['required_rolls'], '/required_rolls');
  if (status === 'AWAITING_ROLL') {
    requiredRolls['minItems'] = 1;
    requiredRolls['maxItems'] = expected.pendingExplicitExpression === undefined ? 16 : 1;
    requiredRolls['items'] = { type: 'object', required: ['roll_id', 'expression'],
      properties: { roll_id: { type: 'string', minLength: 1 }, expression: { type: 'string',
        pattern: '^[1-9][0-9]*d[1-9][0-9]*([+-][0-9]+)?$',
        ...(expected.pendingExplicitExpression === undefined ? {} : { const: expected.pendingExplicitExpression }) } } };
  }
  else requiredRolls['maxItems'] = 0;
  const openThreads = objectAt(properties['open_threads'], '/open_threads');
  openThreads['maxItems'] = 16;
  const memorySignals = objectAt(properties['memory_signals'], '/memory_signals');
  memorySignals['maxItems'] = 16;
  if (status === 'AWAITING_WORKER') {
    // llama.cpp b10760 compiles items/minItems/maxItems, but not contains.
    // One required dependency, represented by a complete job, must be enforced during generation too.
    openThreads['items'] = awaitedWorkerMarker(expected);
    openThreads['minItems'] = 1;
    openThreads['maxItems'] = 1;
  }
  const mechanical = expected.mechanicalAction;
  if (mechanical != null) {
    events['maxItems'] = 0;
    if (status === 'AWAITING_ROLL' && mechanical.next_roll !== null) {
      requiredRolls['minItems'] = 1;
      requiredRolls['maxItems'] = 1;
      requiredRolls['items'] = { type: 'object', additionalProperties: false, required: ['roll_id', 'expression'],
        properties: { roll_id: { const: mechanical.next_roll.roll_id }, expression: { const: mechanical.next_roll.expression } } };
    }
    if (status === 'READY') properties['player_facing_narration'] = { type: 'string', const: mechanical.narration };
  }
  return branch;
}

/** [DESIGN] Generation-only overlay; protected TurnResolution remains unchanged. */
export function turnResolutionGenerationSchema(expected: TurnResolutionGenerationExpectation): object {
  if (expected.turnId.length === 0 || !Number.isSafeInteger(expected.baseStateVersion) || expected.baseStateVersion < 0) {
    throw new TypeError('TurnResolution generation expectation is invalid.');
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'TurnResolutionGenerationOverlay',
    oneOf: (['READY', 'AWAITING_ROLL', 'AWAITING_WORKER', 'BLOCKED'] as const)
      .filter(status => status !== 'READY' || expected.pendingExplicitExpression === undefined)
      .filter(status => expected.mechanicalAction === undefined
        || (expected.mechanicalAction === null ? status !== 'AWAITING_ROLL'
          : status !== (expected.mechanicalAction.next_roll === null ? 'AWAITING_ROLL' : 'READY')))
      .map(status => statusBranch(status, expected))
  };
}
