import {
  validateRuntimeContract,
  type InternalCompactionCommitV12 as InternalCompactionCommit,
  type SotCompactionProposal
} from '@nyx/contracts';
import {
  canonicalJson,
  validateHierarchicalMemory,
  type HierarchicalMemoryRecord
} from '@nyx/domain';
import {
  classifyContextPressure,
  CONTEXT_PRESSURE_LIMITS,
  type ContextPressureDecision
} from './context-pressure.js';

export interface CompactionError {
  readonly code: string;
  readonly message: string;
  readonly details?: readonly string[];
}

export type CompactionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CompactionError };

export interface CompactionSourceSnapshot {
  readonly campaign_id: string;
  readonly branch_id: string;
  readonly base_state_version: number;
  readonly source_context_sha256: string;
  /** Snapshot of the predecessor; absent means there was no active compaction. Not the hash of the GM packet. */
  readonly active_compaction_commit_id?: string | null;
  readonly pc_sheet_fingerprints: Readonly<Record<string, string>>;
  readonly relevant_npc_sheet_fingerprints: Readonly<Record<string, string>>;
  readonly party_inventory_fingerprints: Readonly<Record<string, string>>;
  readonly character_inventory_fingerprints: Readonly<Record<string, string>>;
  readonly quest_fingerprints: Readonly<Record<string, string>>;
  readonly canon_sha256: string;
  readonly knowledge_sha256: string;
  readonly expected_exact_refs: readonly string[];
  readonly source_turn_ids: readonly string[];
  readonly source_event_ids: readonly string[];
  readonly open_thread_ids: readonly string[];
  readonly recent_transcript: readonly {
    readonly turn: number;
    readonly ref: string;
  }[];
}

export interface CompactionRunInput {
  readonly trigger?: 'TEST_SCENE_CLOSE' | 'RUNTIME_CONTINUITY';
  readonly input_tokens: number;
  readonly source: CompactionSourceSnapshot;
  readonly memories: readonly HierarchicalMemoryRecord[];
  readonly now: string;
}

export interface CompactionProposalPort {
  create(input: {
    readonly source: CompactionSourceSnapshot;
    readonly memories: readonly HierarchicalMemoryRecord[];
    readonly pressure: ContextPressureDecision;
  }): Promise<CompactionResult<unknown>>;
}

export interface CompactionCanonValidatorPort {
  validate(
    proposal: SotCompactionProposal.CompactionProposal,
    source: CompactionSourceSnapshot
  ): Promise<CompactionResult<void>>;
}

export interface CompactionCheckpointPort {
  create(input: {
    readonly phase: 'PRE' | 'POST';
    readonly campaign_id: string;
    readonly branch_id: string;
    readonly base_state_version: number;
    readonly proposal_id?: string;
    readonly memory_index_sha256?: string;
  }): Promise<CompactionResult<{ readonly checkpoint_id: string }>>;
  restore(checkpointId: string): Promise<CompactionResult<void>>;
}

export interface CompactionCandidateContext {
  readonly context_view: InternalCompactionCommit.ContextView;
  readonly memory_records: readonly HierarchicalMemoryRecord[];
}

export interface CompactionTokenCounterPort {
  count(candidate: CompactionCandidateContext): Promise<CompactionResult<number>>;
}

export interface CompactionPreparedCommit {
  readonly handle: string;
  readonly commit: InternalCompactionCommit.CompactionCommitV1;
}

export interface CompactionCommitStorePort {
  current(): Promise<CompactionResult<InternalCompactionCommit.CompactionCommitV1 | null>>;
  prepare(commit: InternalCompactionCommit.CompactionCommitV1): Promise<CompactionResult<CompactionPreparedCommit>>;
  activate(prepared: CompactionPreparedCommit): Promise<CompactionResult<InternalCompactionCommit.CompactionCommitV1>>;
  abort(prepared: CompactionPreparedCommit): Promise<CompactionResult<void>>;
}

export interface CompactionCoordinatorDependencies {
  readonly proposal: CompactionProposalPort;
  readonly canon: CompactionCanonValidatorPort;
  readonly checkpoints: CompactionCheckpointPort;
  readonly store: CompactionCommitStorePort;
  readonly tokens: CompactionTokenCounterPort;
  readonly hashCanonical: (value: unknown) => string;
}

