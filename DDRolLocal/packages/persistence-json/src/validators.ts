import fs from 'node:fs';
import path from 'node:path';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import formatsPluginModule, { type FormatsPlugin } from 'ajv-formats';
import type { AtomicEvent, CampaignState } from '@nyx/domain';

const schemaRoot = path.resolve(import.meta.dirname, '../../contracts/schemas');
const addFormats = (('default' in formatsPluginModule ? formatsPluginModule.default : formatsPluginModule) as FormatsPlugin);
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);

function schema(relativePath: string): object {
  return JSON.parse(fs.readFileSync(path.join(schemaRoot, relativePath), 'utf8')) as object;
}

const validateCampaignState = ajv.compile(schema('internal/campaign-state.schema.json'));
const validateAtomicEvent = ajv.compile(schema('internal/domain-event-v1.1.schema.json'));
const validateInventory = ajv.compile(schema('sot/inventory.schema.json'));
const validateJournalV1 = ajv.compile(schema('internal/transaction-journal.schema.json'));
const validateJournalV11 = ajv.compile(schema('internal/transaction-journal-v1.1.schema.json'));
const validateTranscriptEntry = ajv.compile(schema('internal/transcript-entry.schema.json'));
const validateCheckpointManifest = ajv.compile(schema('internal/checkpoint-manifest-v1.1.schema.json'));
const validateCheckpointManifestV12 = ajv.compile(schema('internal/checkpoint-manifest-v1.2.schema.json'));
const validateTimelineEntry = ajv.compile(schema('internal/timeline-entry.schema.json'));
const validateWriterLock = ajv.compile(schema('internal/writer-lock.schema.json'));

function errorsOf(validate: ValidateFunction): string[] {
  return (validate.errors ?? []).map((error: ErrorObject) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`);
}

export function validateStateSchema(state: CampaignState): string[] {
  const errors: string[] = [];
  if (!validateCampaignState(state)) errors.push(...errorsOf(validateCampaignState));
  for (const [inventoryId, inventory] of Object.entries(state.inventories)) {
    if (!validateInventory(inventory)) errors.push(...errorsOf(validateInventory).map(error => `/inventories/${inventoryId}${error}`));
  }
  return errors;
}

export function validateEventSchema(event: AtomicEvent): string[] {
  return validateAtomicEvent(event) ? [] : errorsOf(validateAtomicEvent);
}

export function validateJournalSchema(journal: unknown): string[] {
  const version = typeof journal === 'object' && journal !== null ? (journal as Record<string, unknown>)['schema_version'] : undefined;
  const validator = version === '1.0' ? validateJournalV1 : validateJournalV11;
  return validator(journal) ? [] : errorsOf(validator);
}

export function validateTranscriptSchema(entry: unknown): string[] {
  return validateTranscriptEntry(entry) ? [] : errorsOf(validateTranscriptEntry);
}

export function validateCheckpointSchema(manifest: unknown): string[] {
  const version = typeof manifest === 'object' && manifest !== null ? (manifest as Record<string, unknown>)['schema_version'] : undefined;
  const validator = version === '1.2' ? validateCheckpointManifestV12 : validateCheckpointManifest;
  return validator(manifest) ? [] : errorsOf(validator);
}

export function validateTimelineSchema(entry: unknown): string[] {
  return validateTimelineEntry(entry) ? [] : errorsOf(validateTimelineEntry);
}

export function validateWriterLockSchema(lock: unknown): string[] {
  return validateWriterLock(lock) ? [] : errorsOf(validateWriterLock);
}
