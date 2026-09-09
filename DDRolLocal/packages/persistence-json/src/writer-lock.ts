import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { InternalWriterLock } from '@nyx/contracts';
import { err, ok, type Result } from '@nyx/domain';
import { canonicalJson, sha256 } from './canonical-json.js';
import { ensureDirectory, exists, writeDurable } from './durable-files.js';
import type { PersistenceError } from './types.js';
import { validateWriterLockSchema } from './validators.js';

export type WriterLockRecord = InternalWriterLock.WriterLockV1;
export type AcquireWriterLockInput = Omit<WriterLockRecord, 'schema_version' | 'lock_token'>;

export interface WriterLease {
  token: string;
  record: WriterLockRecord;
}

export interface WriterLockOptions {
  process_is_alive?: (pid: number) => boolean;
}

export interface RecoverOrphanInput {
  expected_checkpoint_id: string;
  expected_state_sha256: string;
  verify_checkpoint: () => Promise<boolean>;
}

function defaultProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class CampaignWriterLock {
  readonly #directory: string;
  readonly #file: string;
  readonly #processIsAlive: (pid: number) => boolean;

  constructor(campaignRoot: string, options: WriterLockOptions = {}) {
    this.#directory = path.join(path.resolve(campaignRoot), 'locks');
    this.#file = path.join(this.#directory, 'writer.lock.json');
    this.#processIsAlive = options.process_is_alive ?? defaultProcessIsAlive;
  }

  async #read(): Promise<Result<WriterLockRecord, PersistenceError>> {
    try {
      if (!(await exists(this.#file))) return err({ code: 'NOT_FOUND', message: 'No existe writer lock.' });
      const record = JSON.parse(await fs.readFile(this.#file, 'utf8')) as WriterLockRecord;
      const validation = validateWriterLockSchema(record);
      return validation.length === 0
        ? ok(record)
        : err({ code: 'CORRUPT_DATA', message: 'Writer lock inválido.', details: validation });
    } catch (error) {
      return err({ code: 'CORRUPT_DATA', message: 'No se pudo leer el writer lock.', details: [String(error)] });
    }
  }

  async acquire(input: AcquireWriterLockInput): Promise<Result<WriterLease, PersistenceError>> {
    const token = crypto.randomUUID();
    const record: WriterLockRecord = { ...input, schema_version: '1.0', lock_token: token };
    const validation = validateWriterLockSchema(record);
    if (validation.length > 0) return err({ code: 'INVALID_STATE', message: 'Writer lock inválido.', details: validation });
    try {
      await ensureDirectory(this.#directory);
      await writeDurable(this.#file, canonicalJson(record));
      return ok({ token, record });
    } catch (error) {
      const existing = await this.#read();
      if (existing.ok) return err({ code: 'LOCK_HELD', message: `La campaña ya está bloqueada por PID ${existing.value.pid}.` });
      return err({ code: 'IO_ERROR', message: 'No se pudo adquirir el writer lock.', details: [String(error)] });
    }
  }

  async release(token: string): Promise<Result<void, PersistenceError>> {
    const current = await this.#read();
    if (!current.ok) return current;
    if (current.value.lock_token !== token) return err({ code: 'LOCK_TOKEN_MISMATCH', message: 'El token no pertenece al writer activo.' });
    try {
      await fs.rm(this.#file);
      return ok(undefined);
    } catch (error) {
      return err({ code: 'IO_ERROR', message: 'No se pudo liberar el writer lock.', details: [String(error)] });
    }
  }

  async recoverOrphan(input: RecoverOrphanInput): Promise<Result<void, PersistenceError>> {
    const current = await this.#read();
    if (!current.ok) return current;
    if (this.#processIsAlive(current.value.pid)) {
      return err({ code: 'LOCK_OWNER_ALIVE', message: `El PID ${current.value.pid} sigue activo.` });
    }
    if (
      current.value.checkpoint_id !== input.expected_checkpoint_id ||
      current.value.state_sha256 !== input.expected_state_sha256 ||
      !(await input.verify_checkpoint())
    ) {
      return err({ code: 'LOCK_VERIFICATION_FAILED', message: 'Checkpoint o hash no permiten recuperar el lock huérfano.' });
    }
    try {
      const auditFile = path.join(this.#directory, `writer.recovered.${sha256(canonicalJson(current.value)).slice(0, 16)}.json`);
      await fs.rename(this.#file, auditFile);
      return ok(undefined);
    } catch (error) {
      return err({ code: 'IO_ERROR', message: 'No se pudo recuperar el writer lock huérfano.', details: [String(error)] });
    }
  }
}