export type CompactionRunOutcome =
  | { readonly status: 'SKIPPED'; readonly pressure: ContextPressureDecision }
  | {
    readonly status: 'PREPARED';
    readonly pressure: ContextPressureDecision;
    readonly validation_manifest: InternalCompactionCommit.ValidationManifest;
    readonly context_view: InternalCompactionCommit.ContextView;
  }
  | {
    readonly status: 'COMMITTED';
    readonly pressure: ContextPressureDecision;
    readonly commit: InternalCompactionCommit.CompactionCommitV1;
  };

interface ValidatedCandidate {
  readonly proposal: SotCompactionProposal.CompactionProposal;
  readonly validationManifest: InternalCompactionCommit.ValidationManifest;
  readonly contextView: InternalCompactionCommit.ContextView;
  readonly memoryIndexSha256: string;
}

function failure(code: string, message: string, details?: readonly string[]): CompactionResult<never> {
  return details === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, details } };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function hasEvery(actual: readonly string[], expected: readonly string[]): boolean {
  const actualSet = new Set(actual);
  return expected.every(value => actualSet.has(value));
}

function objectIds(value: Readonly<Record<string, string>>): string[] {
  return uniqueSorted(Object.keys(value));
}

function turnRanges(value: readonly Record<string, unknown>[]): Array<{ from: number; to: number }> | null {
  const ranges: Array<{ from: number; to: number }> = [];
  for (const item of value) {
    const from = item['from_turn'];
    const to = item['to_turn'];
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || Number(to) < Number(from)) return null;
    ranges.push({ from: Number(from), to: Number(to) });
  }
  return ranges.sort((left, right) => left.from - right.from || left.to - right.to);
}

function coversRange(
  ranges: readonly { readonly from: number; readonly to: number }[],
  required: { readonly from_turn: number; readonly to_turn: number }
): boolean {
  let cursor = required.from_turn;
  for (const range of ranges) {
    if (range.to < cursor) continue;
    if (range.from > cursor) return false;
    cursor = Math.max(cursor, range.to + 1);
    if (cursor > required.to_turn) return true;
  }
  return cursor > required.to_turn;
}

function turnIsCovered(turn: number, ranges: readonly { readonly from: number; readonly to: number }[]): boolean {
  return ranges.some(range => turn >= range.from && turn <= range.to);
}

