import fs from 'node:fs/promises';
import path from 'node:path';
import {
  err,
  ok,
  replayEvents,
  validateCampaignInvariants,
  type AtomicEvent,
  type CampaignState,
  type Result
} from '@nyx/domain';
import { canonicalJson, sha256 } from './canonical-json.js';
import { ensureDirectory, exists, replaceDurable, writeDurable } from './durable-files.js';
import { JsonEventStore } from './event-store.js';
import type {
  JsonCampaignStoreOptions,
  PersistenceError,
  RecoverySummary,
  TransactionFaultPoint
} from './types.js';
import { validateEventSchema, validateJournalSchema, validateStateSchema } from './validators.js';

interface CommitInput {
  transaction_id: string;
  base_state: CampaignState;
  candidate_state: CampaignState;
  events: [AtomicEvent, ...AtomicEvent[]];
}

interface TransactionJournal {
  schema_version: '1.0' | '1.1';
  transaction_id: string;
  campaign_id: string;
  branch_id: string;
  base_state_version: number;
  target_state_version: number;
  stage: 'PREPARED' | 'STATE_RENAMED' | 'EVENTS_APPENDED' | 'COMMITTED';
  state_temp_path: string;
  state_final_path: string;
  state_sha256: string;
  event_ids: [string, ...string[]];
  event_batch_sha256: string;
  created_at: string;
  updated_at: string;
}

const stageOrder: Record<TransactionJournal['stage'], number> = {
  PREPARED: 0,
  STATE_RENAMED: 1,
  EVENTS_APPENDED: 2,
  COMMITTED: 3
};

function asPersistenceError(error: unknown, message: string): PersistenceError {
  return { code: 'IO_ERROR', message, details: [String(error)] };
}

function safeId(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) throw new Error(`Unsafe ${label}: ${value}`);
  return value;
}

export class JsonCampaignStore {
  readonly events: JsonEventStore;
  readonly #root: string;
  readonly #stateDirectory: string;
  readonly #transactionDirectory: string;
  readonly #options: JsonCampaignStoreOptions;

  constructor(campaignRoot: string, options: JsonCampaignStoreOptions = {}) {
    this.#root = path.resolve(campaignRoot);
    this.#stateDirectory = path.join(this.#root, 'state');
    this.#transactionDirectory = path.join(this.#root, 'transactions');
    this.#options = options;
    this.events = new JsonEventStore(this.#root);
  }

  #stateRelative(branchId: string, version: number): string {
    safeId(branchId, /^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$/, 'branch_id');
    return `state/${branchId}.${String(version).padStart(12, '0')}.json`;
  }

