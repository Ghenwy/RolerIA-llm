import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import formatsPluginModule, { type FormatsPlugin } from 'ajv-formats';
import turnEnvelopeSchema from '../schemas/design/turn-envelope.schema.json' with { type: 'json' };
import campaignManifestSchema from '../schemas/design/campaign-manifest.schema.json' with { type: 'json' };
import campaignManifestV11Schema from '../schemas/design/campaign-manifest-v1.1.schema.json' with { type: 'json' };
import campaignManifestV12Schema from '../schemas/design/campaign-manifest-v1.2.schema.json' with { type: 'json' };
import fallbackHandoffSchema from '../schemas/design/fallback-handoff.schema.json' with { type: 'json' };
import runtimeProfileSchema from '../schemas/design/runtime-profile.schema.json' with { type: 'json' };
import runtimeProfileV11Schema from '../schemas/design/runtime-profile-v1.1.schema.json' with { type: 'json' };
import guidedTurnIntentSchema from '../schemas/design/guided-turn-intent-v1.schema.json' with { type: 'json' };
import narrationProposalSchema from '../schemas/design/narration-proposal-v1.schema.json' with { type: 'json' };
import healthChangeSchema from '../schemas/internal/health-change-v1.schema.json' with { type: 'json' };
import registeredTravelSchema from '../schemas/internal/registered-travel-v1.schema.json' with { type: 'json' };
import dnd35CharacterSheetSchema from '../schemas/sot/dnd35-character-sheet.schema.json' with { type: 'json' };
import compactionCommitSchema from '../schemas/internal/compaction-commit-v1.2.schema.json' with { type: 'json' };
import domainEventSchema from '../schemas/internal/domain-event-v1.1.schema.json' with { type: 'json' };
import dnd35AdapterEventSchema from '../schemas/internal/dnd35-adapter-event.schema.json' with { type: 'json' };
import dnd35ExoticRaceSchema from '../schemas/internal/dnd35-exotic-race.schema.json' with { type: 'json' };
import dnd35PrestigeClassSchema from '../schemas/internal/dnd35-prestige-class.schema.json' with { type: 'json' };
import memoryRecordSchema from '../schemas/internal/memory-record.schema.json' with { type: 'json' };
import mechanicalActionSchema from '../schemas/internal/mechanical-action-v1.schema.json' with { type: 'json' };
import mechanicalActionV11Schema from '../schemas/internal/mechanical-action-v1.1.schema.json' with { type: 'json' };
import knowledgeAcquisitionSchema from '../schemas/internal/knowledge-acquisition-v1.schema.json' with { type: 'json' };
import ruleSourceRecordSchema from '../schemas/internal/rule-source-record.schema.json' with { type: 'json' };
import workerAttemptSchema from '../schemas/internal/worker-attempt.schema.json' with { type: 'json' };
import workerQueueBatchSchema from '../schemas/internal/worker-queue-batch.schema.json' with { type: 'json' };
import compactionProposalSchema from '../schemas/sot/compaction-proposal.schema.json' with { type: 'json' };
import dnd35CharacterExtensionSchema from '../schemas/sot/d-d-3-5-character-extension.schema.json' with { type: 'json' };
import rpgJobCardSchema from '../schemas/sot/rpgjob-card.schema.json' with { type: 'json' };
import rpgWorkerResultSchema from '../schemas/sot/rpgworker-result.schema.json' with { type: 'json' };
import ruleQuerySchema from '../schemas/sot/rule-query.schema.json' with { type: 'json' };
import ruleResolutionSchema from '../schemas/sot/rule-resolution.schema.json' with { type: 'json' };
import turnPlanSchema from '../schemas/sot/turn-plan.schema.json' with { type: 'json' };
import turnResolutionSchema from '../schemas/sot/turn-resolution.schema.json' with { type: 'json' };

export type RuntimeContractName =
  | 'CampaignManifest'
  | 'CompactionCommit'
  | 'CompactionProposal'
  | 'DomainEvent'
  | 'Dnd35AdapterEvent'
  | 'Dnd35CharacterExtension'
  | 'Dnd35ExoticRace'
  | 'Dnd35PrestigeClass'
  | 'FallbackHandoff'
  | 'GuidedTurnIntent'
  | 'NarrationProposal'
  | 'HealthChange'
  | 'RegisteredTravel'
  | 'Dnd35Health'
  | 'MemoryRecord'
  | 'MechanicalAction'
  | 'KnowledgeAcquisition'
  | 'RPGJobCard'
  | 'RPGWorkerResult'
  | 'RuleQuery'
  | 'RuleResolution'
  | 'RuleSourceRecord'
  | 'RuntimeProfile'
  | 'TurnEnvelope'
  | 'TurnPlan'
  | 'TurnResolution'
  | 'WorkerAttempt'
  | 'WorkerQueueBatch';

export type RuntimeValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] };