function openThreadIds(openThreads: readonly Record<string, unknown>[]): string[] | null {
  const ids: string[] = [];
  for (const thread of openThreads) {
    const value = thread['thread_id'] ?? thread['id'];
    if (typeof value !== 'string' || value.length === 0) return null;
    ids.push(value);
  }
  return uniqueSorted(ids);
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

export class CompactionCoordinator {
  readonly #dependencies: CompactionCoordinatorDependencies;

  constructor(dependencies: CompactionCoordinatorDependencies) {
    this.#dependencies = dependencies;
  }

  async run(input: CompactionRunInput): Promise<CompactionResult<CompactionRunOutcome>> {
    let pressure: ContextPressureDecision;
    try {
      pressure = classifyContextPressure(input.input_tokens);
    } catch (error) {
      return failure('INVALID_TOKEN_COUNT', 'El contador de tokens no es válido.', [String(error)]);
    }
    const shortScene = input.trigger === 'TEST_SCENE_CLOSE';
    const continuity = input.trigger === 'RUNTIME_CONTINUITY';
    if (input.trigger !== undefined && !shortScene && !continuity) return failure('INVALID_COMPACTION_TRIGGER', 'Trigger desconocido.');
    if (continuity && input.input_tokens < 2) return failure('INVALID_COMPACTION_TRIGGER', 'Contexto insuficiente para reducir.');
    if (shortScene && (pressure.state !== 'GREEN' || input.input_tokens < 2)) {
      return failure('INVALID_COMPACTION_TRIGGER', 'La excepción sólo admite escenas cortas por debajo de 72K.');
    }
    if (pressure.state === 'GREEN' && !shortScene && !continuity) return { ok: true, value: { status: 'SKIPPED', pressure } };

    if (pressure.state === 'YELLOW' && !continuity) {
      const candidate = await this.#buildCandidate(input, pressure);
      return candidate.ok
        ? {
          ok: true,
          value: {
            status: 'PREPARED',
            pressure,
            validation_manifest: candidate.value.validationManifest,
            context_view: candidate.value.contextView
          }
        }
        : candidate;
    }

    const current = await this.#dependencies.store.current();
    if (!current.ok) return current;
    if (
      (current.value?.commit_id ?? null) !== (input.source.active_compaction_commit_id ?? null)
    ) {
      return failure(
        'COMPACTION_BASE_MISMATCH',
        'La vista activa cambió desde que se preparó la fuente de compactación.'
      );
    }

    // A new scene summary cannot silently replace earlier validated memory.
    if (current.value?.memory_records.some(previous => !input.memories.some(memory =>
      memory.memory_id === previous['memory_id'] && canonicalJson(memory) === canonicalJson(previous)
    ))) return failure('COMPACTION_MEMORY_LOSS', 'El candidato no conserva todas las memorias validadas anteriores.');

    const pre = await this.#dependencies.checkpoints.create({
      phase: 'PRE',
      campaign_id: input.source.campaign_id,
      branch_id: input.source.branch_id,
      base_state_version: input.source.base_state_version
    });
    if (!pre.ok) return pre;

    const candidate = await this.#buildCandidate(input, pressure);
    if (!candidate.ok) return this.#restore(pre.value.checkpoint_id, candidate.error);

    const post = await this.#dependencies.checkpoints.create({
      phase: 'POST',
      campaign_id: input.source.campaign_id,
      branch_id: input.source.branch_id,
      base_state_version: input.source.base_state_version,
      proposal_id: candidate.value.proposal.proposal_id,
      memory_index_sha256: candidate.value.memoryIndexSha256
    });
    if (!post.ok) return this.#restore(pre.value.checkpoint_id, post.error);

    const sequence = (current.value?.sequence ?? 0) + 1;
    const commitId = `COMPACTION-${this.#dependencies.hashCanonical({
      campaign_id: input.source.campaign_id,
      branch_id: input.source.branch_id,
      proposal_id: candidate.value.proposal.proposal_id,
      sequence
    }).slice(0, 24)}`;
    const memoryRecords = canonicalClone(input.memories);
    const commit: InternalCompactionCommit.CompactionCommitV1 = {
      schema_version: continuity ? '1.2' : shortScene ? '1.1' : '1.0',
      ...(input.trigger ? { compaction_trigger: input.trigger, source_input_tokens: input.input_tokens } : {}),
      commit_id: commitId,
      sequence,
      proposal_id: candidate.value.proposal.proposal_id,
      campaign_id: input.source.campaign_id,
      branch_id: input.source.branch_id,
      base_state_version: input.source.base_state_version,
      previous_commit_id: current.value?.commit_id ?? null,
      pre_checkpoint_id: pre.value.checkpoint_id,
      post_checkpoint_id: post.value.checkpoint_id,
      proposal_sha256: this.#dependencies.hashCanonical(candidate.value.proposal),
      memory_index_sha256: candidate.value.memoryIndexSha256,
      validation_manifest: candidate.value.validationManifest,
      context_view: candidate.value.contextView,
      memory_records: [memoryRecords[0]!, ...memoryRecords.slice(1)],
      committed_at: input.now
    };
    const commitValidation = validateRuntimeContract('CompactionCommit', commit);
    if (!commitValidation.ok) {
      return this.#restore(pre.value.checkpoint_id, {
        code: 'COMPACTION_COMMIT_INVALID',
        message: 'El commit de compactación no cumple su contrato interno.',
        details: commitValidation.errors
      });
    }

    const prepared = await this.#dependencies.store.prepare(commit);
    if (!prepared.ok) return this.#restore(pre.value.checkpoint_id, prepared.error);
    const activated = await this.#dependencies.store.activate(prepared.value);
    if (!activated.ok) {
      const aborted = await this.#dependencies.store.abort(prepared.value);
      const original = aborted.ok
        ? activated.error
        : {
          code: 'COMPACTION_ABORT_FAILED',
          message: 'Falló la activación y no pudo limpiarse el commit preparado.',
          details: [activated.error.code, aborted.error.code]
        };
      return this.#restore(pre.value.checkpoint_id, original);
    }
    return { ok: true, value: { status: 'COMMITTED', pressure, commit: activated.value } };
  }

  async #buildCandidate(
    input: CompactionRunInput,
    pressure: ContextPressureDecision
  ): Promise<CompactionResult<ValidatedCandidate>> {
    const proposed = await this.#dependencies.proposal.create({
      source: input.source,
      memories: input.memories,
      pressure
    });
    if (!proposed.ok) return proposed;
    const contract = validateRuntimeContract('CompactionProposal', proposed.value);
    if (!contract.ok) {
      return failure(
        'COMPACTION_VALIDATION_FAILED',
        'La propuesta no cumple el schema protegido.',
        contract.errors
      );
    }
    const proposal = proposed.value as SotCompactionProposal.CompactionProposal;
    const validation = this.#validateProposal(proposal, input);
    if (!validation.ok) return validation;
    const canon = await this.#dependencies.canon.validate(proposal, input.source);
    if (!canon.ok) return canon;

    const ranges = turnRanges(proposal.safe_to_evict.turn_ranges);
    if (ranges === null) {
      return failure('COMPACTION_VALIDATION_FAILED', 'Los rangos de turnos no son válidos.');
    }
    const contextWithoutHash = {
      schema_version: '1.0' as const,
      campaign_id: input.source.campaign_id,
      branch_id: input.source.branch_id,
      base_state_version: input.source.base_state_version,
      source_context_sha256: input.source.source_context_sha256,
      source_turn_range: canonicalClone(proposal.source_turn_range),
      retrieved_memory_ids: uniqueSorted(input.memories.map(memory => memory.memory_id)),
      recent_transcript_refs: uniqueSorted(input.source.recent_transcript
        .filter(entry => !turnIsCovered(entry.turn, ranges))
        .map(entry => entry.ref)),
      open_threads: canonicalClone(proposal.open_threads),
      preserved_exact_refs: uniqueSorted(proposal.preserved_exact_refs)
    };
    const contextView: InternalCompactionCommit.ContextView = {
      ...contextWithoutHash,
      context_sha256: this.#dependencies.hashCanonical(contextWithoutHash)
    };
    const counted = await this.#dependencies.tokens.count({
      context_view: contextView,
      memory_records: canonicalClone(input.memories)
    });
    if (!counted.ok) return counted;
    const targetMin = input.trigger !== undefined ? 1 : CONTEXT_PRESSURE_LIMITS.targetMin;
    const targetMax = input.trigger !== undefined
      ? Math.min(CONTEXT_PRESSURE_LIMITS.targetMax, input.input_tokens - 1) : CONTEXT_PRESSURE_LIMITS.targetMax;
    if (
      !Number.isSafeInteger(counted.value)
      || counted.value < targetMin
      || counted.value > targetMax
    ) {
      return failure(
        'COMPACTION_TARGET_MISSED',
        `La vista candidata contiene ${String(counted.value)} tokens; debe quedar entre ${String(targetMin)} y ${String(targetMax)}.`
      );
    }
    const validationManifest: InternalCompactionCommit.ValidationManifest = {
      ...validation.value,
      candidate_input_tokens: counted.value,
      target_min_input_tokens: targetMin,
      target_max_input_tokens: targetMax
    };
    return {
      ok: true,
      value: {
        proposal,
        validationManifest,
        contextView,
        memoryIndexSha256: this.#dependencies.hashCanonical(input.memories)
      }
    };
  }

  #validateProposal(
    proposal: SotCompactionProposal.CompactionProposal,
    input: CompactionRunInput
  ): CompactionResult<Omit<InternalCompactionCommit.ValidationManifest,
    'candidate_input_tokens' | 'target_min_input_tokens' | 'target_max_input_tokens'>> {
    const source = input.source;
    const issues: string[] = [];
    if (proposal.campaign_id !== source.campaign_id) issues.push('campaign_id');
    if (proposal.base_state_version !== source.base_state_version) issues.push('base_state_version');
    if (proposal.source_turn_range.from_turn > proposal.source_turn_range.to_turn) issues.push('source_turn_range');
    if (proposal.state_patch_proposals.length !== 0) issues.push('state_patch_proposals');
    if (!proposal.safe_to_evict.allowed) issues.push('safe_to_evict.allowed');

    const ranges = turnRanges(proposal.safe_to_evict.turn_ranges);
    if (ranges === null || !coversRange(ranges, proposal.source_turn_range)
      || ranges.some(range => range.from < proposal.source_turn_range.from_turn
        || range.to > proposal.source_turn_range.to_turn)) issues.push('safe_to_evict.turn_ranges');

    const pcIds = objectIds(source.pc_sheet_fingerprints);
    const npcIds = objectIds(source.relevant_npc_sheet_fingerprints);
    const partyInventoryIds = objectIds(source.party_inventory_fingerprints);
    const characterInventoryIds = objectIds(source.character_inventory_fingerprints);
    const questIds = objectIds(source.quest_fingerprints);
    if (!hasEvery(proposal.validation_manifest.character_sheets_checked, [...pcIds, ...npcIds])) {
      issues.push('validation_manifest.character_sheets_checked');
    }
    if (!hasEvery(proposal.validation_manifest.inventories_checked, [...partyInventoryIds, ...characterInventoryIds])) {
      issues.push('validation_manifest.inventories_checked');
    }
    if (!hasEvery(proposal.validation_manifest.quests_checked, questIds)) issues.push('validation_manifest.quests_checked');
    if (!proposal.validation_manifest.canon_checked) issues.push('validation_manifest.canon_checked');
    if (!proposal.validation_manifest.knowledge_boundaries_checked) issues.push('validation_manifest.knowledge_boundaries_checked');
    if (proposal.validation_manifest.unresolved_discrepancies.length !== 0) {
      issues.push('validation_manifest.unresolved_discrepancies');
    }

    const requiredExactRefs = uniqueSorted([
      ...source.expected_exact_refs,
      ...source.source_event_ids.map(eventId => `event:${eventId}`)
    ]);
    if (!hasEvery(proposal.preserved_exact_refs, requiredExactRefs)) issues.push('preserved_exact_refs');
    const threadIds = openThreadIds(proposal.open_threads);
    if (threadIds === null || !hasEvery(threadIds, source.open_thread_ids)) issues.push('open_threads');

    const memoryIds = new Set<string>();
    const coveredTurnIds = new Set<string>();
    const coveredEventIds = new Set<string>();
    for (const memory of input.memories) {
      const contract = validateRuntimeContract('MemoryRecord', memory);
      if (!contract.ok) issues.push(`memory:${memory.memory_id}:schema`);
      const domainErrors = validateHierarchicalMemory(memory, this.#dependencies.hashCanonical);
      if (domainErrors.length > 0) issues.push(...domainErrors.map(error => `${memory.memory_id}:${error}`));
      if (
        memory.campaign_id !== source.campaign_id
        || memory.branch_id !== source.branch_id
        || memory.updated_state_version > source.base_state_version
      ) issues.push(`memory:${memory.memory_id}:scope`);
      if (memoryIds.has(memory.memory_id)) issues.push(`memory:${memory.memory_id}:duplicate`);
      memoryIds.add(memory.memory_id);
      for (const turnId of memory.content.provenance.source_turn_ids) coveredTurnIds.add(turnId);
      for (const eventId of memory.content.provenance.source_event_ids) coveredEventIds.add(eventId);
    }
    if (input.memories.length === 0) issues.push('memory_records');
    if (!source.source_turn_ids.every(turnId => coveredTurnIds.has(turnId))) {
      issues.push('memory:source_turn_coverage');
    }
    if (!source.source_event_ids.every(eventId => coveredEventIds.has(eventId))) {
      issues.push('memory:source_event_coverage');
    }

    if (issues.length > 0) {
      return failure(
        'COMPACTION_VALIDATION_FAILED',
        'La propuesta no demuestra cobertura completa y segura.',
        uniqueSorted(issues)
      );
    }
    return {
      ok: true,
      value: {
        pc_sheet_fingerprints: canonicalClone(source.pc_sheet_fingerprints),
        relevant_npc_sheet_fingerprints: canonicalClone(source.relevant_npc_sheet_fingerprints),
        party_inventory_fingerprints: canonicalClone(source.party_inventory_fingerprints),
        character_inventory_fingerprints: canonicalClone(source.character_inventory_fingerprints),
        quest_fingerprints: canonicalClone(source.quest_fingerprints),
        canon_sha256: source.canon_sha256,
        knowledge_sha256: source.knowledge_sha256,
        pc_sheet_ids_checked: pcIds,
        relevant_npc_sheet_ids_checked: npcIds,
        party_inventory_ids_checked: partyInventoryIds,
        character_inventory_ids_checked: characterInventoryIds,
        quest_ids_checked: questIds,
        canon_checked: true,
        knowledge_boundaries_checked: true,
        open_threads_checked: true,
        source_turn_ids_checked: uniqueSorted(source.source_turn_ids),
        source_event_ids_checked: uniqueSorted(source.source_event_ids),
        source_event_range_covered: true,
        exact_refs_checked: requiredExactRefs,
        unresolved_discrepancies: [],
        safe_to_evict_allowed: true
      }
    };
  }

  async #restore(checkpointId: string, original: CompactionError): Promise<CompactionResult<never>> {
    const restored = await this.#dependencies.checkpoints.restore(checkpointId);
    if (restored.ok) return { ok: false, error: original };
    return failure(
      'COMPACTION_ROLLBACK_FAILED',
      'La compactación falló y no pudo restaurarse el checkpoint PRE.',
      [original.code, restored.error.code]
    );
  }
}
