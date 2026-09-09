import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  InternalCheckpointManifestV11,
  InternalCheckpointManifestV12,
  InternalTimelineEntry
} from '@nyx/contracts';
import {
  cloneJson,
  err,
  ok,
  validateCampaignInvariants,
  type AtomicEvent,
  type CampaignState,
  type Result
} from '@nyx/domain';
import type { OperationalLogger } from '@nyx/observability';
import { canonicalJson, sha256 } from './canonical-json.js';
import { captureDnd35Boundary, readBoundFile, readCheckpointArtifacts } from './checkpoint-artifacts.js';
import { ensureDirectory, exists, writeDurable } from './durable-files.js';
import type { JsonCampaignStore } from './json-campaign-store.js';
import {
  InjectedCheckpointFault,
  type CheckpointFaultPoint,
  type CheckpointStoreOptions,
  type PersistenceError
} from './types.js';
import {
  validateCheckpointSchema,
  validateEventSchema,
  validateStateSchema,
  validateTimelineSchema
} from './validators.js';

export type CheckpointManifest = InternalCheckpointManifestV11.CheckpointManifestV11 | InternalCheckpointManifestV12.CheckpointManifestV12;
export type TimelineEntry = InternalTimelineEntry.TimelineEntryV1;

export interface CreateCheckpointInput {
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  state: CampaignState;
  event_log: AtomicEvent[];
  campaign_time: string;
  schema_fingerprints: Record<string, string>;
  prompt_fingerprints: Record<string, string>;
  model_fingerprint: string;
  created_at: string;
}

export interface LoadedCheckpoint {
  manifest: CheckpointManifest;
  state: CampaignState;
  events: AtomicEvent[];
  discard_kv_cache: true;
}

