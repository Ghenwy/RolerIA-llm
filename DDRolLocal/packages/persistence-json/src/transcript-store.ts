import fs from 'node:fs/promises';
import path from 'node:path';
import { err, ok, type Result } from '@nyx/domain';
import type { InternalTranscriptEntry } from '@nyx/contracts';
import { canonicalJson } from './canonical-json.js';
import { ensureDirectory, exists } from './durable-files.js';
import type { PersistenceError } from './types.js';
import { validateTranscriptSchema } from './validators.js';

export type TranscriptEntry = InternalTranscriptEntry.TranscriptEntryV1;

function safeBranch(branchId: string): string {
  if (!/^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(branchId)) throw new Error(`Unsafe branch id: ${branchId}`);
  return branchId;
}

export class JsonTranscriptStore {
  readonly #directory: string;

  constructor(campaignRoot: string) {
    this.#directory = path.join(path.resolve(campaignRoot), 'transcript');
  }

  #file(branchId: string): string {
    return path.join(this.#directory, `${safeBranch(branchId)}.jsonl`);
  }

  async tail(branchId: string): Promise<Result<TranscriptEntry[], PersistenceError>> {
    try {
      const file = this.#file(branchId);
      if (!(await exists(file))) return ok([]);
      const text = await fs.readFile(file, 'utf8');
      if (text.length > 0 && !text.endsWith('\n')) return err({ code: 'CORRUPT_DATA', message: 'El transcript contiene un tail parcial; no se trunca automáticamente.' });
      const entries: TranscriptEntry[] = [];
      for (const [index, line] of text.split('\n').entries()) {
        if (!line) continue;
        const entry = JSON.parse(line) as TranscriptEntry;
        const validation = validateTranscriptSchema(entry);
        if (validation.length > 0) return err({ code: 'CORRUPT_DATA', message: `Transcript inválido en línea ${index + 1}.`, details: validation });
        entries.push(entry);
      }
      return ok(entries);
    } catch (error) {
      return err({ code: 'IO_ERROR', message: 'No se pudo leer el transcript.', details: [String(error)] });
    }
  }

  async append(entry: TranscriptEntry): Promise<Result<void, PersistenceError>> {
    const validation = validateTranscriptSchema(entry);
    if (validation.length > 0) return err({ code: 'INVALID_EVENT', message: 'La entrada de transcript no cumple su schema.', details: validation });
    const current = await this.tail(entry.branch_id);
    if (!current.ok) return current;
    const existing = current.value.find(candidate => candidate.transcript_id === entry.transcript_id);
    if (existing) {
      return canonicalJson(existing) === canonicalJson(entry)
        ? ok(undefined)
        : err({ code: 'RECORD_ID_CONFLICT', message: `transcript_id ${entry.transcript_id} ya existe con otro contenido.` });
    }
    try {
      await ensureDirectory(this.#directory);
      const handle = await fs.open(this.#file(entry.branch_id), 'a');
      try {
        await handle.writeFile(canonicalJson(entry), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return ok(undefined);
    } catch (error) {
      return err({ code: 'IO_ERROR', message: 'No se pudo anexar al transcript.', details: [String(error)] });
    }
  }
}