const addFormats = (('default' in formatsPluginModule
  ? formatsPluginModule.default
  : formatsPluginModule) as FormatsPlugin);

function compile(schema: object): ValidateFunction {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

const validators: Readonly<Record<RuntimeContractName, ValidateFunction>> = {
  GuidedTurnIntent: compile(guidedTurnIntentSchema),
  NarrationProposal: compile(narrationProposalSchema),
  HealthChange: compile(healthChangeSchema),
  RegisteredTravel: compile(registeredTravelSchema),
  Dnd35Health: compile(dnd35CharacterSheetSchema.properties.health),
  CampaignManifest: compile({ oneOf: [campaignManifestSchema, campaignManifestV11Schema, campaignManifestV12Schema] }),
  CompactionCommit: compile(compactionCommitSchema),
  CompactionProposal: compile(compactionProposalSchema),
  DomainEvent: compile(domainEventSchema),
  Dnd35AdapterEvent: compile(dnd35AdapterEventSchema),
  Dnd35CharacterExtension: compile(dnd35CharacterExtensionSchema),
  Dnd35ExoticRace: compile(dnd35ExoticRaceSchema),
  Dnd35PrestigeClass: compile(dnd35PrestigeClassSchema),
  FallbackHandoff: compile(fallbackHandoffSchema),
  MemoryRecord: compile(memoryRecordSchema),
  MechanicalAction: compile({ oneOf: [mechanicalActionSchema, mechanicalActionV11Schema] }),
  KnowledgeAcquisition: compile(knowledgeAcquisitionSchema),
  RPGJobCard: compile(rpgJobCardSchema),
  RPGWorkerResult: compile(rpgWorkerResultSchema),
  RuleQuery: compile(ruleQuerySchema),
  RuleResolution: compile(ruleResolutionSchema),
  RuleSourceRecord: compile(ruleSourceRecordSchema),
  RuntimeProfile: compile({ oneOf: [runtimeProfileSchema, runtimeProfileV11Schema] }),
  TurnEnvelope: compile(turnEnvelopeSchema),
  TurnPlan: compile(turnPlanSchema),
  TurnResolution: compile(turnResolutionSchema),
  WorkerAttempt: compile(workerAttemptSchema),
  WorkerQueueBatch: compile(workerQueueBatchSchema)
};

const schemas: Readonly<Record<RuntimeContractName, object>> = {
  GuidedTurnIntent: guidedTurnIntentSchema,
  NarrationProposal: narrationProposalSchema,
  HealthChange: healthChangeSchema,
  RegisteredTravel: registeredTravelSchema,
  Dnd35Health: dnd35CharacterSheetSchema.properties.health,
  CampaignManifest: { oneOf: [campaignManifestSchema, campaignManifestV11Schema, campaignManifestV12Schema] },
  CompactionCommit: compactionCommitSchema,
  CompactionProposal: compactionProposalSchema,
  DomainEvent: domainEventSchema,
  Dnd35AdapterEvent: dnd35AdapterEventSchema,
  Dnd35CharacterExtension: dnd35CharacterExtensionSchema,
  Dnd35ExoticRace: dnd35ExoticRaceSchema,
  Dnd35PrestigeClass: dnd35PrestigeClassSchema,
  FallbackHandoff: fallbackHandoffSchema,
  MemoryRecord: memoryRecordSchema,
  MechanicalAction: { oneOf: [mechanicalActionSchema, mechanicalActionV11Schema] },
  KnowledgeAcquisition: knowledgeAcquisitionSchema,
  RPGJobCard: rpgJobCardSchema,
  RPGWorkerResult: rpgWorkerResultSchema,
  RuleQuery: ruleQuerySchema,
  RuleResolution: ruleResolutionSchema,
  RuleSourceRecord: ruleSourceRecordSchema,
  RuntimeProfile: { oneOf: [runtimeProfileSchema, runtimeProfileV11Schema] },
  TurnEnvelope: turnEnvelopeSchema,
  TurnPlan: turnPlanSchema,
  TurnResolution: turnResolutionSchema,
  WorkerAttempt: workerAttemptSchema,
  WorkerQueueBatch: workerQueueBatchSchema
};

function formatError(error: ErrorObject): string {
  const at = error.instancePath.length === 0 ? '/' : error.instancePath;
  return `${at}:${error.keyword}`;
}

export function validateRuntimeContract(name: RuntimeContractName, value: unknown): RuntimeValidationResult {
  const validate = validators[name];
  if (validate(value)) return { ok: true };
  return {
    ok: false,
    errors: (validate.errors ?? []).map(formatError).sort()
  };
}

export function validateJsonSchema(schema: object, value: unknown): RuntimeValidationResult {
  const validate = compile(schema);
  if (validate(value)) return { ok: true };
  return {
    ok: false,
    errors: (validate.errors ?? []).map(formatError).sort()
  };
}

export function runtimeContractSchema(name: RuntimeContractName): object {
  return structuredClone(schemas[name]);
}
