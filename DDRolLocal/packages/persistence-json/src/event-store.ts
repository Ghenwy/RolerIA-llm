import fs from 'node:fs/promises';
import path from 'node:path';
import { err, ok, type AtomicEvent, type Result } from '@nyx/domain';
import { canonicalJson } from './canonical-json.js';
import { ensureDirectory, exists } from './durable-files.js';
import type { PersistenceError } from './types.js';
import { validateEventSchema } from './validators.js';

function safeBranch(branchId: string): string {
  if (!/^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(branchId)) throw new Error(`Unsafe branch id: ${branchId}`);
  return branchId;
}

export class JsonEventStore {
  readonly #eventsDirectory: string;

  constructor(campaignRoot: string) {
    this.#eventsDirectory = path.join(campaignRoot, 'events');
  }

  fileFor(branchId: string): string {
    return path.join(this.#eventsDirectory, `${safeBranch(branchId)}.jsonl`);
  }

  async initialize(): Promise<void> {
    await ensureDirectory(this.#eventsDirectory);
  }

  async repairTail(branchId: string): Promise<Result<boolean, PersistenceError>> {
    try {
      const file = this.fileFor(branchId);
      if (!(await exists(file))) return ok(false);
      const bytes = await fs.readFile(file);
      if (bytes.length === 0 || bytes[bytes.length - 1] === 0x0a) return ok(false);
      const lastNewline = bytes.lastIndexOf(0x0a);
      await fs.truncate(file, lastNewline < 0 ? 0 : lastNewline + 1);
      return ok(true);
    } catch (error) {
      return err({ code: 'IO_ERROR', message: 'No se pudo reparar el tail del event log.', details: [String(error)] });
    }
  }

  async tail(branchId: string): Promise<Result<AtomicEvent[], PersistenceError>> {
    try {
      const repaired = await this.repairTail(branchId);
      if (!repaired.ok) return repaired;
      const file = this.fileFor(branchId);
      if (!(await exists(file))) return ok([]);
      const text = await fs.readFile(file, 'utf8');
      const events: AtomicEvent[] = [];
      for (const [index, line] of text.split('\n').entries()) {
        if (line.length === 0) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch (error) {
          return err({ code: 'CORRUPT_DATA', message: `JSON inválido en event log, línea ${index + 1}.`, details: [String(error)] });
        }
        const schemaErrors = validateEventSchema(value as AtomicEvent);
        if (schemaErrors.length > 0) return err({ code: 'CORRUPT_DATA', message: `Evento inválido en línea ${index + 1}.`, details: schemaErrors });
        events.push(value as AtomicEvent);
      }
      return ok(events);
    } catch (error) {
      return err({ code: 'IO_ERROR', message: 'No se pudo leer el event log.', details: [String(error)] });
    }
  }

  async appendBatch(branchId: string, events: readonly AtomicEvent[]): Promise<Result<void, PersistenceError>> {
    const current = await this.tail(branchId);
    if (!current.ok) return current;
    const byId = new Map(current.value.map(event => [event.event_id, event]));
    const pending: AtomicEvent[] = [];
    for (const event of events) {
      const schemaErrors = validateEventSchema(event);
      if (schemaErrors.length > 0) return err({ code: 'INVALID_EVENT', message: `Evento ${event.event_id} inválido.`, details: schemaErrors });
      const existing = byId.get(event.event_id);
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(event)) {
          return err({ code: 'EVENT_ID_CONFLICT', message: `event_id ${event.event_id} ya existe con otro contenido.` });
        }
        continue;
      }
      byId.set(event.event_id, event);
      pending.push(event);
    }
    if (pending.length === 0) return ok(undefined);
    try {
      await this.initialize();
      const handle = await fs.open(this.fileFor(branchId), 'a');
      try {
        await handle.writeFile(pending.map(canonicalJson).join(''), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return ok(undefined);
    } catch (error) {
      return err({ code: 'IO_ERROR', message: 'No se pudo anexar el lote de eventos.', details: [String(error)] });
    }
  }
}