function safeCheckpointId(value: string): string {
  if (!/^CHECKPOINT-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error(`Unsafe checkpoint_id: ${value}`);
  return value;
}

function safeBranchId(value: string): string {
  if (!/^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error(`Unsafe branch_id: ${value}`);
  return value;
}

export class JsonCheckpointStore {
  readonly #root: string;
  readonly #checkpointsDirectory: string;
  readonly #timelineDirectory: string;
  readonly #campaigns: JsonCampaignStore;
  readonly #observability: OperationalLogger | undefined;
  readonly #options: CheckpointStoreOptions;

  constructor(
    campaignRoot: string,
    campaigns: JsonCampaignStore,
    observability?: OperationalLogger,
    options: CheckpointStoreOptions = {}
  ) {
    this.#root = path.resolve(campaignRoot);
    this.#checkpointsDirectory = path.join(this.#root, 'checkpoints');
    this.#timelineDirectory = path.join(this.#root, 'timeline');
    this.#campaigns = campaigns;
    this.#observability = observability;
    this.#options = options;
  }

  #fault(point: CheckpointFaultPoint): void {
    this.#options.fault_injector?.(point);
  }

  #checkpointDirectory(checkpointId: string): string {
    return path.join(this.#checkpointsDirectory, safeCheckpointId(checkpointId));
  }

  #checkpointFile(checkpointDirectory: string, relativeFile: string): string {
    const target = path.resolve(checkpointDirectory, relativeFile);
    if (!target.startsWith(`${path.resolve(checkpointDirectory)}${path.sep}`)) throw new Error(`Unsafe checkpoint path: ${relativeFile}`);
    return target;
  }

  async create(input: CreateCheckpointInput): Promise<Result<CheckpointManifest, PersistenceError>> {
    const stateErrors = [
      ...validateStateSchema(input.state),
      ...validateCampaignInvariants(input.state).map(error => `${error.path} ${error.message}`)
    ];
    if (stateErrors.length > 0) return err({ code: 'INVALID_STATE', message: 'El checkpoint recibió un estado inválido.', details: stateErrors });
    for (const event of input.event_log) {
      const eventErrors = validateEventSchema(event);
      if (eventErrors.length > 0) return err({ code: 'INVALID_EVENT', message: `Evento inválido en checkpoint: ${event.event_id}.`, details: eventErrors });
    }
    if (input.parent_checkpoint_id !== null) {
      const parent = await this.verify(input.parent_checkpoint_id);
      if (!parent.ok) return parent;
    }
    const finalDirectory = this.#checkpointDirectory(input.checkpoint_id);
    if (await exists(finalDirectory)) return this.verify(input.checkpoint_id);
    const tempDirectory = path.join(this.#checkpointsDirectory, `.${safeCheckpointId(input.checkpoint_id)}.tmp`);
    try {
      const boundary = await captureDnd35Boundary(this.#root, input.state.campaign_id, input.state.branch_id);
      await ensureDirectory(this.#checkpointsDirectory);
      if (await exists(tempDirectory)) await fs.rm(tempDirectory, { recursive: true, force: true });
      await ensureDirectory(tempDirectory);
      const stateText = canonicalJson(input.state);
      const eventText = input.event_log.map(canonicalJson).join('');
      const stateFile = 'state.json';
      const eventFile = 'events.jsonl';
      await writeDurable(path.join(tempDirectory, stateFile), stateText);
      this.#fault('AFTER_STATE_WRITTEN');
      await writeDurable(path.join(tempDirectory, eventFile), eventText);
      this.#fault('AFTER_EVENTS_WRITTEN');
      for (const artifact of boundary.artifacts) {
        await writeDurable(path.join(tempDirectory, artifact.entry.relative_path), artifact.bytes);
      }
      this.#fault('AFTER_ARTIFACTS_WRITTEN');
      const manifest: CheckpointManifest = {
        schema_version: '1.2',
        artifacts: boundary.artifacts.map(artifact => artifact.entry),
        checkpoint_id: input.checkpoint_id,
        campaign_id: input.state.campaign_id,
        branch_id: input.state.branch_id,
        parent_checkpoint_id: input.parent_checkpoint_id,
        state_version: input.state.state_version,
        state_file: stateFile,
        state_sha256: sha256(stateText),
        event_file: eventFile,
        event_count: input.event_log.length,
        event_tail_event_id: input.event_log.at(-1)?.event_id ?? null,
        event_tail_hash: sha256(eventText),
        campaign_time: input.campaign_time,
        rng_hash: sha256(canonicalJson(input.state.rng)),
        schema_fingerprints: input.schema_fingerprints,
        prompt_fingerprints: input.prompt_fingerprints,
        model_fingerprint: input.model_fingerprint,
        created_at: input.created_at
      };
      const manifestErrors = validateCheckpointSchema(manifest);
      if (manifestErrors.length > 0) {
        await fs.rm(tempDirectory, { recursive: true, force: true });
        return err({ code: 'INVALID_STATE', message: 'El manifest de checkpoint es inválido.', details: manifestErrors });
      }
      await writeDurable(path.join(tempDirectory, 'manifest.json'), canonicalJson(manifest));
      this.#fault('AFTER_MANIFEST_WRITTEN');
      await fs.rename(tempDirectory, finalDirectory);
      this.#fault('AFTER_RENAMED');
      try {
        this.#observability?.record({
          correlationId: `${manifest.campaign_id}-${manifest.checkpoint_id}`,
          component: 'checkpoint',
          operation: 'create',
          code: 'CHECKPOINT_CREATED',
          status: 'PASS',
          campaignId: manifest.campaign_id,
          checkpointId: manifest.checkpoint_id,
          stateVersion: manifest.state_version,
          hashes: {
            state_sha256: manifest.state_sha256,
            event_tail_sha256: manifest.event_tail_hash,
            rng_sha256: manifest.rng_hash
          }
        });
      } catch {
        // El checkpoint confirmado no depende del sink operativo.
      }
      return ok(manifest);
    } catch (error) {
      if (error instanceof InjectedCheckpointFault) throw error;
      if (await exists(tempDirectory)) await fs.rm(tempDirectory, { recursive: true, force: true });
      return err({ code: 'IO_ERROR', message: 'No se pudo crear el checkpoint.', details: [String(error)] });
    }
  }

  async #readManifest(checkpointId: string): Promise<Result<CheckpointManifest, PersistenceError>> {
    try {
      const file = path.join(this.#checkpointDirectory(checkpointId), 'manifest.json');
      if (!(await exists(file))) return err({ code: 'NOT_FOUND', message: `No existe ${checkpointId}.` });
      const manifest = JSON.parse((await readBoundFile(this.#root, `checkpoints/${safeCheckpointId(checkpointId)}/manifest.json`)).toString('utf8')) as CheckpointManifest;
      const errors = validateCheckpointSchema(manifest);
      return errors.length === 0
        ? ok(manifest)
        : err({ code: 'CORRUPT_DATA', message: `Manifest inválido en ${checkpointId}.`, details: errors });
    } catch (error) {
      return err({ code: 'CORRUPT_DATA', message: `No se pudo leer ${checkpointId}.`, details: [String(error)] });
    }
  }

  async verify(checkpointId: string): Promise<Result<CheckpointManifest, PersistenceError>> {
    const manifestResult = await this.#readManifest(checkpointId);
    if (!manifestResult.ok) return manifestResult;
    const manifest = manifestResult.value;
    try {
      const directory = this.#checkpointDirectory(checkpointId);
      if (manifest.checkpoint_id !== checkpointId) throw new Error('Checkpoint identity mismatch');
      if (manifest.schema_version === '1.2') await readCheckpointArtifacts(this.#root, checkpointId, manifest.campaign_id);
      const stateText = (await readBoundFile(directory, manifest.state_file)).toString('utf8');
      const eventText = (await readBoundFile(directory, manifest.event_file)).toString('utf8');
      if (sha256(stateText) !== manifest.state_sha256 || sha256(eventText) !== manifest.event_tail_hash) {
        return err({ code: 'CHECKPOINT_HASH_MISMATCH', message: `Hash inválido en ${checkpointId}.` });
      }
      const state = JSON.parse(stateText) as CampaignState;
      const events = eventText
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as AtomicEvent);
      if (
        state.campaign_id !== manifest.campaign_id ||
        state.branch_id !== manifest.branch_id ||
        state.state_version !== manifest.state_version ||
        sha256(canonicalJson(state.rng)) !== manifest.rng_hash ||
        events.length !== manifest.event_count ||
        (events.at(-1)?.event_id ?? null) !== manifest.event_tail_event_id ||
        validateStateSchema(state).length > 0 ||
        validateCampaignInvariants(state).length > 0 ||
        events.some(event => validateEventSchema(event).length > 0)
      ) {
        return err({ code: 'CHECKPOINT_HASH_MISMATCH', message: `Contenido inconsistente en ${checkpointId}.` });
      }
      return ok(manifest);
    } catch (error) {
      return err({ code: 'CHECKPOINT_HASH_MISMATCH', message: `No se pudo verificar ${checkpointId}.`, details: [String(error)] });
    }
  }

  async load(checkpointId: string): Promise<Result<LoadedCheckpoint, PersistenceError>> {
    const verified = await this.verify(checkpointId);
    if (!verified.ok) return verified;
    try {
      const directory = this.#checkpointDirectory(checkpointId);
      const state = JSON.parse(await fs.readFile(this.#checkpointFile(directory, verified.value.state_file), 'utf8')) as CampaignState;
      const events = (await fs.readFile(this.#checkpointFile(directory, verified.value.event_file), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as AtomicEvent);
      return ok({ manifest: verified.value, state, events, discard_kv_cache: true });
    } catch (error) {
      return err({ code: 'CORRUPT_DATA', message: `No se pudo cargar ${checkpointId}.`, details: [String(error)] });
    }
  }

  async #appendTimeline(entry: TimelineEntry): Promise<Result<void, PersistenceError>> {
    const validation = validateTimelineSchema(entry);
    if (validation.length > 0) return err({ code: 'INVALID_STATE', message: 'Entrada timeline inválida.', details: validation });
    const current = await this.timeline();
    if (!current.ok) return current;
    const duplicate = current.value.find(candidate => candidate.timeline_event_id === entry.timeline_event_id);
    if (duplicate) {
      return canonicalJson(duplicate) === canonicalJson(entry)
        ? ok(undefined)
        : err({ code: 'RECORD_ID_CONFLICT', message: `timeline_event_id ${entry.timeline_event_id} en conflicto.` });
    }
    try {
      await ensureDirectory(this.#timelineDirectory);
      const handle = await fs.open(path.join(this.#timelineDirectory, 'entries.jsonl'), 'a');
      try {
        await handle.writeFile(canonicalJson(entry), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return ok(undefined);
    } catch (error) {
      return err({ code: 'IO_ERROR', message: 'No se pudo anexar al timeline.', details: [String(error)] });
    }
  }

  #timelineEntry(
    type: TimelineEntry['type'],
    manifest: CheckpointManifest,
    branchId: string,
    parentBranchId: string | null,
    occurredAt: string
  ): TimelineEntry {
    return {
      schema_version: '1.0',
      timeline_event_id: `TIMELINE-${sha256(`${type}:${branchId}:${occurredAt}`).slice(0, 24)}`,
      type,
      campaign_id: manifest.campaign_id,
      branch_id: branchId,
      parent_branch_id: parentBranchId,
      parent_checkpoint_id: manifest.checkpoint_id,
      occurred_at: occurredAt
    };
  }

  async #restoreAsBranch(
    checkpointId: string,
    newBranchId: string
  ): Promise<Result<{ manifest: CheckpointManifest; state: CampaignState }, PersistenceError>> {
    safeBranchId(newBranchId);
    const loaded = await this.load(checkpointId);
    if (!loaded.ok) return loaded;
    try {
      await readCheckpointArtifacts(this.#root, checkpointId, loaded.value.manifest.campaign_id);
      const timeline = await this.timeline();
      if (!timeline.ok) return timeline;
      if (newBranchId === loaded.value.manifest.branch_id || timeline.value.some(entry => entry.branch_id === newBranchId)) {
        return err({ code: 'RECORD_ID_CONFLICT', message: 'La rama ya tiene identidad o linaje.' });
      }
    } catch (error) {
      return err({ code: 'CORRUPT_DATA', message: 'No se puede restaurar la autoridad D&D.', details: [String(error)] });
    }
    const state = cloneJson(loaded.value.state);
    state.branch_id = newBranchId;
    const initialized = await this.#campaigns.initialize(state);
    if (!initialized.ok) return initialized;
    return ok({ manifest: loaded.value.manifest, state });
  }

  async branch(checkpointId: string, newBranchId: string, occurredAt: string): Promise<Result<CampaignState, PersistenceError>> {
    const restored = await this.#restoreAsBranch(checkpointId, newBranchId);
    if (!restored.ok) return restored;
    this.#fault('BEFORE_BRANCH_TIMELINE');
    const timeline = await this.#appendTimeline(
      this.#timelineEntry('BRANCH_CREATED', restored.value.manifest, newBranchId, restored.value.manifest.branch_id, occurredAt)
    );
    return timeline.ok ? ok(restored.value.state) : timeline;
  }

  async rollback(
    checkpointId: string,
    currentBranchId: string,
    newBranchId: string,
    occurredAt: string
  ): Promise<Result<CampaignState, PersistenceError>> {
    safeBranchId(currentBranchId);
    const restored = await this.#restoreAsBranch(checkpointId, newBranchId);
    if (!restored.ok) return restored;
    this.#fault('BEFORE_BRANCH_TIMELINE');
    const deactivated = await this.#appendTimeline(
      this.#timelineEntry('BRANCH_DEACTIVATED', restored.value.manifest, currentBranchId, restored.value.manifest.branch_id, occurredAt)
    );
    if (!deactivated.ok) return deactivated;
    const created = await this.#appendTimeline(
      this.#timelineEntry('BRANCH_CREATED', restored.value.manifest, newBranchId, restored.value.manifest.branch_id, occurredAt)
    );
    return created.ok ? ok(restored.value.state) : created;
  }

  async timeline(): Promise<Result<TimelineEntry[], PersistenceError>> {
    try {
      const file = path.join(this.#timelineDirectory, 'entries.jsonl');
      if (!(await exists(file))) return ok([]);
      const text = await fs.readFile(file, 'utf8');
      if (text.length > 0 && !text.endsWith('\n')) return err({ code: 'CORRUPT_DATA', message: 'Timeline con tail parcial.' });
      const entries = text
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as TimelineEntry);
      const errors = entries.flatMap(entry => validateTimelineSchema(entry));
      return errors.length === 0 ? ok(entries) : err({ code: 'CORRUPT_DATA', message: 'Timeline inválido.', details: errors });
    } catch (error) {
      return err({ code: 'CORRUPT_DATA', message: 'No se pudo leer el timeline.', details: [String(error)] });
    }
  }
}
