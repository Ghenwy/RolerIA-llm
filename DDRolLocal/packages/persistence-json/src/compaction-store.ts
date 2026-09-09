import fs from 'node:fs/promises';
import path from 'node:path';
import {
  validateRuntimeContract,
  type InternalCompactionCommitV12 as InternalCompactionCommit
} from '@nyx/contracts';
import {
  err,
  ok,
  validateHierarchicalMemory,
  type HierarchicalMemoryRecord,
  type Result
} from '@nyx/domain';
import { canonicalJson, sha256 } from './canonical-json.js';
import { ensureDirectory, exists, writeDurable } from './durable-files.js';
import {
  InjectedCompactionFault,
  type CompactionRecoverySummary,
  type JsonCompactionStoreOptions,
  type PersistenceError
} from './types.js';

type CompactionCommit = InternalCompactionCommit.CompactionCommitV1;

export interface PreparedCompactionCommit {
  readonly handle: string;
  readonly commit: CompactionCommit;
}

const commitFilePattern = /^\d{12}--COMPACTION-[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const preparedFilePattern = /^\d{12}--COMPACTION-[A-Za-z0-9][A-Za-z0-9._-]*\.json\.tmp$/;

function persistenceError(code: PersistenceError['code'], message: string, details?: string[]): PersistenceError {
  return details === undefined ? { code, message } : { code, message, details };
}

function asIoError(error: unknown, message: string): PersistenceError {
  return persistenceError('IO_ERROR', message, [String(error)]);
}

function commitFilename(commit: CompactionCommit): string {
  if (!/^COMPACTION-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(commit.commit_id)) {
    throw new TypeError(`Unsafe compaction commit_id: ${commit.commit_id}`);
  }
  return `${String(commit.sequence).padStart(12, '0')}--${commit.commit_id}.json`;
}

function contextHash(commit: CompactionCommit): string {
  const withoutHash = Object.fromEntries(
    Object.entries(commit.context_view).filter(([key]) => key !== 'context_sha256')
  );
  return sha256(canonicalJson(withoutHash));
}

function validateCommit(commit: CompactionCommit): string[] {
  const errors: string[] = [];
  const contract = validateRuntimeContract('CompactionCommit', commit);
  if (!contract.ok) return contract.errors.map(error => `commit${error}`);
  if (commit.schema_version !== '1.0') {
    const manifest = commit.validation_manifest;
    if (manifest.target_max_input_tokens !== Math.min(62000, (commit.source_input_tokens ?? 0) - 1)
      || manifest.candidate_input_tokens < 1 || manifest.candidate_input_tokens > manifest.target_max_input_tokens) {
      errors.push('validation_manifest:scene_token_reduction');
    }
  }
  for (const [index, memory] of commit.memory_records.entries()) {
    const memoryContract = validateRuntimeContract('MemoryRecord', memory);
    if (!memoryContract.ok) errors.push(...memoryContract.errors.map(error => `memory_records/${String(index)}${error}`));
    if (memoryContract.ok) {
      const semanticErrors = validateHierarchicalMemory(
        memory as unknown as HierarchicalMemoryRecord,
        value => sha256(canonicalJson(value))
      );
      errors.push(...semanticErrors.map(error => `memory_records/${String(index)}:${error}`));
    }
  }
  if (commit.context_view.context_sha256 !== contextHash(commit)) errors.push('context_view:context_sha256');
  if (commit.memory_index_sha256 !== sha256(canonicalJson(commit.memory_records))) {
    errors.push('memory_index_sha256');
  }
  return [...new Set(errors)].sort();
}

export class JsonCompactionStore {
  readonly #directory: string;
  readonly #branchId: string;
  readonly #options: JsonCompactionStoreOptions;

  constructor(campaignRoot: string, options: JsonCompactionStoreOptions = {}) {
    this.#branchId = options.branch_id ?? 'BRANCH-main';
    if (!/^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(this.#branchId)) {
      throw new TypeError(`Unsafe compaction branch_id: ${this.#branchId}`);
    }
    this.#directory = path.join(path.resolve(campaignRoot), 'memory', 'compactions', this.#branchId);
    this.#options = options;
  }

  async current(): Promise<Result<CompactionCommit | null, PersistenceError>> {
    try {
      await ensureDirectory(this.#directory);
      const files = (await fs.readdir(this.#directory))
        .filter(file => file.endsWith('.json'))
        .sort();
      if (files.length === 0) return ok(null);
      let previous: CompactionCommit | null = null;
      for (const [index, file] of files.entries()) {
        if (!commitFilePattern.test(file)) {
          return err(persistenceError('CORRUPT_DATA', `Nombre de commit de compactación inválido: ${file}.`));
        }
        const parsed = await this.#readCommit(file);
        if (!parsed.ok) return parsed;
        const expectedSequence = index + 1;
        if (
          parsed.value.sequence !== expectedSequence
          || parsed.value.previous_commit_id !== (previous?.commit_id ?? null)
          || file !== commitFilename(parsed.value)
        ) {
          return err(persistenceError('CORRUPT_DATA', `Linaje de compactación inválido en ${file}.`));
        }
        previous = parsed.value;
      }
      return ok(previous);
    } catch (error) {
      return err(asIoError(error, 'No se pudo leer el índice de compactación.'));
    }
  }

  async prepare(commit: CompactionCommit): Promise<Result<PreparedCompactionCommit, PersistenceError>> {
    try {
      await ensureDirectory(this.#directory);
      const errors = validateCommit(commit);
      if (errors.length > 0) {
        return err(persistenceError('INVALID_TRANSACTION', 'El commit de compactación no es válido.', errors));
      }
      const current = await this.current();
      if (!current.ok) return current;
      if (
        commit.branch_id !== this.#branchId
        ||
        commit.sequence !== (current.value?.sequence ?? 0) + 1
        || commit.previous_commit_id !== (current.value?.commit_id ?? null)
      ) {
        return err(persistenceError('STALE_STATE', 'El commit de compactación no continúa la vista activa.'));
      }
      const finalName = commitFilename(commit);
      const finalFile = path.join(this.#directory, finalName);
      const preparedName = `${finalName}.tmp`;
      const preparedFile = path.join(this.#directory, preparedName);
      if (await exists(finalFile)) {
        const existing = await this.#readCommit(finalName);
        return existing.ok && canonicalJson(existing.value) === canonicalJson(commit)
          ? ok({ handle: finalName, commit: structuredClone(commit) })
          : err(persistenceError('RECORD_ID_CONFLICT', `Ya existe otro commit ${commit.commit_id}.`));
      }
      await writeDurable(preparedFile, canonicalJson(commit));
      this.#options.fault_injector?.('AFTER_PREPARED');
      return ok({ handle: preparedName, commit: structuredClone(commit) });
    } catch (error) {
      if (error instanceof InjectedCompactionFault) throw error;
      return err(asIoError(error, 'No se pudo preparar el commit de compactación.'));
    }
  }

  async activate(prepared: PreparedCompactionCommit): Promise<Result<CompactionCommit, PersistenceError>> {
    try {
      if (commitFilePattern.test(prepared.handle)) {
        const current = await this.#readCommit(prepared.handle);
        return current.ok && canonicalJson(current.value) === canonicalJson(prepared.commit)
          ? current
          : err(persistenceError('RECORD_ID_CONFLICT', 'El commit ya activado no coincide con el preparado.'));
      }
      if (!preparedFilePattern.test(prepared.handle)) {
        return err(persistenceError('INVALID_TRANSACTION', 'Handle de compactación inseguro.'));
      }
      const preparedFile = path.join(this.#directory, prepared.handle);
      const finalName = prepared.handle.slice(0, -'.tmp'.length);
      const finalFile = path.join(this.#directory, finalName);
      const persisted = await this.#readCommit(prepared.handle);
      if (!persisted.ok) return persisted;
      if (canonicalJson(persisted.value) !== canonicalJson(prepared.commit)) {
        return err(persistenceError('CANDIDATE_HASH_MISMATCH', 'El commit preparado cambió antes de activarse.'));
      }
      await fs.rename(preparedFile, finalFile);
      this.#options.fault_injector?.('AFTER_ACTIVATED');
      return ok(structuredClone(prepared.commit));
    } catch (error) {
      if (error instanceof InjectedCompactionFault) throw error;
      return err(asIoError(error, 'No se pudo activar el commit de compactación.'));
    }
  }

  async abort(prepared: PreparedCompactionCommit): Promise<Result<void, PersistenceError>> {
    try {
      if (preparedFilePattern.test(prepared.handle)) {
        await fs.rm(path.join(this.#directory, prepared.handle), { force: true });
      }
      return ok(undefined);
    } catch (error) {
      return err(asIoError(error, 'No se pudo descartar el commit preparado.'));
    }
  }

  async recover(): Promise<Result<CompactionRecoverySummary, PersistenceError>> {
    try {
      await ensureDirectory(this.#directory);
      const removedTemporaries: string[] = [];
      for (const file of (await fs.readdir(this.#directory)).sort()) {
        if (!file.endsWith('.tmp')) continue;
        if (!preparedFilePattern.test(file)) {
          return err(persistenceError('CORRUPT_DATA', `Temporal de compactación inválido: ${file}.`));
        }
        await fs.rm(path.join(this.#directory, file));
        removedTemporaries.push(file);
      }
      const active = await this.current();
      if (!active.ok) return active;
      return ok({
        active_commit_id: active.value?.commit_id ?? null,
        removed_temporaries: removedTemporaries
      });
    } catch (error) {
      return err(asIoError(error, 'No se pudo recuperar el índice de compactación.'));
    }
  }

  async #readCommit(file: string): Promise<Result<CompactionCommit, PersistenceError>> {
    if (!commitFilePattern.test(file) && !preparedFilePattern.test(file)) {
      return err(persistenceError('CORRUPT_DATA', `Ruta de compactación insegura: ${file}.`));
    }
    try {
      const text = await fs.readFile(path.join(this.#directory, file), 'utf8');
      let value: CompactionCommit;
      try {
        value = JSON.parse(text) as CompactionCommit;
      } catch {
        return err(persistenceError('CORRUPT_DATA', `Commit de compactación con JSON inválido: ${file}.`));
      }
      const errors = validateCommit(value);
      return errors.length === 0
        ? ok(value)
        : err(persistenceError('CORRUPT_DATA', `Commit de compactación corrupto: ${file}.`, errors));
    } catch (error) {
      return err(asIoError(error, `No se pudo leer el commit de compactación ${file}.`));
    }
  }
}
