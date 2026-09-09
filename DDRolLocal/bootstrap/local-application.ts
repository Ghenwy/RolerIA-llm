import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NyxApplicationService,
  FallbackHandoffCoordinator,
  ScheduledTurnWorkerPort,
  TurnOrchestrator,
  prepareMechanicalAction,
  prepareRegisteredTravel,
  registeredTravelReceipt,
  type RegisteredTravel,
  advanceMechanicalAction,
  buildWeaponDamageHealthChange,
  validateMechanicalCandidate,
  type MechanicalAction,
  type RunTurnInput,
  type TurnMechanicalPort,
  buildC6GmContextPacket,
  buildC6WorkerContextPacket,
  validateC6WorkerContextPacket,
  type ApplicationCommandHandler,
  type ApplicationPortResult,
  type CampaignAdministrationPort,
  type DiagnosticPort,
  type FallbackControlPort,
  type LlmGateway,
  type RuntimeControlPort,
  type StateCommitCandidate,
  type StateTransactionPort,
  type TurnDicePort,
  type TurnContextPort,
  type TurnExecutionContext,
  type TurnPortResult,
  type TurnRunnerPort,
  type WorkerOperationsPort,
  type WorkerContextBuilderPort,
  type WorkerQueueReadModel,
  type WorkerQueuePersistencePort
} from '@nyx/application';
import {
  validateRuntimeContract,
  type CampaignManifest,
  type CampaignTurnProfile,
  type RuntimeProfileName,
  type DesignTurnEnvelope,
  type InternalWorkerAttempt,
  type InternalWorkerQueueBatch,
  type SotRpgjobCard,
  type SotRpgworkerResult
} from '@nyx/contracts';
import {
  createCampaignState,
  DiceEngine,
  replayEvents,
  validateNewKnowledgeEvents,
  type AtomicEvent,
  type HierarchicalMemoryRecord
} from '@nyx/domain';
import { DND35_RULESET_ID } from '@nyx/dnd35';
import { LocalCampaignRules } from './local-rules.js';
import { GovernedWorkerRunner, LlamaServerGateway, type RuntimeProfilesFile } from '@nyx/llama-client';
import {
  JsonlOperationalLogSink,
  SafeOperationalLogger,
  type OperationalLogger
} from '@nyx/observability';
import {
  CampaignWriterLock,
  JsonCampaignStore,
  JsonCheckpointStore,
  JsonCompactionStore,
  JsonTranscriptStore,
  JsonWorkerQueueStore,
  canonicalJson,
  sha256,
  validateTranscriptSchema,
  validateWriterLockSchema,
  type CheckpointManifest,
  type TranscriptEntry
} from '@nyx/persistence-json';
import { LocalFallbackHandoffAdapter } from './local-fallback-handoff.js';
import { closeLocalTestScene, compactLocalCampaign, completeTranscriptTurnIds, hasPublicAlphaMemoryProvenance } from './local-scene-compaction.js';

interface ProtectedManifestEntry {
  readonly kind: string;
  readonly id: string;
  readonly output_file_sha256?: string;
}

export interface ProtectedManifestLike {
  readonly entries: readonly ProtectedManifestEntry[];
}

export interface LocalNyxRuntimeOptions {
  /** Only affects new campaigns. Existing manifests are never converted by runtime options. */
  readonly newCampaignTurnProfile?: CampaignTurnProfile;
  /** Injected gateways must explicitly declare 64K; historical fixtures retain 96K. */
  readonly newCampaignRuntimeProfile?: RuntimeProfileName;
  readonly enableTestSceneCompaction?: boolean;
  readonly productRoot: string;
  readonly campaignsRoot?: string;
  readonly gateway?: LlmGateway;
  readonly requiredModelId?: string;
  readonly modelFingerprint?: string;
  readonly protectedManifest?: ProtectedManifestLike;
  readonly now?: () => Date;
  readonly campaignSeed?: () => string;
  readonly fallbackProcessRunner?: FallbackProcessRunner;
  readonly observability?: OperationalLogger;
}

export interface FallbackProcessInput {
  readonly productRoot: string;
  readonly campaignRoot: string;
  readonly handoffFile: string;
}

export interface FallbackProcessRunner {
  run(input: FallbackProcessInput): Promise<ApplicationPortResult<{ exitCode: number }>>;
}

export interface LocalCampaignSession {
  readonly campaignId: string;
  readonly branchId: string;
  readonly stateVersion: number;
  readonly language: string;
}

export interface LocalNyxRuntime {
  closeTestScene(campaignId: string): ReturnType<typeof closeLocalTestScene>;
  readonly application: ApplicationCommandHandler;
  openSession(campaignId: string): Promise<ApplicationPortResult<LocalCampaignSession>>;
}