  #absolute(relativePath: string): string {
    const target = path.resolve(this.#root, relativePath);
    if (target !== this.#root && !target.startsWith(`${this.#root}${path.sep}`)) throw new Error(`Unsafe campaign path: ${relativePath}`);
    return target;
  }

  async #ensureLayout(): Promise<void> {
    await Promise.all([ensureDirectory(this.#stateDirectory), ensureDirectory(this.#transactionDirectory), this.events.initialize()]);
  }

  async initialize(state: CampaignState): Promise<Result<CampaignState, PersistenceError>> {
    const schemaErrors = [
      ...validateStateSchema(state),
      ...validateCampaignInvariants(state).map(error => `${error.path} ${error.message}`)
    ];
    if (schemaErrors.length > 0) return err({ code: 'INVALID_STATE', message: 'El estado inicial no cumple sus schemas.', details: schemaErrors });
    try {
      await this.#ensureLayout();
      const finalFile = this.#absolute(this.#stateRelative(state.branch_id, state.state_version));
      if (await exists(finalFile)) {
        const existing = await fs.readFile(finalFile, 'utf8');
        return canonicalJson(state) === existing ? ok(state) : err({ code: 'INVALID_STATE', message: 'Ya existe otra instantánea para esa versión.' });
      }
      await replaceDurable(`${finalFile}.tmp`, finalFile, canonicalJson(state));
      return ok(state);
    } catch (error) {
      return err(asPersistenceError(error, 'No se pudo inicializar la campaña.'));
    }
  }

  async #readLatest(branchId: string): Promise<Result<CampaignState, PersistenceError>> {
    try {
      await this.#ensureLayout();
      const prefix = `${safeId(branchId, /^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$/, 'branch_id')}.`;
      const files = (await fs.readdir(this.#stateDirectory))
        .filter(file => file.startsWith(prefix) && file.endsWith('.json'))
        .sort();
      const latest = files.at(-1);
      if (!latest) return err({ code: 'NOT_FOUND', message: `No existe estado para ${branchId}.` });
      const state = JSON.parse(await fs.readFile(path.join(this.#stateDirectory, latest), 'utf8')) as CampaignState;
      const schemaErrors = validateStateSchema(state);
      if (schemaErrors.length > 0) return err({ code: 'CORRUPT_DATA', message: 'La última instantánea no cumple sus schemas.', details: schemaErrors });
      return ok(state);
    } catch (error) {
      return err(asPersistenceError(error, 'No se pudo abrir el estado de campaña.'));
    }
  }

  async open(branchId: string): Promise<Result<CampaignState, PersistenceError>> {
    const recovery = await this.recover();
    if (!recovery.ok) return recovery;
    return this.#readLatest(branchId);
  }

  #fault(point: TransactionFaultPoint): void {
    this.#options.fault_injector?.(point);
  }

  #journalFile(transactionId: string, stage: TransactionJournal['stage']): string {
    safeId(transactionId, /^TX-[A-Za-z0-9][A-Za-z0-9._-]*$/, 'transaction_id');
    return path.join(this.#transactionDirectory, `${transactionId}.${String(stageOrder[stage]).padStart(2, '0')}-${stage}.journal.json`);
  }

  async #writeJournal(journal: TransactionJournal): Promise<void> {
    const errors = validateJournalSchema(journal);
    if (errors.length > 0) throw new Error(`Invalid transaction journal: ${errors.join('; ')}`);
    const finalFile = this.#journalFile(journal.transaction_id, journal.stage);
    await replaceDurable(`${finalFile}.tmp`, finalFile, canonicalJson(journal));
  }

  async commit(input: CommitInput): Promise<Result<CampaignState, PersistenceError>> {
    try {
      await this.#ensureLayout();
      safeId(input.transaction_id, /^TX-[A-Za-z0-9][A-Za-z0-9._-]*$/, 'transaction_id');
      const current = await this.#readLatest(input.base_state.branch_id);
      if (!current.ok) return current;

      const tail = await this.events.tail(input.base_state.branch_id);
      if (!tail.ok) return tail;
      const knownIds = new Set(tail.value.map(event => event.event_id));
      if (input.events.every(event => knownIds.has(event.event_id))) {
        return canonicalJson(current.value) === canonicalJson(input.candidate_state)
          ? ok(current.value)
          : err({ code: 'EVENT_ID_CONFLICT', message: 'El reintento usa eventos confirmados pero otro estado candidato.' });
      }

      if (canonicalJson(current.value) !== canonicalJson(input.base_state)) {
        return err({ code: 'STALE_STATE', message: 'El estado base ya no es el último confirmado.' });
      }
      for (const event of input.events) {
        const eventErrors = validateEventSchema(event);
        if (eventErrors.length > 0) return err({ code: 'INVALID_EVENT', message: `Evento ${event.event_id} inválido.`, details: eventErrors });
      }
      const evaluated = replayEvents(input.base_state, input.events);
      if (!evaluated.ok) return err({ code: 'INVALID_TRANSACTION', message: evaluated.error.message });
      if (canonicalJson(evaluated.value) !== canonicalJson(input.candidate_state)) {
        return err({ code: 'CANDIDATE_HASH_MISMATCH', message: 'El candidato no coincide con el replay de los eventos.' });
      }
      const stateErrors = [
        ...validateStateSchema(input.candidate_state),
        ...validateCampaignInvariants(input.candidate_state).map(error => `${error.path} ${error.message}`)
      ];
      if (stateErrors.length > 0) return err({ code: 'INVALID_STATE', message: 'El estado candidato no cumple sus schemas.', details: stateErrors });

      const stateText = canonicalJson(input.candidate_state);
      const eventText = input.events.map(canonicalJson).join('');
      const stateFinalRelative = this.#stateRelative(input.candidate_state.branch_id, input.candidate_state.state_version);
      const stateTempRelative = `state/${input.transaction_id}.state.tmp`;
      const eventTempRelative = `transactions/${input.transaction_id}.events.tmp`;
      const stateTemp = this.#absolute(stateTempRelative);
      const stateFinal = this.#absolute(stateFinalRelative);
      const eventTemp = this.#absolute(eventTempRelative);
      await writeDurable(stateTemp, stateText);
      await writeDurable(eventTemp, eventText);
      const now = new Date().toISOString();
      const journal: TransactionJournal = {
        schema_version: '1.1',
        transaction_id: input.transaction_id,
        campaign_id: input.base_state.campaign_id,
        branch_id: input.base_state.branch_id,
        base_state_version: input.base_state.state_version,
        target_state_version: input.candidate_state.state_version,
        stage: 'PREPARED',
        state_temp_path: stateTempRelative,
        state_final_path: stateFinalRelative,
        state_sha256: sha256(stateText),
        event_ids: input.events.map(event => event.event_id) as [string, ...string[]],
        event_batch_sha256: sha256(eventText),
        created_at: now,
        updated_at: now
      };
      await this.#writeJournal(journal);
      this.#fault('AFTER_PREPARED');

      await fs.rename(stateTemp, stateFinal);
      journal.stage = 'STATE_RENAMED';
      journal.updated_at = new Date().toISOString();
      await this.#writeJournal(journal);
      this.#fault('AFTER_STATE_RENAMED');

      const appended = await this.events.appendBatch(input.base_state.branch_id, input.events);
      if (!appended.ok) return appended;
      journal.stage = 'EVENTS_APPENDED';
      journal.updated_at = new Date().toISOString();
      await this.#writeJournal(journal);
      this.#fault('AFTER_EVENTS_APPENDED');

      journal.stage = 'COMMITTED';
      journal.updated_at = new Date().toISOString();
      await this.#writeJournal(journal);
      this.#fault('AFTER_COMMITTED');
      await this.#cleanupTransaction(input.transaction_id, journal);
      return ok(input.candidate_state);
    } catch (error) {
      if (error instanceof Error && error.name === 'InjectedTransactionFault') throw error;
      return err(asPersistenceError(error, 'Falló el commit transaccional.'));
    }
  }

  async #cleanupTransaction(transactionId: string, journal: TransactionJournal): Promise<string[]> {
    const removed: string[] = [];
    const candidates = [journal.state_temp_path, `transactions/${transactionId}.events.tmp`];
    for (const relative of candidates) {
      const file = this.#absolute(relative);
      if (await exists(file)) {
        await fs.rm(file);
        removed.push(relative);
      }
    }
    for (const file of await fs.readdir(this.#transactionDirectory)) {
      if (file.startsWith(`${transactionId}.`) && file.endsWith('.journal.json')) {
        await fs.rm(path.join(this.#transactionDirectory, file));
        removed.push(`transactions/${file}`);
      }
    }
    return removed;
  }

  async recover(): Promise<Result<RecoverySummary, PersistenceError>> {
    const summary: RecoverySummary = {
      completed_transactions: [],
      rolled_back_transactions: [],
      removed_temporaries: [],
      repaired_event_logs: []
    };
    try {
      await this.#ensureLayout();
      for (const file of (await fs.readdir(path.join(this.#root, 'events'))).filter(name => name.endsWith('.jsonl'))) {
        const branchId = file.slice(0, -'.jsonl'.length);
        const repaired = await this.events.repairTail(branchId);
        if (!repaired.ok) return repaired;
        if (repaired.value) summary.repaired_event_logs.push(`events/${file}`);
      }

      const journalFiles = (await fs.readdir(this.#transactionDirectory)).filter(file => file.endsWith('.journal.json'));
      const groups = new Map<string, TransactionJournal[]>();
      for (const file of journalFiles) {
        let journal: TransactionJournal;
        try {
          journal = JSON.parse(await fs.readFile(path.join(this.#transactionDirectory, file), 'utf8')) as TransactionJournal;
        } catch (error) {
          return err({ code: 'CORRUPT_DATA', message: `Journal ilegible: ${file}`, details: [String(error)] });
        }
        const validation = validateJournalSchema(journal);
        if (validation.length > 0) return err({ code: 'CORRUPT_DATA', message: `Journal inválido: ${file}`, details: validation });
        const list = groups.get(journal.transaction_id) ?? [];
        list.push(journal);
        groups.set(journal.transaction_id, list);
      }

      for (const [transactionId, journals] of groups) {
        const journal = journals.sort((left, right) => stageOrder[right.stage] - stageOrder[left.stage])[0];
        if (!journal) continue;
        const stateFinal = this.#absolute(journal.state_final_path);
        const finalExists = await exists(stateFinal);
        if (!finalExists && journal.stage === 'PREPARED') {
          summary.removed_temporaries.push(...(await this.#cleanupTransaction(transactionId, journal)));
          summary.rolled_back_transactions.push(transactionId);
          continue;
        }
        if (!finalExists) return err({ code: 'CORRUPT_DATA', message: `Falta el estado confirmado de ${transactionId}.` });
        const stateText = await fs.readFile(stateFinal, 'utf8');
        if (sha256(stateText) !== journal.state_sha256) return err({ code: 'CORRUPT_DATA', message: `Hash de estado inválido en ${transactionId}.` });
        const eventTemp = this.#absolute(`transactions/${transactionId}.events.tmp`);
        if (!(await exists(eventTemp))) return err({ code: 'CORRUPT_DATA', message: `Falta el lote recuperable de ${transactionId}.` });
        const eventText = await fs.readFile(eventTemp, 'utf8');
        if (sha256(eventText) !== journal.event_batch_sha256) return err({ code: 'CORRUPT_DATA', message: `Hash del lote inválido en ${transactionId}.` });
        const recoveredEvents = eventText
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line) as AtomicEvent);
        const appended = await this.events.appendBatch(journal.branch_id, recoveredEvents);
        if (!appended.ok) return appended;
        summary.removed_temporaries.push(...(await this.#cleanupTransaction(transactionId, journal)));
        summary.completed_transactions.push(transactionId);
      }

      for (const directory of [this.#stateDirectory, this.#transactionDirectory]) {
        for (const file of await fs.readdir(directory)) {
          if (!file.endsWith('.tmp')) continue;
          const absolute = path.join(directory, file);
          await fs.rm(absolute);
          summary.removed_temporaries.push(path.relative(this.#root, absolute).replaceAll('\\', '/'));
        }
      }
      return ok(summary);
    } catch (error) {
      return err(asPersistenceError(error, 'Falló la recuperación transaccional.'));
    }
  }
}
