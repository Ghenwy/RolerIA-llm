import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ConfirmedHandoffBoundary,
  FallbackHandoffAdapter,
  HandoffErrorCode,
  HandoffResult,
  RuntimeOwner
} from '@nyx/application';
import type { CampaignManifest, DesignFallbackHandoff } from '@nyx/contracts';
import { validateRuntimeContract } from '@nyx/contracts';
import { canonicalJson } from '@nyx/domain';
import {
  CampaignWriterLock,
  JsonCampaignStore,
  JsonCheckpointStore,
  captureDnd35Boundary,
  sha256,
  type CheckpointManifest
} from '@nyx/persistence-json';

export interface LocalFallbackHandoffOptions {
  readonly pid?: number;
  readonly now?: () => Date;
}

function failure(code: HandoffErrorCode, message: string): HandoffResult<never> {
  return { ok: false, error: { code, message } };
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function handoffFileName(handoff: DesignFallbackHandoff.FallbackHandoffV1): string {
  return `${handoff.checkpoint_id}.${handoff.source_runtime}-to-${handoff.target_runtime}.json`;
}

function transactionArtifact(name: string): boolean {
  return name.endsWith('.tmp') || name.endsWith('.journal.json');
}

export class LocalFallbackHandoffAdapter implements FallbackHandoffAdapter {
  readonly #root: string;
  readonly #pid: number;
  readonly #now: () => Date;
  readonly #writer: CampaignWriterLock;

  constructor(campaignRoot: string, options: LocalFallbackHandoffOptions = {}) {
    this.#root = path.resolve(campaignRoot);
    this.#pid = options.pid ?? process.pid;
    this.#now = options.now ?? (() => new Date());
    this.#writer = new CampaignWriterLock(this.#root);
  }

  async #manifest(): Promise<CampaignManifest> {
    const value = JSON.parse(await fs.readFile(path.join(this.#root, 'campaign.json'), 'utf8')) as unknown;
    if (!validateRuntimeContract('CampaignManifest', value).ok) throw new Error('invalid campaign manifest');
    return value as CampaignManifest;
  }

  async #transactionStatus(): Promise<'IDLE' | 'ACTIVE'> {
    const directory = path.join(this.#root, 'transactions');
    if (!(await exists(directory))) return 'IDLE';
    return (await fs.readdir(directory)).some(transactionArtifact) ? 'ACTIVE' : 'IDLE';
  }

  async #state(manifest: CampaignManifest): Promise<{ text: string; value: unknown }> {
    const directory = path.join(this.#root, manifest.paths.state);
    const prefix = `${manifest.active_branch_id}.`;
    const file = (await fs.readdir(directory))
      .filter(name => name.startsWith(prefix) && name.endsWith('.json'))
      .sort()
      .at(-1);
    if (file === undefined) throw new Error('confirmed state missing');
    const text = await fs.readFile(path.join(directory, file), 'utf8');
    return { text, value: JSON.parse(text) as unknown };
  }

  async #checkpoint(
    manifest: CampaignManifest
  ): Promise<CheckpointManifest> {
    const directory = path.join(this.#root, manifest.paths.checkpoints);
    const ids = (await fs.readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name.startsWith('CHECKPOINT-'))
      .map(entry => entry.name);
    const campaigns = new JsonCampaignStore(this.#root);
    const checkpoints = new JsonCheckpointStore(this.#root, campaigns);
    const matches: CheckpointManifest[] = [];
    for (const id of ids) {
      const verified = await checkpoints.verify(id);
      if (
        verified.ok &&
        verified.value.campaign_id === manifest.campaign_id &&
        verified.value.branch_id === manifest.active_branch_id &&
        verified.value.state_version === manifest.state_version
      ) matches.push(verified.value);
    }
    const latest = matches.sort((left, right) => left.created_at.localeCompare(right.created_at)).at(-1);
    if (latest === undefined) throw new Error('matching checkpoint missing');
    return latest;
  }

  async inspectConfirmedBoundary(): Promise<HandoffResult<ConfirmedHandoffBoundary>> {
    try {
      const manifest = await this.#manifest();
      const transactionStatus = await this.#transactionStatus();
      const checkpoint = await this.#checkpoint(manifest);
      const state = await this.#state(manifest);
      if (sha256(state.text) !== checkpoint.state_sha256) throw new Error('state/checkpoint hash mismatch');
      const parsedState = state.value as { campaign_id?: unknown; branch_id?: unknown; state_version?: unknown };
      if (
        parsedState.campaign_id !== manifest.campaign_id ||
        parsedState.branch_id !== manifest.active_branch_id ||
        parsedState.state_version !== manifest.state_version
      ) throw new Error('state/manifest identity mismatch');
      const eventFile = path.join(this.#root, manifest.paths.events, `${manifest.active_branch_id}.jsonl`);
      const eventText = await exists(eventFile) ? await fs.readFile(eventFile, 'utf8') : '';
      if (sha256(eventText) !== checkpoint.event_tail_hash) throw new Error('event/checkpoint hash mismatch');
      const dnd35 = await captureDnd35Boundary(this.#root, manifest.campaign_id, manifest.active_branch_id);
      const expectedArtifacts = checkpoint.schema_version === '1.2' ? checkpoint.artifacts : [];
      if (canonicalJson(dnd35.artifacts.map(artifact => artifact.entry)) !== canonicalJson(expectedArtifacts)) {
        throw new Error('D&D authority/checkpoint boundary mismatch');
      }
      return {
        ok: true,
        value: {
          campaign_id: checkpoint.campaign_id,
          branch_id: checkpoint.branch_id,
          committed_state_version: checkpoint.state_version,
          checkpoint_id: checkpoint.checkpoint_id,
          state_sha256: checkpoint.state_sha256,
          event_tail_hash: checkpoint.event_tail_hash,
          rng_hash: checkpoint.rng_hash,
          transaction_status: transactionStatus,
          foreign_writer_lock_present: await exists(path.join(this.#root, 'locks', 'writer.lock.json'))
        }
      };
    } catch (error) {
      return failure(
        'HANDOFF_BOUNDARY_UNAVAILABLE',
        `No existe un límite confirmado verificable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async persistHandoff(handoff: DesignFallbackHandoff.FallbackHandoffV1): Promise<HandoffResult<void>> {
    if (!validateRuntimeContract('FallbackHandoff', handoff).ok) {
      return failure('HANDOFF_CONTRACT_INVALID', 'El FallbackHandoff no cumple su schema.');
    }
    const directory = path.join(this.#root, 'handoffs');
    const file = path.join(directory, handoffFileName(handoff));
    const contents = canonicalJson(handoff);
    try {
      await fs.mkdir(directory, { recursive: true });
      if (await exists(file)) {
        return (await fs.readFile(file, 'utf8')) === contents
          ? { ok: true, value: undefined }
          : failure('HANDOFF_PERSIST_FAILED', 'Ya existe otro handoff para el mismo checkpoint.');
      }
      const handle = await fs.open(file, 'wx');
      try {
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { ok: true, value: undefined };
    } catch (error) {
      return failure('HANDOFF_PERSIST_FAILED', `No se pudo persistir el handoff: ${String(error)}`);
    }
  }

  async acquireTargetWriter(
    targetRuntime: RuntimeOwner,
    boundary: ConfirmedHandoffBoundary,
    handoff: DesignFallbackHandoff.FallbackHandoffV1
  ): Promise<HandoffResult<{ token: string }>> {
    const persistedFile = path.join(this.#root, 'handoffs', handoffFileName(handoff));
    try {
      if ((await fs.readFile(persistedFile, 'utf8')) !== canonicalJson(handoff)) {
        return failure('HANDOFF_PERSIST_FAILED', 'El handoff durable no coincide con el contrato recibido.');
      }
    } catch {
      return failure('HANDOFF_PERSIST_FAILED', 'No existe el handoff durable que debe aceptar el destino.');
    }
    const acquired = await this.#writer.acquire({
      campaign_id: boundary.campaign_id,
      branch_id: boundary.branch_id,
      owner_runtime: targetRuntime,
      pid: this.#pid,
      checkpoint_id: boundary.checkpoint_id,
      state_sha256: boundary.state_sha256,
      acquired_at: this.#now().toISOString()
    });
    return acquired.ok
      ? { ok: true, value: { token: acquired.value.token } }
      : failure('HANDOFF_LOCK_ACQUIRE_FAILED', acquired.error.message);
  }

  async releaseWriter(token: string): Promise<HandoffResult<void>> {
    const released = await this.#writer.release(token);
    return released.ok
      ? { ok: true, value: undefined }
      : failure('HANDOFF_LOCK_RELEASE_FAILED', released.error.message);
  }
}