export async function locateProductRoot(moduleUrl: string): Promise<string> {
  let current = path.dirname(fileURLToPath(moduleUrl));
  while (true) {
    if (await exists(path.join(current, 'config', 'runtime-profiles.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('No se encontró la raíz de DDRolLocal.');
    current = parent;
  }
}

const ok = <T>(value: T): ApplicationPortResult<T> => ({ ok: true, value });
const failure = <T>(code: string, message: string): ApplicationPortResult<T> => ({
  ok: false,
  error: { code, message }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeCampaignId(campaignId: string): string {
  if (!/^CAMPAIGN-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(campaignId)) throw new Error('campaign-id inseguro.');
  return campaignId;
}

function safeBranchId(branchId: string): string {
  if (!/^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(branchId)) throw new Error('branch-id inseguro.');
  return branchId;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const handle = await fs.open(temp, 'wx');
  try {
    await handle.writeFile(canonicalJson(value), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, file);
}

interface TranscriptOutboxRecord {
  readonly schema: 'nyx.transcript_outbox.v1';
  readonly status: 'PREPARED' | 'COMMITTED';
  readonly event_ids: readonly string[];
  readonly entry: TranscriptEntry;
}

function transcriptOutboxFile(campaignRoot: string, turnId: string): string {
  return path.join(campaignRoot, 'transcript', 'outbox', `${sha256(turnId).slice(0, 32)}.json`);
}

function transcriptEntry(
  campaignId: string,
  branchId: string,
  turnId: string,
  speaker: TranscriptEntry['speaker'],
  content: string,
  occurredAt: string
): TranscriptEntry {
  return {
    schema_version: '1.0',
    transcript_id: `TRANSCRIPT-${sha256(`${turnId}:${speaker}`).slice(0, 24)}`,
    campaign_id: campaignId,
    branch_id: branchId,
    turn_id: turnId,
    speaker,
    content,
    occurred_at: occurredAt,
    source_refs: ['estrcuttura/05-nyx-despliegue-operacion-validacion.md:254-275']
  };
}

async function stageTranscriptOutbox(
  campaignRoot: string,
  record: TranscriptOutboxRecord
): Promise<string> {
  const file = transcriptOutboxFile(campaignRoot, record.entry.turn_id);
  if (!(await exists(file))) await writeJsonAtomic(file, record);
  return file;
}

async function markTranscriptOutboxCommitted(file: string, record: TranscriptOutboxRecord): Promise<void> {
  await writeJsonAtomic(file, { ...record, status: 'COMMITTED' });
}

async function drainTranscriptOutbox(campaignRoot: string): Promise<ApplicationPortResult<void>> {
  const directory = path.join(campaignRoot, 'transcript', 'outbox');
  if (!(await exists(directory))) return ok(undefined);
  try {
    for (const fileName of await fs.readdir(directory)) {
      if (!fileName.endsWith('.json')) continue;
      const file = path.join(directory, fileName);
      const record = JSON.parse(await fs.readFile(file, 'utf8')) as TranscriptOutboxRecord;
      if (
        record.schema !== 'nyx.transcript_outbox.v1' ||
        (record.status !== 'PREPARED' && record.status !== 'COMMITTED') ||
        !Array.isArray(record.event_ids) ||
        record.event_ids.some(id => typeof id !== 'string' || id.length === 0) ||
        validateTranscriptSchema(record.entry).length > 0
      ) {
        return failure('TRANSCRIPT_OUTBOX_CORRUPT', 'El outbox de transcript es inválido.');
      }
      let committed = record.status === 'COMMITTED';
      if (!committed && record.event_ids.length > 0) {
        const events = await new JsonCampaignStore(campaignRoot).events.tail(record.entry.branch_id);
        if (!events.ok) return failure(events.error.code, events.error.message);
        const confirmedIds = new Set(events.value.map(event => event.event_id));
        committed = record.event_ids.every(id => confirmedIds.has(id));
      }
      if (!committed) continue;
      const appended = await new JsonTranscriptStore(campaignRoot).append(record.entry);
      if (!appended.ok) return failure(appended.error.code, appended.error.message);
      await fs.rm(file);
    }
    return ok(undefined);
  } catch {
    return failure('TRANSCRIPT_OUTBOX_FAILED', 'No se pudo recuperar el transcript pendiente.');
  }
}

function manifestFingerprints(protectedManifest: ProtectedManifestLike): {
  schemas: Record<string, string>;
  prompts: Record<string, string>;
} {
  const schemas: Record<string, string> = {};
  const prompts: Record<string, string> = {};
  for (const entry of protectedManifest.entries) {
    if (entry.output_file_sha256 === undefined) continue;
    if (entry.kind === 'schema') schemas[entry.id] = entry.output_file_sha256;
    if (entry.kind === 'prompt') prompts[entry.id] = entry.output_file_sha256;
  }
  return { schemas, prompts };
}

function manifestFile(campaignRoot: string): string {
  return path.join(campaignRoot, 'campaign.json');
}

async function readManifest(campaignRoot: string): Promise<ApplicationPortResult<CampaignManifest>> {
  try {
    const value = JSON.parse(await fs.readFile(manifestFile(campaignRoot), 'utf8')) as unknown;
    const validation = validateRuntimeContract('CampaignManifest', value);
    return validation.ok
      ? ok(value as CampaignManifest)
      : failure('CAMPAIGN_MANIFEST_INVALID', 'El manifest de campaña no cumple su contrato.');
  } catch {
    return failure('CAMPAIGN_NOT_FOUND', 'No se encontró una campaña válida.');
  }
}

function checkpointId(now: Date): string {
  return `CHECKPOINT-${now.toISOString().replace(/[^0-9]/g, '')}-${crypto.randomUUID().slice(0, 8)}`;
}

async function latestCheckpoint(campaignRoot: string): Promise<ApplicationPortResult<CheckpointManifest>> {
  const directory = path.join(campaignRoot, 'checkpoints');
  try {
    const ids = (await fs.readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name.startsWith('CHECKPOINT-'))
      .map(entry => entry.name);
    let latest: CheckpointManifest | undefined;
    const store = new JsonCampaignStore(campaignRoot);
    const checkpoints = new JsonCheckpointStore(campaignRoot, store);
    for (const id of ids) {
      const verified = await checkpoints.verify(id);
      if (verified.ok && (latest === undefined || verified.value.created_at > latest.created_at)) latest = verified.value;
    }
    return latest === undefined
      ? failure('CHECKPOINT_NOT_FOUND', 'La campaña no tiene checkpoint verificable.')
      : ok(latest);
  } catch {
    return failure('CHECKPOINT_NOT_FOUND', 'La campaña no tiene checkpoint verificable.');
  }
}

class LocalCampaignAdministration implements CampaignAdministrationPort {
  readonly #campaignsRoot: string;
  readonly #fingerprints: ReturnType<typeof manifestFingerprints>;
  readonly #modelFingerprint: string;
  readonly #now: () => Date;
  readonly #campaignSeed: () => string;
  readonly #observability: OperationalLogger;
  readonly #newCampaignTurnProfile: CampaignTurnProfile | undefined;
  readonly #newCampaignRuntimeProfile: RuntimeProfileName;

  constructor(
    campaignsRoot: string,
    protectedManifest: ProtectedManifestLike,
    modelFingerprint: string,
    now: () => Date,
    campaignSeed: () => string,
    observability: OperationalLogger,
    newCampaignTurnProfile: CampaignTurnProfile | undefined,
    newCampaignRuntimeProfile: RuntimeProfileName
  ) {
    this.#campaignsRoot = path.resolve(campaignsRoot);
    this.#fingerprints = manifestFingerprints(protectedManifest);
    this.#modelFingerprint = modelFingerprint;
    this.#now = now;
    this.#campaignSeed = campaignSeed;
    this.#observability = observability;
    this.#newCampaignTurnProfile = newCampaignTurnProfile;
    this.#newCampaignRuntimeProfile = newCampaignRuntimeProfile;
  }

  rootFor(campaignId: string): string {
    return path.join(this.#campaignsRoot, safeCampaignId(campaignId));
  }

  async create(campaignId: string): Promise<ApplicationPortResult<{ campaignId: string; branchId: string; stateVersion: number }>> {
    try {
      const finalRoot = this.rootFor(campaignId);
      if (await exists(finalRoot)) return failure('CAMPAIGN_EXISTS', 'La campaña ya existe.');
      await fs.mkdir(this.#campaignsRoot, { recursive: true });
      const tempRoot = path.join(this.#campaignsRoot, `.${campaignId}.${crypto.randomUUID()}.tmp`);
      await fs.mkdir(tempRoot, { recursive: false });
      try {
        const state = createCampaignState({
          campaign_id: campaignId,
          branch_id: 'BRANCH-main',
          rng: {
            algorithm: 'sha256-seeded-python-random',
            campaign_seed: this.#campaignSeed(),
            roll_index: 0
          }
        });
        const campaigns = new JsonCampaignStore(tempRoot);
        const initialized = await campaigns.initialize(state);
        if (!initialized.ok) return failure(initialized.error.code, initialized.error.message);
        const createdAt = this.#now().toISOString();
        const checkpoints = new JsonCheckpointStore(tempRoot, campaigns, this.#observability);
        const bootstrapCheckpointId = `CHECKPOINT-${campaignId}-bootstrap`;
        const initialCheckpoint = await checkpoints.create({
          checkpoint_id: bootstrapCheckpointId,
          parent_checkpoint_id: null,
          state,
          event_log: [],
          campaign_time: 'elapsed_minutes:0',
          schema_fingerprints: this.#fingerprints.schemas,
          prompt_fingerprints: this.#fingerprints.prompts,
          model_fingerprint: this.#modelFingerprint,
          created_at: createdAt
        });
        if (!initialCheckpoint.ok) return failure(initialCheckpoint.error.code, initialCheckpoint.error.message);
        const manifest: CampaignManifest = {
          ...(this.#newCampaignRuntimeProfile === '64k'
            ? { schema_version: '1.2' as const, runtime_profile: '64k' as const,
              turn_profile: this.#newCampaignTurnProfile ?? 'AUTOMATIC_EXPERIMENTAL' as const }
            : this.#newCampaignTurnProfile === undefined
              ? { schema_version: '1.0' as const, runtime_profile: this.#newCampaignRuntimeProfile }
              : { schema_version: '1.1' as const, runtime_profile: this.#newCampaignRuntimeProfile,
                turn_profile: this.#newCampaignTurnProfile }),
          campaign_id: campaignId,
          language: 'es',
          ruleset_id: DND35_RULESET_ID,
          active_branch_id: 'BRANCH-main',
          state_version: 0,
          paths: {
            state: 'state',
            events: 'events',
            transcript: 'transcript',
            checkpoints: 'checkpoints'
          },
          fingerprints: {
            schemas: this.#fingerprints.schemas,
            prompts: this.#fingerprints.prompts,
            model: this.#modelFingerprint
          },
          last_checkpoint_at: createdAt
        };
        const validation = validateRuntimeContract('CampaignManifest', manifest);
        if (!validation.ok) return failure('CAMPAIGN_MANIFEST_INVALID', 'No se pudo construir un manifest válido.');
        await writeJsonAtomic(manifestFile(tempRoot), manifest);
        await fs.rename(tempRoot, finalRoot);
        return ok({ campaignId, branchId: 'BRANCH-main', stateVersion: 0 });
      } finally {
        if (await exists(tempRoot)) await fs.rm(tempRoot, { recursive: true, force: true });
      }
    } catch {
      return failure('CAMPAIGN_CREATE_FAILED', 'No se pudo crear la campaña de forma atómica.');
    }
  }

  async open(campaignId: string): Promise<ApplicationPortResult<{ campaignId: string; branchId: string; stateVersion: number }>> {
    const manifest = await readManifest(this.rootFor(campaignId));
    if (!manifest.ok) return manifest;
    const opened = await new JsonCampaignStore(this.rootFor(campaignId)).open(manifest.value.active_branch_id);
    if (!opened.ok) return failure(opened.error.code, opened.error.message);
    if (manifest.value.state_version !== opened.value.state_version) {
      await this.#updateManifest(this.rootFor(campaignId), {
        ...manifest.value,
        state_version: opened.value.state_version
      });
    }
    // Public campaign.open must recover publication as well as canonical state after a durable commit.
    const drained = await drainTranscriptOutbox(this.rootFor(campaignId));
    if (!drained.ok) return drained;
    return ok({ campaignId, branchId: opened.value.branch_id, stateVersion: opened.value.state_version });
  }

  async session(campaignId: string): Promise<ApplicationPortResult<LocalCampaignSession>> {
    const opened = await this.open(campaignId);
    if (!opened.ok) return opened;
    const manifest = await readManifest(this.rootFor(campaignId));
    return manifest.ok
      ? ok({ ...opened.value, language: manifest.value.language })
      : manifest;
  }

  async verify(campaignId: string): Promise<ApplicationPortResult<{ campaignId: string; valid: boolean }>> {
    const session = await this.session(campaignId);
    if (!session.ok) return session;
    const root = this.rootFor(campaignId);
    const store = new JsonCampaignStore(root);
    const events = await store.events.tail(session.value.branchId);
    if (!events.ok) return failure(events.error.code, events.error.message);
    const transcript = await new JsonTranscriptStore(root).tail(session.value.branchId);
    if (!transcript.ok) return failure(transcript.error.code, transcript.error.message);
    const checkpoint = await latestCheckpoint(root);
    if (!checkpoint.ok) return checkpoint;
    return ok({ campaignId, valid: true });
  }

  async save(campaignId: string): Promise<ApplicationPortResult<{ campaignId: string; checkpointId: string }>> {
    const session = await this.session(campaignId);
    if (!session.ok) return session;
    const root = this.rootFor(campaignId);
    const campaigns = new JsonCampaignStore(root);
    const state = await campaigns.open(session.value.branchId);
    if (!state.ok) return failure(state.error.code, state.error.message);
    const events = await campaigns.events.tail(session.value.branchId);
    if (!events.ok) return failure(events.error.code, events.error.message);
    const parent = await latestCheckpoint(root);
    if (!parent.ok) return parent;
    const createdAt = this.#now().toISOString();
    const id = checkpointId(this.#now());
    const checkpoints = new JsonCheckpointStore(root, campaigns, this.#observability);
    const created = await checkpoints.create({
      checkpoint_id: id,
      parent_checkpoint_id: parent.value.checkpoint_id,
      state: state.value,
      event_log: events.value,
      campaign_time: `elapsed_minutes:${String(state.value.world['elapsed_minutes'] ?? 0)}`,
      schema_fingerprints: this.#fingerprints.schemas,
      prompt_fingerprints: this.#fingerprints.prompts,
      model_fingerprint: this.#modelFingerprint,
      created_at: createdAt
    });
    if (!created.ok) return failure(created.error.code, created.error.message);
    const manifest = await readManifest(root);
    if (manifest.ok) await this.#updateManifest(root, { ...manifest.value, last_checkpoint_at: createdAt });
    return ok({ campaignId, checkpointId: id });
  }

  async #findCheckpoint(id: string): Promise<ApplicationPortResult<{ campaignId: string; root: string; store: JsonCheckpointStore }>> {
    if (!/^CHECKPOINT-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return failure('CHECKPOINT_ID_INVALID', 'checkpoint-id inseguro.');
    try {
      let match: { campaignId: string; root: string; store: JsonCheckpointStore } | undefined;
      for (const entry of await fs.readdir(this.#campaignsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('CAMPAIGN-')) continue;
        const root = this.rootFor(entry.name);
        const campaigns = new JsonCampaignStore(root);
        const store = new JsonCheckpointStore(root, campaigns);
        const verified = await store.verify(id);
        if (!verified.ok) continue;
        if (match !== undefined) return failure('CHECKPOINT_AMBIGUOUS', 'El checkpoint no identifica una única campaña.');
        match = { campaignId: entry.name, root, store };
      }
      return match === undefined ? failure('CHECKPOINT_NOT_FOUND', 'No se encontró el checkpoint.') : ok(match);
    } catch {
      return failure('CHECKPOINT_NOT_FOUND', 'No se encontró el checkpoint.');
    }
  }

  async load(id: string): Promise<ApplicationPortResult<{ checkpointId: string; campaignId: string }>> {
    const found = await this.#findCheckpoint(id);
    if (!found.ok) return found;
    const branchId = `BRANCH-load-${crypto.randomUUID().slice(0, 12)}`;
    const restored = await found.value.store.branch(id, branchId, this.#now().toISOString());
    if (!restored.ok) return failure(restored.error.code, restored.error.message);
    const manifest = await readManifest(found.value.root);
    if (!manifest.ok) return manifest;
    await this.#updateManifest(found.value.root, {
      ...manifest.value,
      active_branch_id: branchId,
      state_version: restored.value.state_version
    });
    return ok({ checkpointId: id, campaignId: found.value.campaignId });
  }

  async rollback(id: string): Promise<ApplicationPortResult<{ checkpointId: string; campaignId: string }>> {
    const found = await this.#findCheckpoint(id);
    if (!found.ok) return found;
    const manifest = await readManifest(found.value.root);
    if (!manifest.ok) return manifest;
    const branchId = `BRANCH-rollback-${crypto.randomUUID().slice(0, 12)}`;
    const restored = await found.value.store.rollback(
      id,
      manifest.value.active_branch_id,
      branchId,
      this.#now().toISOString()
    );
    if (!restored.ok) return failure(restored.error.code, restored.error.message);
    await this.#updateManifest(found.value.root, {
      ...manifest.value,
      active_branch_id: branchId,
      state_version: restored.value.state_version
    });
    return ok({ checkpointId: id, campaignId: found.value.campaignId });
  }

  async branch(id: string, branchId: string): Promise<ApplicationPortResult<{ checkpointId: string; campaignId: string; branchId: string }>> {
    const found = await this.#findCheckpoint(id);
    if (!found.ok) return found;
    safeBranchId(branchId);
    const restored = await found.value.store.branch(id, branchId, this.#now().toISOString());
    if (!restored.ok) return failure(restored.error.code, restored.error.message);
    const manifest = await readManifest(found.value.root);
    if (!manifest.ok) return manifest;
    await this.#updateManifest(found.value.root, {
      ...manifest.value,
      active_branch_id: branchId,
      state_version: restored.value.state_version
    });
    return ok({ checkpointId: id, campaignId: found.value.campaignId, branchId });
  }

  async updateStateVersion(campaignId: string, stateVersion: number): Promise<void> {
    const root = this.rootFor(campaignId);
    const manifest = await readManifest(root);
    if (manifest.ok) await this.#updateManifest(root, { ...manifest.value, state_version: stateVersion });
  }

  async #updateManifest(root: string, manifest: CampaignManifest): Promise<void> {
    const validation = validateRuntimeContract('CampaignManifest', manifest);
    if (!validation.ok) throw new Error(`Invalid manifest: ${validation.errors.join(',')}`);
    await writeJsonAtomic(manifestFile(root), manifest);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = process.platform === 'win32'
      ? spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      : spawn('kill', ['-TERM', String(pid)], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`stop exited ${String(code)}`)));
  });
}

async function isExpectedRuntimeProcess(pid: number): Promise<boolean> {
  if (!processIsAlive(pid)) return false;
  if (process.platform !== 'win32') {
    try {
      return path.basename(await fs.readlink(`/proc/${String(pid)}/exe`)) === 'llama-server';
    } catch {
      return false;
    }
  }
  try {
    const executable = await new Promise<string>((resolve, reject) => {
      const child = spawn('pwsh', [
        '-NoProfile',
        '-Command',
        '$target = Get-Process -Id ([int]$env:NYX_RUNTIME_PID) -ErrorAction Stop; [Console]::Out.Write($target.Path)'
      ], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NYX_RUNTIME_PID: String(pid) }
      });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve(stdout.trim()) : reject(new Error('process identity query failed')));
    });
    return path.basename(executable).toLowerCase() === 'llama-server.exe';
  } catch {
    return false;
  }
}

export class LocalRuntimeControl implements RuntimeControlPort {
  readonly #productRoot: string;
  readonly #gateway: LlmGateway;

  constructor(productRoot: string, gateway: LlmGateway) {
    this.#productRoot = productRoot;
    this.#gateway = gateway;
  }

  async status(): Promise<ApplicationPortResult<{ state: 'running' | 'stopped' | 'unhealthy' }>> {
    const health = await this.#gateway.health({ correlationId: 'RUNTIME-STATUS', timeoutMs: 2_000 });
    return ok({ state: health.ok ? 'running' : 'stopped' });
  }

  async start(profile?: RuntimeProfileName): Promise<ApplicationPortResult<{ state: 'running' }>> {
    const current = await this.status();
    if (current.ok && current.value.state === 'running') return ok({ state: 'running' });
    const script = path.join(this.#productRoot, 'scripts', 'runtime', 'Start-NyxRuntime.ps1');
    if (!(await exists(script))) return failure('RUNTIME_START_UNAVAILABLE', 'No existe el launcher local verificado.');
    const pidFile = path.join(this.#productRoot, 'runtime', 'nyx-runtime.pid');
    let reserved: fs.FileHandle | undefined;
    let spawnedPid: number | undefined;
    let releaseLauncher: (() => void) | undefined;
    try {
      await fs.mkdir(path.dirname(pidFile), { recursive: true });
      if (await exists(pidFile)) {
        const raw = (await fs.readFile(pidFile, 'utf8')).trim();
        if (raw.length === 0) {
          return failure('RUNTIME_START_IN_PROGRESS', 'Otro proceso está reservando el supervisor local.');
        }
        const existingPid = Number(raw);
        if (!Number.isSafeInteger(existingPid) || existingPid <= 0) {
          return failure('RUNTIME_PID_INVALID', 'El PID supervisado es inválido; se requiere diagnóstico manual.');
        }
        if (processIsAlive(existingPid)) {
          return failure('RUNTIME_ALREADY_SUPERVISED', 'Ya existe un supervisor local activo.');
        }
        await fs.rm(pidFile);
      }
      reserved = await fs.open(pidFile, 'wx');
      const child = spawn('pwsh', [
        '-NoProfile', '-File', script, ...(profile === undefined ? [] : ['-Profile', profile]), '-Root', this.#productRoot, '-Detached'
      ], {
        cwd: this.#productRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
      releaseLauncher = () => {
        // Launcher exit does not close pipes inherited by a detached descendant.
        // These streams carry only startup diagnostics; runtime logs have their own redirection.
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      };
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr || `launcher exited ${String(code)}`)));
      });
      const match = /NYX_RUNTIME_PID=(\d+)/.exec(stdout);
      if (match?.[1] === undefined) throw new Error('Launcher did not return the runtime PID.');
      const runtimePid = Number(match[1]);
      if (!Number.isSafeInteger(runtimePid) || runtimePid <= 0) throw new Error('Launcher returned an invalid runtime PID.');
      spawnedPid = runtimePid;
      await reserved.writeFile(`${String(runtimePid)}\n`, 'utf8');
      await reserved.sync();
      await reserved.close();
      reserved = undefined;
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const health = await this.#gateway.health({ correlationId: 'RUNTIME-START', timeoutMs: 2_000 });
        if (health.ok) return ok({ state: 'running' });
        if (!processIsAlive(runtimePid)) throw new Error('Runtime process exited before health became ready.');
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error('Runtime startup health deadline exceeded.');
    } catch (error) {
      await reserved?.close().catch(() => undefined);
      if (spawnedPid !== undefined && processIsAlive(spawnedPid)) {
        await terminateProcessTree(spawnedPid).catch(() => undefined);
      }
      await fs.rm(pidFile, { force: true }).catch(() => undefined);
      await writeJsonAtomic(path.join(this.#productRoot, 'runtime', 'nyx-runtime.start-error.json'), {
        schema: 'nyx.runtime.start_error.v1',
        profile,
        occurred_at: new Date().toISOString(),
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      }).catch(() => undefined);
      return failure('RUNTIME_START_FAILED', 'No se pudo iniciar el runtime local de forma supervisada.');
    } finally {
      releaseLauncher?.();
    }
  }

  async stop(): Promise<ApplicationPortResult<{ state: 'stopped' }>> {
    const pidFile = path.join(this.#productRoot, 'runtime', 'nyx-runtime.pid');
    try {
      const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
      if (!Number.isSafeInteger(pid) || pid <= 0) return failure('RUNTIME_PID_INVALID', 'El PID supervisado es inválido.');
      if (!processIsAlive(pid)) {
        await fs.rm(pidFile, { force: true });
        return ok({ state: 'stopped' });
      }
      if (!(await isExpectedRuntimeProcess(pid))) {
        return failure('RUNTIME_NOT_OWNED', 'El PID registrado no corresponde a llama-server; no se detuvo.');
      }
      await terminateProcessTree(pid);
      await fs.rm(pidFile, { force: true });
      return ok({ state: 'stopped' });
    } catch {
      const status = await this.status();
      return status.ok && status.value.state === 'stopped'
        ? ok({ state: 'stopped' })
        : failure('RUNTIME_NOT_OWNED', 'El proceso activo no pertenece a este supervisor; no se detuvo.');
    }
  }
}

class UvFallbackProcessRunner implements FallbackProcessRunner {
  async run(input: FallbackProcessInput): Promise<ApplicationPortResult<{ exitCode: number }>> {
    const project = path.join(input.productRoot, 'fallback', 'python');
    return await new Promise(resolve => {
      const child = spawn('uv', [
        'run',
        '--project', project,
        '--python', '3.12',
        'python',
        '-m', 'nyx_fallback',
        'play',
        '--product-root', input.productRoot,
        '--campaign-root', input.campaignRoot,
        '--handoff-file', input.handoffFile
      ], {
        cwd: input.productRoot,
        shell: false,
        stdio: 'inherit',
        windowsHide: false
      });
      child.once('error', () => resolve(failure('FALLBACK_PROCESS_START_FAILED', 'No se pudo iniciar Python fallback.')));
      child.once('exit', code => {
        const exitCode = code ?? 1;
        resolve(exitCode === 0
          ? ok({ exitCode })
          : failure('FALLBACK_PROCESS_FAILED', `Python fallback terminó con código ${String(exitCode)}.`));
      });
    });
  }
}

class LocalFallbackControl implements FallbackControlPort {
  readonly #productRoot: string;
  readonly #campaignsRoot: string;
  readonly #campaigns: LocalCampaignAdministration;
  readonly #runner: FallbackProcessRunner;

  constructor(
    productRoot: string,
    campaigns: LocalCampaignAdministration,
    campaignsRoot: string,
    runner: FallbackProcessRunner = new UvFallbackProcessRunner()
  ) {
    this.#productRoot = path.resolve(productRoot);
    this.#campaignsRoot = path.resolve(campaignsRoot);
    this.#campaigns = campaigns;
    this.#runner = runner;
  }

  async status(): Promise<ApplicationPortResult<{ available: boolean; active: boolean }>> {
    const entrypoint = path.join(
      this.#productRoot,
      'fallback',
      'python',
      'src',
      'nyx_fallback',
      '__main__.py'
    );
    if (!(await exists(entrypoint))) return ok({ available: false, active: false });
    let active = false;
    if (await exists(this.#campaignsRoot)) {
      for (const entry of await fs.readdir(this.#campaignsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('CAMPAIGN-')) continue;
        const lockFile = path.join(this.#campaignsRoot, entry.name, 'locks', 'writer.lock.json');
        if (!(await exists(lockFile))) continue;
        try {
          const lock = JSON.parse(await fs.readFile(lockFile, 'utf8')) as Record<string, unknown>;
          if (lock['owner_runtime'] === 'python' && validateWriterLockSchema(lock).length === 0) active = true;
        } catch {
          return failure('FALLBACK_LOCK_INVALID', 'Existe un writer lock de fallback ilegible.');
        }
      }
    }
    return ok({ available: true, active });
  }

  async play(campaignId: string): Promise<ApplicationPortResult<{ available: boolean; active: boolean; campaignId: string }>> {
    const session = await this.#campaigns.session(campaignId);
    if (!session.ok) return session;
    const campaignRoot = this.#campaigns.rootFor(campaignId);
    const coordinator = new FallbackHandoffCoordinator(new LocalFallbackHandoffAdapter(campaignRoot));
    const prepared = await coordinator.prepare({
      sourceRuntime: 'typescript',
      targetRuntime: 'python',
      reason: 'El operador inició nyx fallback play tras un límite confirmado.'
    });
    if (!prepared.ok) return failure(prepared.error.code, prepared.error.message);
    const handoffFile = path.join(
      campaignRoot,
      'handoffs',
      `${prepared.value.checkpoint_id}.typescript-to-python.json`
    );
    const executed = await this.#runner.run({
      productRoot: this.#productRoot,
      campaignRoot,
      handoffFile
    });
    return executed.ok
      ? ok({ available: true, active: false, campaignId })
      : executed;
  }
}

export async function inspectCampaignWriterLocks(
  campaignsRoot: string
): Promise<{ readonly status: 'PASS' | 'FAIL'; readonly detail: string }> {
  if (!(await exists(campaignsRoot))) return { status: 'PASS', detail: '0 locks; campaigns path ausente.' };
  const campaignEntries = await fs.readdir(campaignsRoot, { withFileTypes: true });
  let active = 0;
  for (const campaignEntry of campaignEntries) {
    if (!campaignEntry.isDirectory()) continue;
    const lockFile = path.join(campaignsRoot, campaignEntry.name, 'locks', 'writer.lock.json');
    if (!(await exists(lockFile))) continue;
    try {
      const lock = JSON.parse(await fs.readFile(lockFile, 'utf8')) as unknown;
      const validation = validateWriterLockSchema(lock);
      if (validation.length > 0 || !isRecord(lock) || typeof lock['pid'] !== 'number') {
        return { status: 'FAIL', detail: `Lock corrupto: ${campaignEntry.name}.` };
      }
      if (!processIsAlive(lock['pid'])) {
        return { status: 'FAIL', detail: `Lock huérfano: ${campaignEntry.name}, PID ${String(lock['pid'])}.` };
      }
      active += 1;
    } catch {
      return { status: 'FAIL', detail: `Lock ilegible: ${campaignEntry.name}.` };
    }
  }
  return { status: 'PASS', detail: `${String(active)} locks activos y válidos.` };
}

class LocalDiagnostics implements DiagnosticPort {
  readonly #productRoot: string;

  constructor(productRoot: string) {
    this.#productRoot = productRoot;
  }

  async inspect(): Promise<ApplicationPortResult<{ checks: readonly { name: string; status: 'PASS' | 'FAIL'; detail: string }[] }>> {
    const script = path.join(this.#productRoot, 'scripts', 'runtime', 'Test-NyxRuntime.ps1');
    if (!(await exists(script))) return failure('RUNTIME_PREFLIGHT_MISSING', 'Falta el diagnóstico reproducible del runtime.');
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn('pwsh', [
          '-NoProfile', '-File', script, '-Root', this.#productRoot, '-Json'
        ], { cwd: this.#productRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += String(chunk); });
        child.stderr.on('data', chunk => { stderr += String(chunk); });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `preflight exited ${String(code)}`)));
      });
      const report = JSON.parse(output) as { status?: unknown; checks?: unknown };
      if (!Array.isArray(report.checks)) return failure('RUNTIME_PREFLIGHT_INVALID', 'El diagnóstico del runtime devolvió un reporte inválido.');
      const checks = report.checks.filter(isRecord).map(check => ({
        name: String(check['name'] ?? 'unknown'),
        status: check['status'] === 'PASS' ? 'PASS' as const : 'FAIL' as const,
        detail: String(check['detail'] ?? '')
      }));
      const manifestExists = await exists(path.join(this.#productRoot, 'packages', 'contracts', 'manifests', 'protected-content.json'));
      checks.push({ name: 'protected_contract_manifest', status: manifestExists ? 'PASS' : 'FAIL', detail: 'packages/contracts/manifests/protected-content.json' });
      const campaignsRoot = path.join(this.#productRoot, 'campaigns');
      await fs.mkdir(campaignsRoot, { recursive: true });
      await fs.access(campaignsRoot, fs.constants.R_OK | fs.constants.W_OK);
      checks.push({ name: 'campaigns_path_access', status: 'PASS', detail: campaignsRoot });
      checks.push({ name: 'campaign_writer_locks', ...(await inspectCampaignWriterLocks(campaignsRoot)) });
      const failed = report.status !== 'READY' || checks.some(check => check.status === 'FAIL');
      return failed
        ? failure('RUNTIME_PREFLIGHT_FAILED', 'El diagnóstico local detectó controles en rojo.')
        : ok({ checks });
    } catch {
      return failure('RUNTIME_PREFLIGHT_FAILED', 'No se pudo completar el diagnóstico local reproducible.');
    }
  }
}

class LocalTurnPorts implements StateTransactionPort, TurnDicePort, TurnMechanicalPort {
  readonly #campaigns: LocalCampaignAdministration;
  readonly #rules: LocalCampaignRules;
  readonly #now: () => Date;
  readonly #pendingDice = new Map<string, { events: AtomicEvent[]; refs: DesignTurnEnvelope.RollRef[] }>();
  #mechanicalInput: RunTurnInput | undefined;
  #mechanicalAction: MechanicalAction | null = null;
  #travel: RegisteredTravel | null = null;
  #assistedEvents: AtomicEvent[] = [];
  #assistedReceipt: string | undefined;

  constructor(campaigns: LocalCampaignAdministration, now: () => Date, rules: LocalCampaignRules) {
    this.#campaigns = campaigns;
    this.#now = now;
    this.#rules = rules;
  }

  async prepare(input: RunTurnInput): Promise<TurnPortResult<MechanicalAction | null>> {
    const session = await this.#campaigns.session(input.campaignId);
    if (!session.ok) return session;
    const opened = await new JsonCampaignStore(this.#campaigns.rootFor(input.campaignId)).open(session.value.branchId);
    if (!opened.ok) return opened;
    if (input.playerInput.trim().startsWith('/travel')) {
      const manifest = await readManifest(this.#campaigns.rootFor(input.campaignId));
      if (!manifest.ok) return manifest;
      if (manifest.value.schema_version === '1.0' || manifest.value.turn_profile !== 'ASSISTED_ALPHA') {
        return { ok: false, error: { code: 'GUIDED_TRAVEL_UNAVAILABLE', message: 'El viaje registrado requiere una campaña asistida; no se enviará al GM automático.' } };
      }
    }
    const travel = prepareRegisteredTravel(opened.value, input);
    if (!travel.ok) return travel;
    const prepared = prepareMechanicalAction(opened.value, input);
    if (prepared.ok && prepared.value?.schema_version === '1.1') {
      const manifest = await readManifest(this.#campaigns.rootFor(input.campaignId));
      if (!manifest.ok) return manifest;
      if (manifest.value.schema_version === '1.0' || manifest.value.turn_profile !== 'ASSISTED_ALPHA') return { ok: false,
        error: { code: 'GUIDED_WEAPON_UNAVAILABLE', message: 'El daño real requiere una campaña Alpha asistida; no se enviará al GM automático.' } };
    }
    if (prepared.ok) {
      this.#mechanicalInput = structuredClone(input); this.#mechanicalAction = prepared.value;
      this.#travel = travel.value; this.#assistedEvents = []; this.#assistedReceipt = undefined;
    }
    return prepared;
  }

  async resolveAssistedMechanic(input: RunTurnInput): Promise<TurnPortResult<{ narration: string }>> {
    if (this.#mechanicalInput === undefined || canonicalJson(this.#mechanicalInput) !== canonicalJson(input)
      || (this.#travel === null && this.#mechanicalAction === null)) {
      return { ok: false, error: { code: 'GUIDED_CAPABILITY_UNAVAILABLE', message: 'Falta una operación asistida registrada y preparada.' } };
    }
    const session = await this.#campaigns.session(input.campaignId);
    if (!session.ok) return session;
    const opened = await new JsonCampaignStore(this.#campaigns.rootFor(input.campaignId)).open(session.value.branchId);
    if (!opened.ok) return opened;
    if (this.#mechanicalAction !== null) {
      // Same DiceEngine port and pending log as the historical flow; no LLM decides any roll or effect.
      for (let step = 0; step <= 6; step++) {
        const frame = advanceMechanicalAction(this.#mechanicalAction, this.#pendingDice.get(input.turnId)?.refs ?? []);
        if (!frame.ok) return frame;
        if (frame.value.next_roll !== null) {
          const rolled = await this.rollRequired([{ ...frame.value.next_roll }], input);
          if (!rolled.ok) return rolled;
          continue;
        }
        if (frame.value.outcome === null || frame.value.narration === null) return { ok: false,
          error: { code: 'MECHANICAL_RECEIPT_MISMATCH', message: 'Falta el resultado mecánico completo.' } };
        const damage = buildWeaponDamageHealthChange(frame.value, opened.value);
        if (!damage.ok) return damage;
        const diceCount = this.#pendingDice.get(input.turnId)?.events.length ?? 0;
        this.#assistedEvents = damage.value === null ? [] : [{
          schema_version: '1.1', event_id: `EV-HP-${sha256(`${input.turnId}:${frame.value.profile.target_id}`).slice(0, 24)}`,
          event_type: 'HP_CHANGED', campaign_id: input.campaignId, branch_id: session.value.branchId, turn_id: input.turnId,
          base_state_version: input.baseStateVersion + diceCount, committed_state_version: input.baseStateVersion + diceCount + 1,
          actor_id: frame.value.profile.actor_id, targets: [frame.value.profile.target_id], correlation_id: `${input.turnId}-WEAPON`,
          occurred_at: this.#now().toISOString(), campaign_time: `elapsed_minutes:${opened.value.world.elapsed_minutes}`,
          committed: true, payload: { ...damage.value }, evidence: [`mechanical_action:${frame.value.profile.action_id}`],
          source_refs: [...frame.value.profile.source_refs]
        }];
        this.#assistedReceipt = frame.value.narration;
        return { ok: true, value: { narration: this.#assistedReceipt } };
      }
      return { ok: false, error: { code: 'MECHANICAL_ROLL_LIMIT', message: 'El ataque excedió el número de tiradas registrado.' } };
    }
    const rebound = prepareRegisteredTravel(opened.value, input);
    if (!rebound.ok) return rebound;
    if (canonicalJson(rebound.value) !== canonicalJson(this.#travel)) return { ok: false,
      error: { code: 'TRAVEL_STATE_STALE', message: 'La ruta cambió desde su preparación.' } };
    const route = this.#travel!;
    const occurredAt = this.#now().toISOString();
    const effects: Pick<AtomicEvent, 'event_type' | 'payload'>[] = [
      { event_type: 'LOCATION_CHANGED', payload: { from_location_id: route.from_location_id,
        to_location_id: route.to_location_id, character_ids: route.character_ids, scene: route.destination_scene } },
      { event_type: 'TIME_ADVANCED', payload: { minutes: route.duration_minutes } }
    ];
    this.#assistedEvents = effects.map((effect, index) => ({
      schema_version: '1.1', event_id: `EV-TRAVEL-${sha256(`${input.turnId}:${index}`).slice(0, 24)}`,
      ...effect, campaign_id: input.campaignId, branch_id: session.value.branchId, turn_id: input.turnId,
      base_state_version: input.baseStateVersion + index, committed_state_version: input.baseStateVersion + index + 1,
      actor_id: route.actor_id, targets: [...route.character_ids], correlation_id: `${input.turnId}-TRAVEL`,
      occurred_at: occurredAt, campaign_time: `elapsed_minutes:${opened.value.world.elapsed_minutes}`,
      committed: true, evidence: [`registered_travel:${route.route_id}`], source_refs: [...route.source_refs]
    }));
    this.#assistedReceipt = registeredTravelReceipt(route);
    return { ok: true, value: { narration: this.#assistedReceipt } };
  }

  #validateMechanical(candidate: unknown): TurnPortResult<void> {
    if (this.#mechanicalInput === undefined) return { ok: false, error: { code: 'MECHANICAL_NOT_PREPARED', message: 'Falta el límite mecánico confirmado.' } };
    if (this.#mechanicalAction === null) return validateMechanicalCandidate(null, candidate);
    const frame = advanceMechanicalAction(this.#mechanicalAction, this.#pendingDice.get(this.#mechanicalInput.turnId)?.refs ?? []);
    return frame.ok ? validateMechanicalCandidate(frame.value, candidate) : frame;
  }

  async rollRequired(
    requests: readonly Record<string, unknown>[],
    context: TurnExecutionContext
  ): Promise<TurnPortResult<readonly DesignTurnEnvelope.RollRef[]>> {
    const session = await this.#campaigns.session(context.campaignId);
    if (!session.ok) return { ok: false, error: session.error };
    const root = this.#campaigns.rootFor(context.campaignId);
    const opened = await new JsonCampaignStore(root).open(session.value.branchId);
    if (!opened.ok) return { ok: false, error: opened.error };
    if (context.turnId !== this.#mechanicalInput?.turnId || context.baseStateVersion !== opened.value.state_version) {
      return { ok: false, error: { code: 'MECHANICAL_STATE_STALE', message: 'La tirada no está vinculada al estado preparado.' } };
    }
    const allowed = this.#validateMechanical({ resolution_status: 'AWAITING_ROLL', required_rolls: requests });
    if (!allowed.ok) return allowed;
    const pending = this.#pendingDice.get(context.turnId);
    const events = [...(pending?.events ?? [])];
    const allRefs = [...(pending?.refs ?? [])];
    const provisional = replayEvents(opened.value, events);
    if (!provisional.ok) return { ok: false, error: provisional.error };
    let rng = provisional.value.rng;
    let version = provisional.value.state_version;
    const refs: DesignTurnEnvelope.RollRef[] = [];
    for (const [index, request] of requests.entries()) {
      const expression = request['expression'];
      if (typeof expression !== 'string') {
        return { ok: false, error: { code: 'ROLL_REQUEST_INVALID', message: 'La tirada no incluye una expresión válida.' } };
      }
      const rollId = typeof request['roll_id'] === 'string' ? request['roll_id'] : `ROLL-${context.turnId}-${index + 1}`;
      const prior = allRefs.find(ref => ref.roll_id === rollId);
      if (prior !== undefined) {
        if (prior.expression !== expression) {
          return { ok: false, error: { code: 'ROLL_ID_CONFLICT', message: 'Una tirada existente no puede cambiar de expresión.' } };
        }
        refs.push(prior);
        continue;
      }
      const rolled = new DiceEngine().roll(rng, expression);
      if (!rolled.ok) return { ok: false, error: rolled.error };
      const eventId = `EV-DICE-${sha256(`${context.turnId}:${rollId}:${String(rng.roll_index)}`).slice(0, 24)}`;
      events.push({
        schema_version: '1.1',
        event_id: eventId,
        event_type: 'DICE_ROLLED',
        campaign_id: context.campaignId,
        branch_id: session.value.branchId,
        turn_id: context.turnId,
        base_state_version: version,
        committed_state_version: version + 1,
        actor_id: 'system.dice',
        targets: [],
        correlation_id: `${context.turnId}-DICE-${events.length + 1}`,
        occurred_at: this.#now().toISOString(),
        campaign_time: `elapsed_minutes:${String(opened.value.world['elapsed_minutes'] ?? 0)}`,
        committed: true,
        payload: { ...rolled.value.record },
        evidence: [`Deterministic roll ${rollId}`, `mechanical_action:${this.#mechanicalAction!.profile.action_id}`],
        source_refs: ['estrcuttura/02-nyx-estado-reglas.md:890-923', ...this.#mechanicalAction!.profile.source_refs]
      });
      const ref = { roll_id: rollId, expression, result: rolled.value.record.total, rng_counter: rng.roll_index };
      refs.push(ref);
      allRefs.push(ref);
      rng = rolled.value.next_rng;
      version += 1;
    }
    this.#pendingDice.set(context.turnId, { events, refs: allRefs });
    return { ok: true, value: refs };
  }

  async commitCandidate(input: StateCommitCandidate): Promise<TurnPortResult<{ committedStateVersion: number }>> {
    const session = await this.#campaigns.session(input.campaignId);
    if (!session.ok) return { ok: false, error: session.error };
    if (session.value.stateVersion !== input.baseStateVersion) {
      return { ok: false, error: { code: 'STALE_STATE', message: 'La versión base ya no es la última confirmada.' } };
    }
    if (input.resolution.patches_to_commit.length > 0) {
      return { ok: false, error: { code: 'PATCHES_UNSUPPORTED', message: 'C3 no puede confirmar patches sin reducer atómico.' } };
    }
    const root = this.#campaigns.rootFor(input.campaignId);
    const store = new JsonCampaignStore(root);
    const base = await store.open(session.value.branchId);
    if (!base.ok) return { ok: false, error: base.error };
    if (this.#mechanicalInput?.turnId !== input.turnId) return { ok: false, error: { code: 'MECHANICAL_NOT_PREPARED', message: 'El candidato carece de acción confirmada.' } };
    const rebound = prepareMechanicalAction(base.value, this.#mechanicalInput);
    if (!rebound.ok) return rebound;
    if (canonicalJson(rebound.value) !== canonicalJson(this.#mechanicalAction)) return { ok: false,
      error: { code: 'MECHANICAL_STATE_STALE', message: 'Los parámetros canónicos cambiaron antes del commit.' } };
    const travel = prepareRegisteredTravel(base.value, this.#mechanicalInput);
    if (!travel.ok) return travel;
    if (canonicalJson(travel.value) !== canonicalJson(this.#travel)) return { ok: false,
      error: { code: 'TRAVEL_STATE_STALE', message: 'La ruta canónica cambió antes del commit.' } };
    if (this.#travel !== null && (this.#assistedEvents.length !== 2 || input.resolution.player_facing_narration !== this.#assistedReceipt
      || input.resolution.events_to_commit.length !== 0 || input.resolution.required_rolls.length !== 0)) return { ok: false,
      error: { code: 'TRAVEL_RECEIPT_MISMATCH', message: 'El resultado no coincide con el viaje calculado.' } };
    if (this.#mechanicalAction?.schema_version === '1.1' && this.#assistedReceipt === undefined) return { ok: false,
      error: { code: 'MECHANICAL_EFFECT_MUST_BE_CODE_GENERATED', message: 'Falta la resolución de daño calculada por el código.' } };
    const allowed = this.#validateMechanical(input.resolution);
    if (!allowed.ok) return allowed;
    const proposedEvents = input.resolution.events_to_commit;
    if (proposedEvents.some(event => !isRecord(event))) {
      return { ok: false, error: { code: 'INVALID_EVENT', message: 'GM_RESOLVE produjo un evento no estructurado.' } };
    }
    const events = [
      ...(this.#pendingDice.get(input.turnId)?.events ?? []),
      ...this.#assistedEvents,
      ...(proposedEvents as AtomicEvent[])
    ];
    const knowledge = validateNewKnowledgeEvents(base.value, events, input.resolution.player_facing_narration, this.#mechanicalInput.playerInput);
    if (!knowledge.ok) return knowledge;
    const rulings = await this.#rules.validateProposedRulings(input.campaignId, events);
    if (!rulings.ok) return rulings;
    if (input.resolution.player_facing_narration.length === 0) {
      return { ok: false, error: { code: 'NARRATION_MISSING', message: 'READY no contiene narración publicable.' } };
    }
    const outboxRecord: TranscriptOutboxRecord = {
      schema: 'nyx.transcript_outbox.v1',
      status: 'PREPARED',
      event_ids: events.map(event => event.event_id),
      entry: transcriptEntry(
        input.campaignId,
        session.value.branchId,
        input.turnId,
        'gm',
        input.resolution.player_facing_narration,
        this.#now().toISOString()
      )
    };
    const outboxFile = await stageTranscriptOutbox(root, outboxRecord);
    const replayed = replayEvents(base.value, events);
    if (!replayed.ok) {
      await fs.rm(outboxFile, { force: true });
      return { ok: false, error: replayed.error };
    }
    const checkpoint = await latestCheckpoint(root);
    if (!checkpoint.ok) {
      await fs.rm(outboxFile, { force: true });
      return { ok: false, error: checkpoint.error };
    }
    const lock = new CampaignWriterLock(root);
    const lease = await lock.acquire({
      campaign_id: input.campaignId,
      branch_id: session.value.branchId,
      owner_runtime: 'typescript',
      pid: process.pid,
      checkpoint_id: checkpoint.value.checkpoint_id,
      state_sha256: sha256(canonicalJson(base.value)),
      acquired_at: this.#now().toISOString()
    });
    if (!lease.ok) {
      await fs.rm(outboxFile, { force: true });
      return { ok: false, error: lease.error };
    }
    const transactionId = `TX-${sha256(`${input.campaignId}:${input.turnId}:${String(input.baseStateVersion)}`).slice(0, 24)}`;
    try {
      if (events.length === 0) {
        // A narrative is still a confirmed publication: it must observe the writer lease and a current snapshot.
        const current = await store.open(session.value.branchId);
        const currentManifest = await readManifest(root);
        if (!current.ok || !currentManifest.ok || canonicalJson(current.value) !== canonicalJson(base.value)
          || currentManifest.value.campaign_id !== input.campaignId
          || currentManifest.value.active_branch_id !== session.value.branchId || currentManifest.value.state_version !== input.baseStateVersion) {
          await fs.rm(outboxFile, { force: true });
          return { ok: false, error: { code: 'STALE_STATE', message: 'La campaña cambió antes de confirmar la narración.' } };
        }
        await markTranscriptOutboxCommitted(outboxFile, outboxRecord);
        return { ok: true, value: { committedStateVersion: base.value.state_version } };
      }
      const committed = await store.commit({
        transaction_id: transactionId,
        base_state: base.value,
        candidate_state: replayed.value,
        events: events as [AtomicEvent, ...AtomicEvent[]]
      });
      if (!committed.ok) {
        await fs.rm(outboxFile, { force: true });
        return { ok: false, error: committed.error };
      }
      this.#pendingDice.delete(input.turnId);
      await markTranscriptOutboxCommitted(outboxFile, outboxRecord).catch(() => undefined);
      await this.#campaigns.updateStateVersion(input.campaignId, committed.value.state_version).catch(() => undefined);
      return { ok: true, value: { committedStateVersion: committed.value.state_version } };
    } finally {
      await lock.release(lease.value.token);
    }
  }
}

const RECENT_RAW_TRANSCRIPT_TURN_LIMIT = 10;

class LocalTurnContext implements TurnContextPort {
  readonly #campaigns: LocalCampaignAdministration;
  readonly #rules: LocalCampaignRules;

  constructor(campaigns: LocalCampaignAdministration, rules: LocalCampaignRules) {
    this.#campaigns = campaigns;
    this.#rules = rules;
  }

  async build(input: Parameters<TurnContextPort['build']>[0]): ReturnType<TurnContextPort['build']> {
    const session = await this.#campaigns.session(input.campaignId);
    if (!session.ok) return { ok: false, error: session.error };
    if (session.value.stateVersion !== input.baseStateVersion) {
      return { ok: false, error: { code: 'STALE_CONTEXT', message: 'El contexto solicitado no coincide con el estado confirmado.' } };
    }
    const root = this.#campaigns.rootFor(input.campaignId);
    const opened = await new JsonCampaignStore(root).open(session.value.branchId);
    if (!opened.ok) return { ok: false, error: opened.error };
    const compacted = await new JsonCompactionStore(root, {
      branch_id: session.value.branchId
    }).current();
    if (!compacted.ok) return { ok: false, error: compacted.error };
    if (
      compacted.value !== null
      && (
        compacted.value.campaign_id !== input.campaignId
        || compacted.value.branch_id !== session.value.branchId
        || compacted.value.base_state_version > opened.value.state_version
      )
    ) {
      return {
        ok: false,
        error: {
          code: 'STALE_COMPACTION',
          message: 'La vista de compactación activa no corresponde al estado confirmado.'
        }
      };
    }
    const transcript = await new JsonTranscriptStore(root).tail(session.value.branchId);
    if (!transcript.ok) return { ok: false, error: transcript.error };
    const previousTranscript = transcript.value.filter(entry => entry.turn_id !== input.turnId);
    if (compacted.value !== null) {
      const compactionBaseVersion = compacted.value.base_state_version;
      const availableTranscriptRefs = new Set(previousTranscript.flatMap(entry => [
        `transcript:${entry.transcript_id}`,
        `transcript:${entry.turn_id}`
      ]));
      const danglingRefs = compacted.value.context_view.recent_transcript_refs
        .filter(reference => !availableTranscriptRefs.has(reference));
      if (danglingRefs.length > 0) {
        return {
          ok: false,
          error: {
            code: 'INVALID_COMPACTION_TRANSCRIPT_REF',
            message: `La vista de compactación contiene ${String(danglingRefs.length)} referencia(s) de transcript no resoluble(s).`
          }
        };
      }
      const events = await new JsonCampaignStore(root).events.tail(session.value.branchId);
      if (!events.ok) return { ok: false, error: events.error };
      const eventIds = new Set(events.value.map(event => event.event_id));
      const turnIds = new Set([
        ...previousTranscript.map(entry => entry.turn_id),
        ...events.value.map(event => event.turn_id)
      ]);
      const invalidMemories = compacted.value.memory_records.filter(record => {
        // JsonCompactionStore valida el contrato y el hash de cada memoria antes de devolverla.
        const memory = record as unknown as HierarchicalMemoryRecord;
        return memory.campaign_id !== input.campaignId
          || memory.branch_id !== session.value.branchId
          || memory.updated_state_version > compactionBaseVersion
          || memory.content.provenance.source_turn_ids.some(id => !turnIds.has(id))
          || memory.content.provenance.source_event_ids.some(id => !eventIds.has(id))
          || memory.source_refs.some(ref => {
            if (ref.startsWith('turn:')) return !turnIds.has(ref.slice(5));
            if (ref.startsWith('event:')) return !eventIds.has(ref.slice(6));
            if (ref.startsWith('transcript:')) return !availableTranscriptRefs.has(ref);
            return false;
          });
      });
      if (invalidMemories.length > 0) {
        return {
          ok: false,
          error: {
            code: 'UNRESOLVED_MEMORY_PROVENANCE',
            message: 'La memoria compactada no tiene procedencia resoluble en esta campaña y rama.'
          }
        };
      }
    }
    const summarizedTurnIds = new Set((compacted.value?.memory_records ?? []).flatMap(record =>
      (record as unknown as HierarchicalMemoryRecord).content.provenance.source_turn_ids
    ));
    const retainedRefs = new Set(compacted.value?.context_view.recent_transcript_refs ?? []);
    const activeTranscript = previousTranscript.filter(entry => !summarizedTurnIds.has(entry.turn_id)
      || retainedRefs.has(`transcript:${entry.transcript_id}`) || retainedRefs.has(`transcript:${entry.turn_id}`));
    const completeTurnIds = completeTranscriptTurnIds(activeTranscript);
    const recentTurnIds = completeTurnIds.slice(-RECENT_RAW_TRANSCRIPT_TURN_LIMIT);
    // The ten-turn window bounds confirmed pairs, not rejected attempts. Keep the latter
    // exact and subject to real token pressure; never silently truncate them or make up GM replies.
    const completeTurnIdSet = new Set(completeTurnIds);
    const recentTurnIdSet = new Set([...recentTurnIds,
      ...activeTranscript.filter(entry => !completeTurnIdSet.has(entry.turn_id)).map(entry => entry.turn_id)]);
    const recentRawTranscript = activeTranscript.filter(entry => recentTurnIdSet.has(entry.turn_id));
    if (previousTranscript.some(entry =>
      !recentTurnIdSet.has(entry.turn_id) && !summarizedTurnIds.has(entry.turn_id)
    )) {
      return {
        ok: false,
        error: {
          code: 'COMPACTION_REQUIRED',
          message: 'La ventana reciente dejaría fuera historia sin memoria respaldada. Se requiere compactación antes de continuar.'
        }
      };
    }
    const manifest = await readManifest(root);
    if (!manifest.ok) return manifest;
    if (manifest.value.campaign_id !== input.campaignId || manifest.value.active_branch_id !== opened.value.branch_id
      || manifest.value.state_version !== opened.value.state_version) {
      return failure('STALE_CONTEXT', 'El manifest cambió durante la construcción del contexto.');
    }
    const publicAlpha = manifest.value.schema_version !== '1.0' && manifest.value.turn_profile === 'ASSISTED_ALPHA';
    if (publicAlpha && compacted.value !== null && !hasPublicAlphaMemoryProvenance(compacted.value.memory_records)) {
      return failure('PUBLIC_MEMORY_PROVENANCE_REQUIRED',
        'La memoria activa no acredita una fuente pública Alpha; se conserva sin servirla ni reclasificarla.');
    }
    const registry = await this.#rules.availableRuleScopes(input.campaignId);
    const packet = buildC6GmContextPacket(opened.value, {
      language: input.language,
      ...(publicAlpha ? { narrationScope: 'PUBLIC_ALPHA' as const } : {}),
      rulesetId: manifest.value.ruleset_id,
      rulesRegistry: { status: registry.ok ? 'AVAILABLE' : 'UNAVAILABLE', rule_refs: registry.ok ? registry.value.rule_refs : [] },
      playerMessage: input.playerMessage,
      recentRawTranscript,
      ...(compacted.value === null ? {} : {
        retrievedMemories: compacted.value.memory_records,
        activeOpenThreads: compacted.value.context_view.open_threads
      })
    });
    if (input.requestedRefs.length > 0) {
      const requestedMatches = input.requestedRefs.length === packet.context_refs.length &&
        input.requestedRefs.every((reference, index) => {
          const resolved = packet.context_refs[index];
          return resolved?.id === reference.id && resolved.sha256 === reference.sha256;
        });
      if (!requestedMatches) {
        return {
          ok: false,
          error: {
            code: 'UNRESOLVED_CONTEXT_REF',
            message: 'C3 sólo admite la referencia resuelta del estado canónico actual.'
          }
        };
      }
    }
    return { ok: true, value: packet };
  }
}

class LocalWorkerContext implements WorkerContextBuilderPort {
  readonly #campaigns: LocalCampaignAdministration;
  readonly #rules: LocalCampaignRules;

  constructor(campaigns: LocalCampaignAdministration, rules: LocalCampaignRules) {
    this.#campaigns = campaigns;
    this.#rules = rules;
  }

  async build(
    job: SotRpgjobCard.RPGJobCard,
    context: TurnExecutionContext
  ): Promise<TurnPortResult<readonly unknown[]>> {
    const session = await this.#campaigns.session(context.campaignId);
    if (!session.ok) return session;
    if (
      session.value.stateVersion !== context.baseStateVersion
      || job.base_state_version !== context.baseStateVersion
      || job.turn_id !== context.turnId
    ) {
      return { ok: false, error: { code: 'STALE_WORKER_CONTEXT', message: 'El contexto worker no coincide con el turno confirmado.' } };
    }
    const opened = await new JsonCampaignStore(this.#campaigns.rootFor(context.campaignId)).open(session.value.branchId);
    if (!opened.ok) return { ok: false, error: opened.error };
    const manifest = await readManifest(this.#campaigns.rootFor(context.campaignId));
    if (!manifest.ok) return manifest;
    if (manifest.value.campaign_id !== context.campaignId || manifest.value.active_branch_id !== opened.value.branch_id
      || manifest.value.state_version !== opened.value.state_version) return failure('STALE_WORKER_CONTEXT', 'Manifest y worker no coinciden.');
    const ruleContext = job.worker_id === 'rpg.rules_arbiter'
      ? await this.#rules.workerRuleContext(context.campaignId, job.inputs.rules_refs) : undefined;
    if (ruleContext !== undefined && !ruleContext.ok) return ruleContext;
    if (ruleContext?.ok && (ruleContext.value.state_version !== context.baseStateVersion
      || ruleContext.value.ruleset_id !== manifest.value.ruleset_id)) return failure('STALE_WORKER_CONTEXT', 'La fuente reglamentaria cambió.');
    const packet = buildC6WorkerContextPacket(opened.value, job, { rulesetId: manifest.value.ruleset_id,
      resolvedRules: ruleContext?.ok ? ruleContext.value.rules : [] });
    const errors = validateC6WorkerContextPacket(packet, opened.value, job);
    return errors.length === 0
      ? { ok: true, value: [packet] }
      : { ok: false, error: { code: 'WORKER_CONTEXT_INVALID', message: errors.join(',') } };
  }
}

class LocalWorkerQueuePersistence implements WorkerQueuePersistencePort {
  readonly #campaigns: LocalCampaignAdministration;
  readonly #stores = new Map<string, JsonWorkerQueueStore>();

  constructor(campaigns: LocalCampaignAdministration) {
    this.#campaigns = campaigns;
  }

  async loadLatestJobs(context: TurnExecutionContext): Promise<TurnPortResult<readonly SotRpgjobCard.RPGJobCard[]>> {
    return this.#map(await this.#store(context).recoverableJobs());
  }

  async loadAttempts(
    context: TurnExecutionContext
  ): Promise<TurnPortResult<readonly InternalWorkerAttempt.WorkerAttemptV1[]>> {
    return this.#map(await this.#store(context).attempts());
  }

  async recordBatch(
    context: TurnExecutionContext,
    batch: InternalWorkerQueueBatch.WorkerQueueBatchV1
  ): Promise<TurnPortResult<void>> {
    return this.#map(await this.#store(context).appendBatch(batch));
  }

  async recordJob(
    context: TurnExecutionContext,
    job: SotRpgjobCard.RPGJobCard
  ): Promise<TurnPortResult<void>> {
    return this.#map(await this.#store(context).appendJob(job));
  }

  async recordResult(
    context: TurnExecutionContext,
    result: SotRpgworkerResult.RPGWorkerResult
  ): Promise<TurnPortResult<void>> {
    return this.#map(await this.#store(context).appendResult(result));
  }

  async recordAttempt(
    context: TurnExecutionContext,
    attempt: InternalWorkerAttempt.WorkerAttemptV1
  ): Promise<TurnPortResult<void>> {
    return this.#map(await this.#store(context).appendAttempt(attempt));
  }

  #store(context: TurnExecutionContext): JsonWorkerQueueStore {
    const existing = this.#stores.get(context.campaignId);
    if (existing !== undefined) return existing;
    const store = new JsonWorkerQueueStore(this.#campaigns.rootFor(context.campaignId));
    this.#stores.set(context.campaignId, store);
    return store;
  }

  #map<T>(result: { readonly ok: true; readonly value: T } | {
    readonly ok: false;
    readonly error: { readonly code: string; readonly message: string; readonly details?: readonly string[] };
  }): TurnPortResult<T> {
    return result.ok
      ? { ok: true, value: result.value }
      : {
          ok: false,
          error: {
            code: result.error.code,
            message: result.error.message,
            ...(result.error.details === undefined ? {} : { details: result.error.details })
          }
        };
  }
}

class LocalWorkerOperations implements WorkerOperationsPort {
  readonly #campaigns: LocalCampaignAdministration;

  constructor(campaigns: LocalCampaignAdministration) {
    this.#campaigns = campaigns;
  }

  async status(campaignId: string): Promise<ApplicationPortResult<WorkerQueueReadModel>> {
    const session = await this.#campaigns.session(campaignId);
    if (!session.ok) return session;
    const root = this.#campaigns.rootFor(campaignId);
    const store = new JsonWorkerQueueStore(root);
    const jobs = await store.latestJobs();
    if (!jobs.ok) return failure(jobs.error.code, jobs.error.message);
    const attempts = await store.attempts();
    if (!attempts.ok) return failure(attempts.error.code, attempts.error.message);
    const checkpoint = await latestCheckpoint(root);
    if (!checkpoint.ok) return checkpoint;
    const latestAttempt = new Map(attempts.value.map(attempt => [attempt.job_id, attempt]));
    const statusCounts: Partial<Record<SotRpgjobCard.RPGJobCard['status'], number>> = {};
    for (const job of jobs.value) statusCounts[job.status] = (statusCounts[job.status] ?? 0) + 1;
    const failures = jobs.value.flatMap(job => {
      if (
        (job.priority !== 'P2' && job.priority !== 'P3')
        || job.status === 'PENDING'
        || job.status === 'READY'
        || job.status === 'RUNNING'
        || job.status === 'COMPLETED'
      ) return [];
      const attempt = latestAttempt.get(job.job_id);
      return [{
        jobId: job.job_id,
        priority: job.priority,
        status: job.status,
        reasonCode: attempt?.reason_code ?? `STATUS:${job.status}`,
        retryEligible: attempt?.retry_authorized ?? false
      }];
    });
    return ok({
      campaignId,
      stateVersion: session.value.stateVersion,
      queuedJobs: jobs.value.filter(job => job.status !== 'COMPLETED').length,
      statusCounts,
      failures,
      lastCheckpointId: checkpoint.value.checkpoint_id
    });
  }
}

class LocalTurnRunner implements TurnRunnerPort {
  readonly #contextPerSlot: number | undefined;
  readonly #gateway: LlmGateway;
  readonly #campaigns: LocalCampaignAdministration;
  readonly #now: () => Date;
  readonly #workers: ScheduledTurnWorkerPort;
  readonly #observability: OperationalLogger;
  readonly #rules: LocalCampaignRules;

  constructor(
    gateway: LlmGateway,
    campaigns: LocalCampaignAdministration,
    now: () => Date,
    observability: OperationalLogger,
    rules: LocalCampaignRules,
    contextPerSlot: number | undefined
  ) {
    this.#gateway = gateway;
    this.#campaigns = campaigns;
    this.#now = now;
    this.#observability = observability;
    this.#rules = rules;
    this.#contextPerSlot = contextPerSlot;
    this.#workers = new ScheduledTurnWorkerPort(
      new GovernedWorkerRunner(gateway),
      {
        timeoutMs: 180_000,
        persistence: new LocalWorkerQueuePersistence(campaigns),
        contextBuilder: new LocalWorkerContext(campaigns, rules),
        observability
      }
    );
  }

  async runTurn(input: Parameters<TurnRunnerPort['runTurn']>[0]): ReturnType<TurnRunnerPort['runTurn']> {
    const session = await this.#campaigns.session(input.campaignId);
    if (!session.ok) return { status: 'BLOCKED', code: session.error.code, message: session.error.message, transitions: ['WAIT_PLAYER'] };
    if (session.value.stateVersion !== input.baseStateVersion) {
      return { status: 'BLOCKED', code: 'STALE_STATE', message: 'La versión de estado cambió.', transitions: ['WAIT_PLAYER'] };
    }
    const manifest = await readManifest(this.#campaigns.rootFor(input.campaignId));
    if (!manifest.ok) return { status: 'BLOCKED', code: manifest.error.code, message: manifest.error.message, transitions: ['WAIT_PLAYER'] };
    const profile = manifest.value.schema_version !== '1.0' ? manifest.value.turn_profile : 'AUTOMATIC_EXPERIMENTAL';
    const stateAndDice = new LocalTurnPorts(this.#campaigns, this.#now, this.#rules);
    if (input.playerInput.trim().startsWith('/travel') || (profile === 'ASSISTED_ALPHA' && input.playerInput.trim().startsWith('/action'))) {
      // Admission precedes tokenization/transcript; the same port rebinds after context building and at commit.
      const admitted = await stateAndDice.prepare(input);
      if (!admitted.ok) return { status: 'BLOCKED', code: admitted.error.code, message: admitted.error.message, transitions: ['WAIT_PLAYER'] };
    }
    const began = await this.#workers.beginTurn(input);
    if (!began.ok) return { status: 'BLOCKED', code: began.error.code, message: began.error.message, transitions: ['WAIT_PLAYER'] };
    const memory = await this.#memoryGate(input);
    if (!memory.ok) {
      await this.#workers.resumeAfterBlockedTurn(input);
      return { status: 'BLOCKED', code: memory.error.code, message: memory.error.message, transitions: ['MEMORY_GATE', 'WAIT_PLAYER'] };
    }
    const transcript = new JsonTranscriptStore(this.#campaigns.rootFor(input.campaignId));
    const playerEntry = transcriptEntry(
      input.campaignId,
      session.value.branchId,
      input.turnId,
      'player',
      input.playerInput,
      this.#now().toISOString()
    );
    const appendedPlayer = await transcript.append(playerEntry);
    if (!appendedPlayer.ok) {
      return { status: 'BLOCKED', code: appendedPlayer.error.code, message: appendedPlayer.error.message, transitions: ['WAIT_PLAYER'] };
    }
    const orchestrator = new TurnOrchestrator(
      {
        gateway: this.#gateway,
        observability: this.#observability,
        context: new LocalTurnContext(this.#campaigns, this.#rules),
        state: stateAndDice,
        dice: stateAndDice,
        mechanics: stateAndDice,
        workers: this.#workers
      },
      { maxResolveCycles: 8, maxReplans: 1, requestTimeoutMs: 180_000, profile }
    );
    const outcome = await orchestrator.runTurn(input);
    if (outcome.status === 'COMMITTED') {
      await drainTranscriptOutbox(this.#campaigns.rootFor(input.campaignId));
      const maintained = await this.#memoryGate(input);
      if (!maintained.ok) return { ...outcome, warnings: [...(outcome.warnings ?? []), maintained.error] };
    } else {
      await this.#workers.resumeAfterBlockedTurn({
        campaignId: input.campaignId,
        turnId: input.turnId,
        baseStateVersion: input.baseStateVersion
      });
    }
    return outcome;
  }

  async #memoryGate(input: Parameters<TurnRunnerPort['runTurn']>[0]) {
    const session = await this.#campaigns.session(input.campaignId);
    if (!session.ok) return session;
    const root = this.#campaigns.rootFor(input.campaignId);
    const parent = await latestCheckpoint(root);
    if (!parent.ok) return parent;
    const manifest = await readManifest(root);
    if (!manifest.ok) return manifest;
    return compactLocalCampaign({ campaignRoot: root, campaignId: input.campaignId, branchId: session.value.branchId,
      gateway: this.#gateway, parentCheckpointId: parent.value.checkpoint_id,
      ...(this.#contextPerSlot === undefined ? {} : { contextPerSlot: this.#contextPerSlot }),
      ...(manifest.value.schema_version !== '1.0' && manifest.value.turn_profile === 'ASSISTED_ALPHA'
        ? { narrationScope: 'PUBLIC_ALPHA' as const } : {}),
      createCheckpoint: () => this.#campaigns.save(input.campaignId), now: this.#now,
      turn: { turnId: input.turnId, playerInput: input.playerInput } });
  }

  releasePostResponse(): void {
    this.#workers.releasePostResponse();
  }
}

/** Runtime instructions are derived; the extracted SOT prompt remains byte-for-byte intact. */
export function composeLocalGmPrompt(literal: string): string {
  return `${literal}\n\n[DESIGN] Disciplina de ejecución del runtime local:
Responde al current_player_message actual del context_packet, no repitas la introducción ni sustituyas la acción declarada por preparativos o preguntas ya resueltas. El jugador es el personaje kind=player; no lo confundas con un NPC ni cambies los nombres, roles o conocimientos confirmados.
No vuelvas a registrar el contexto ya confirmado como conocimiento nuevo. Un saludo, una pregunta o recordar un dato existente no es aprendizaje: events_to_commit debe estar vacío si nada cambia. Para responder por un NPC usa únicamente su packet de knowledge/beliefs/observaciones; facts globales no equivalen a conocimiento del NPC. Si no sabe la respuesta, debe reconocer esa limitación; no inventes una explicación experta ni la guardes como conocimiento. El worker sólo propone y su confidence o su propia respuesta no acreditan verdad.
Para NPC Director incluye en inputs.state_refs el identificador subject:<NPC-id> y solicita que distinga diálogo visible de información retenida; las referencias a manuales no son hechos de campaña.
Nueva adquisición: payload {subject_id,knowledge_id,value,acquisition:{schema_version:"1.0",kind:"DISCLOSURE"|"OBSERVATION",source_subject_id,source_id}}. DISCLOSURE copia value exactamente del knowledge de source_subject_id, exige ambos presentes y audiencia autorizada; actor_id es el emisor y evidence/source_refs incluyen knowledge:<emisor>:<source_id>. Su única narración tiene este formato: <nombre emisor> dice en privado a <nombre receptor>: «<text exacto>». No inventes el discurso voluntario del jugador. OBSERVATION sólo admite un fact public con location_id actual: source_subject_id=null, source_id=fact_id, value={fact_id,text exacto}, actor_id=receptor, referencia canon:<fact_id> y narración con formato: <nombre receptor> observa: «<text exacto>». targets incluye al receptor. No mezcles adquisiciones con otros cambios ni crees su fuente en el mismo lote; sin procedencia verificable no propongas NPC_KNOWLEDGE_ADDED. NPC_BELIEF_CHANGED conserva {subject_id,belief_id,value}; creencia y conocimiento no son intercambiables.
El prefijo /action selecciona una acción mecánica registrada; no es diálogo pronunciado por el personaje. En RESOLVE el runtime aporta mechanical_action: si es null no hay tiradas autorizadas. Si contiene next_roll, emite AWAITING_ROLL con exactamente esa petición. Si contiene outcome, emite READY copiando exactamente narration y sin eventos ni patches: los dados se confirman por el runtime. No añadas modificadores al result, no inventes IDs ni efectos y no describas daño aplicado a PG cuando el efecto sea CALCULATE_DAMAGE_ONLY.
PLAN no delega tiradas: Dice Engine no es un worker. Si las reglas y fórmulas están confirmadas, usa DIRECT y solicita las tiradas en RESOLVE. Un saludo o una conversación sin prueba mecánica no necesita dados. Los workers sólo aportan propuestas: aunque afirmen «Dice Engine roll» o presenten cifras, eso NO es evidencia de una tirada. Si deterministic_rolls está vacío no hay ninguna tirada confirmada para este turno. En combate solicita ataque, comprueba el resultado y sólo después solicita daño si hubo impacto.
READY contiene de una a tres frases breves completas en español, preferiblemente menos de 600 caracteres. Empieza con la respuesta o reacción concreta a la acción actual: si el jugador saluda, el NPC saluda; no gastes el turno en describir la posada, presentar de nuevo el grupo o repetir la entrada. Cierra cada frase y diálogo con punto, interrogación o exclamación; no uses puntos suspensivos ni palabras truncadas. El máximo de 1200 caracteres es un techo, nunca un objetivo que rellenar. No introduzcas caracteres de otros alfabetos salvo citas exactas autorizadas.
Si cambia la ubicación, propone LOCATION_CHANGED con payload {from_location_id,to_location_id,character_ids,scene}; scene contiene location_id,summary,present_character_ids,immediate_threats,open_questions. Participantes y origen deben coincidir con el estado y la acción declarada. Para tiempo propone TIME_ADVANCED con payload {minutes}; no representes un viaje sólo en prosa.
Cada evento candidato usa DomainEvent 1.1, identidad campaign_id/branch_id/turn_id del contexto, evidence y source_refs explícitos. Sus versiones siguen a las tiradas pendientes: base_state_version del turno más deterministic_rolls.length más el índice del evento; committed_state_version es esa base más uno. No vuelvas a proponer DICE_ROLLED: lo confirma el runtime. No escribas patches. Sólo el State Engine acepta cambios y publica la narración tras commit.\n`;
}

async function loadDefaultGateway(productRoot: string, observability: OperationalLogger): Promise<{
  gateway: LlmGateway;
  requiredModelId: string;
  modelFingerprint: string;
  runtimeProfile: RuntimeProfileName;
  contextPerSlot: number;
}> {
  const configuration = JSON.parse(
    await fs.readFile(path.join(productRoot, 'config', 'runtime-profiles.json'), 'utf8')
  ) as RuntimeProfilesFile;
  const profile = configuration.profiles.find(candidate => candidate.profile === configuration.production_profile);
  if (profile === undefined || !validateRuntimeContract('RuntimeProfile', profile).ok) throw new Error('Perfil runtime de producción inválido.');
  const gmPrompt = await fs.readFile(path.join(productRoot, 'packages', 'contracts', 'prompts', 'nyx', 'nyx_gm.txt'), 'utf8');
  const promptFiles: Readonly<Record<SotRpgjobCard.RPGJobCard['worker_id'], string>> = {
    'rpg.rules_arbiter': 'rpg_rules_arbiter.txt',
    'rpg.npc_director': 'rpg_npc_director.txt',
    'rpg.world_simulator': 'rpg_world_simulator.txt',
    'rpg.encounter_engine': 'rpg_encounter_engine.txt',
    'rpg.state_keeper': 'rpg_state_keeper.txt',
    'rpg.memory_keeper': 'rpg_memory_keeper.txt',
    'rpg.canon_validator': 'rpg_canon_validator.txt',
    'rpg.lore_curator': 'rpg_lore_curator.txt'
  };
  const workerPrompts: Partial<Record<SotRpgjobCard.RPGJobCard['worker_id'], string>> = {};
  for (const [workerId, file] of Object.entries(promptFiles) as [SotRpgjobCard.RPGJobCard['worker_id'], string][]) {
    workerPrompts[workerId] = await fs.readFile(path.join(productRoot, 'packages', 'contracts', 'prompts', 'nyx', file), 'utf8');
  }
  return {
    gateway: new LlamaServerGateway({
      origin: `http://${profile.host}:${String(profile.port)}`,
      modelId: configuration.model.alias,
      contextPerSlot: profile.context_per_slot,
      gmPrompt: composeLocalGmPrompt(gmPrompt),
      workerPrompts,
      observability
    }),
    requiredModelId: configuration.model.alias,
    modelFingerprint: configuration.model.sha256,
    runtimeProfile: profile.profile,
    contextPerSlot: profile.context_per_slot
  };
}

export async function createLocalNyxRuntime(options: LocalNyxRuntimeOptions): Promise<LocalNyxRuntime> {
  if (options.newCampaignTurnProfile !== undefined
    && !['ASSISTED_ALPHA', 'AUTOMATIC_EXPERIMENTAL'].includes(options.newCampaignTurnProfile)) {
    throw new RangeError('Perfil de campaña nueva desconocido.');
  }
  const productRoot = path.resolve(options.productRoot);
  const observability = options.observability
    ?? new SafeOperationalLogger(new JsonlOperationalLogSink(path.join(productRoot, 'logs')));
  const defaults = options.gateway === undefined ? await loadDefaultGateway(productRoot, observability) : undefined;
  const gateway = options.gateway ?? defaults?.gateway;
  const requiredModelId = options.requiredModelId ?? defaults?.requiredModelId;
  const modelFingerprint = options.modelFingerprint ?? defaults?.modelFingerprint;
  const newCampaignRuntimeProfile = options.newCampaignRuntimeProfile ?? defaults?.runtimeProfile ?? '96k';
  if (!['64k', '96k', '112k'].includes(newCampaignRuntimeProfile)) throw new RangeError('Perfil runtime desconocido.');
  const contextPerSlot = defaults?.contextPerSlot ?? (options.newCampaignRuntimeProfile === undefined ? undefined
    : ({ '64k': 65536, '96k': 98304, '112k': 114688 } as const)[options.newCampaignRuntimeProfile]);
  if (gateway === undefined || requiredModelId === undefined || modelFingerprint === undefined) {
    throw new Error('gateway, requiredModelId y modelFingerprint son obligatorios.');
  }
  if (!/^[a-f0-9]{64}$/.test(modelFingerprint)) throw new Error('modelFingerprint inválido.');
  const protectedManifest = options.protectedManifest ?? JSON.parse(
    await fs.readFile(path.join(productRoot, 'packages', 'contracts', 'manifests', 'protected-content.json'), 'utf8')
  ) as ProtectedManifestLike;
  const now = options.now ?? (() => new Date());
  const campaignsRoot = options.campaignsRoot ?? path.join(productRoot, 'campaigns');
  const campaigns = new LocalCampaignAdministration(
    campaignsRoot,
    protectedManifest,
    modelFingerprint,
    now,
    options.campaignSeed ?? (() => crypto.randomUUID()),
    observability,
    options.newCampaignTurnProfile,
    newCampaignRuntimeProfile
  );
  const rules = new LocalCampaignRules(productRoot, campaignsRoot);
  const application = new NyxApplicationService({
    gateway,
    observability,
    runtime: new LocalRuntimeControl(productRoot, gateway),
    campaigns,
    turns: new LocalTurnRunner(gateway, campaigns, now, observability, rules, contextPerSlot),
    fallback: new LocalFallbackControl(productRoot, campaigns, campaignsRoot, options.fallbackProcessRunner),
    diagnostics: new LocalDiagnostics(productRoot),
    workers: new LocalWorkerOperations(campaigns),
    rules
  }, { requiredModelId });
  return {
    application, openSession: campaignId => campaigns.session(campaignId),
    closeTestScene: async campaignId => {
      if (options.enableTestSceneCompaction !== true) return failure('TEST_SCENE_NOT_ENABLED', 'La excepción de prueba no está habilitada.');
      const session = await campaigns.session(campaignId);
      if (!session.ok) return session;
      const root = campaigns.rootFor(campaignId);
      const parent = await latestCheckpoint(root);
      if (!parent.ok) return parent;
      const manifest = await readManifest(root);
      if (!manifest.ok) return manifest;
      return closeLocalTestScene({ campaignRoot: root, campaignId, branchId: session.value.branchId,
        ...(contextPerSlot === undefined ? {} : { contextPerSlot }),
        ...(manifest.value.schema_version !== '1.0' && manifest.value.turn_profile === 'ASSISTED_ALPHA'
          ? { narrationScope: 'PUBLIC_ALPHA' as const } : {}),
        gateway, parentCheckpointId: parent.value.checkpoint_id, createCheckpoint: () => campaigns.save(campaignId), now });
    }
  };
}
