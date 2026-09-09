import type { InternalMemoryRecord } from '@nyx/contracts';
import { canonicalJson, compareCanonicalKeys } from '../canonical-json.js';
import { err, ok, type Result } from '../result.js';

export const MEMORY_CATEGORIES = {
  character_sheet: 'EXACT',
  inventory: 'EXACT',
  money: 'EXACT',
  hp: 'EXACT',
  xp: 'EXACT',
  condition: 'EXACT',
  spell_slot: 'EXACT',
  charge: 'EXACT',
  daily_use: 'EXACT',
  location: 'EXACT',
  campaign_time: 'EXACT',
  initiative: 'EXACT',
  quest_state: 'EXACT',
  ownership: 'EXACT',
  death: 'EXACT',
  permanent_injury: 'EXACT',
  promise: 'EXACT',
  contract: 'EXACT',
  clue: 'EXACT',
  password: 'EXACT',
  map: 'EXACT',
  prophecy: 'EXACT',
  ruling: 'EXACT',
  knowledge: 'EXACT',
  belief: 'EXACT',
  revealed_secret: 'EXACT',
  relationship: 'EXACT',
  faction_clock: 'EXACT',
  motivation: 'DURABLE',
  plan: 'DURABLE',
  emotional_change: 'DURABLE',
  debt: 'DURABLE',
  betrayal: 'DURABLE',
  alliance: 'DURABLE',
  significant_conversation: 'DURABLE',
  consequence: 'DURABLE',
  foreshadowing: 'DURABLE',
  demonstrated_player_preference: 'DURABLE',
  scene_summary: 'EPISODIC',
  travel_sequence: 'EPISODIC',
  tactic: 'EPISODIC',
  atmosphere: 'EPISODIC',
  minor_dialogue: 'EPISODIC',
  repetition: 'EVICTABLE',
  greeting: 'EVICTABLE',
  reformulation: 'EVICTABLE',
  duplicate_description: 'EVICTABLE',
  discarded_hypothesis: 'EVICTABLE',
  resolved_mechanical_prose: 'EVICTABLE'
} as const;

export const PROTECTED_MEMORY_SOURCE_KINDS = [
  'TRANSCRIPT',
  'EVENT_LOG',
  'CHARACTER_SHEET',
  'INVENTORY',
  'CANON',
  'CHECKPOINT'
] as const;

export type MemoryCategory = keyof typeof MEMORY_CATEGORIES;
export type MemoryRetentionClass = (typeof MEMORY_CATEGORIES)[MemoryCategory];
export type ProtectedMemorySourceKind = (typeof PROTECTED_MEMORY_SOURCE_KINDS)[number];
export type MemoryScopeLevel = 'SCENE' | 'SESSION' | 'ARC' | 'CAMPAIGN' | 'NPC';

export interface MemoryScope {
  readonly level: MemoryScopeLevel;
  readonly scope_id: string;
  readonly npc_id?: string;
}

export interface MemoryProvenanceInput {
  readonly source_turn_ids: readonly string[];
  readonly source_event_ids: readonly string[];
  readonly entities: readonly string[];
  readonly locations: readonly string[];
  readonly quests: readonly string[];
  readonly time_range: { readonly start: string; readonly end: string };
  readonly importance: number;
  readonly retrieval_keys: readonly string[];
  readonly confidence: number;
}

export interface MemoryProvenance {
  source_turn_ids: string[];
  source_event_ids: string[];
  entities: string[];
  locations: string[];
  quests: string[];
  time_range: { start: string; end: string };
  importance: number;
  retrieval_keys: string[];
  confidence: number;
  superseded_by: string | null;
}

export interface HierarchicalMemoryContentV1 {
  schema_version: '1.0';
  category: MemoryCategory;
  scope: MemoryScope;
  payload: Record<string, unknown>;
  provenance: MemoryProvenance;
}

export type HierarchicalMemoryRecord = Omit<InternalMemoryRecord.MemoryRecordV1, 'content'> & {
  content: HierarchicalMemoryContentV1;
};

export interface CreateHierarchicalMemoryInput {
  readonly memoryId: string;
  readonly campaignId: string;
  readonly branchId: string;
  readonly category: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly scope: MemoryScope;
  readonly provenance: MemoryProvenanceInput;
  readonly sourceRefs: readonly string[];
  readonly stateVersion: number;
}

export interface MemoryError {
  readonly code: string;
  readonly detail: string;
}

export type MemoryCanonicalHasher = (value: unknown) => string;

export interface MemoryRetentionEvidence {
  readonly validated_replacement: boolean;
  readonly regenerable_from_sources: boolean;
}

export interface MemoryRetentionDecision {
  readonly action:
    | 'RETAIN_SOURCE'
    | 'RETAIN_EXACT'
    | 'RETAIN_DURABLE'
    | 'RETAIN_EPISODIC'
    | 'REPLACE_ACTIVE_VIEW'
    | 'RETAIN_EVICTABLE'
    | 'EVICT_ACTIVE_VIEW';
  readonly summarization_allowed: boolean;
  readonly active_prompt_removal_allowed: boolean;
  readonly destructive_source_removal_allowed: false;
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCanonicalKeys);
}

function isProtectedSourceKind(value: string): value is ProtectedMemorySourceKind {
  return (PROTECTED_MEMORY_SOURCE_KINDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isHierarchicalMemoryContent(value: unknown): value is HierarchicalMemoryContentV1 {
  if (!isRecord(value) || value['schema_version'] !== '1.0' || typeof value['category'] !== 'string') return false;
  const scope = value['scope'];
  const payload = value['payload'];
  const provenance = value['provenance'];
  if (!isRecord(scope) || !isRecord(payload) || !isRecord(provenance)) return false;
  if (
    !['SCENE', 'SESSION', 'ARC', 'CAMPAIGN', 'NPC'].includes(String(scope['level']))
    || typeof scope['scope_id'] !== 'string'
    || (scope['npc_id'] !== undefined && typeof scope['npc_id'] !== 'string')
  ) return false;
  const timeRange = provenance['time_range'];
  return isStringArray(provenance['source_turn_ids'])
    && isStringArray(provenance['source_event_ids'])
    && isStringArray(provenance['entities'])
    && isStringArray(provenance['locations'])
    && isStringArray(provenance['quests'])
    && isRecord(timeRange)
    && typeof timeRange['start'] === 'string'
    && typeof timeRange['end'] === 'string'
    && typeof provenance['importance'] === 'number'
    && isStringArray(provenance['retrieval_keys'])
    && typeof provenance['confidence'] === 'number'
    && (provenance['superseded_by'] === null || typeof provenance['superseded_by'] === 'string');
}

export function memoryRetentionClass(
  category: string
): Result<MemoryRetentionClass, MemoryError> {
  const retention = MEMORY_CATEGORIES[category as MemoryCategory];
  return retention === undefined
    ? err({ code: 'MEMORY_CATEGORY_UNKNOWN', detail: category })
    : ok(retention);
}

export function evaluateMemoryRetention(
  recordOrSource: Pick<HierarchicalMemoryRecord, 'retention_class'> | ProtectedMemorySourceKind,
  evidence: MemoryRetentionEvidence = {
    validated_replacement: false,
    regenerable_from_sources: false
  }
): MemoryRetentionDecision {
  if (typeof recordOrSource === 'string') {
    if (!isProtectedSourceKind(recordOrSource)) throw new TypeError(`UNKNOWN_MEMORY_SOURCE:${recordOrSource}`);
    return {
      action: 'RETAIN_SOURCE',
      summarization_allowed: false,
      active_prompt_removal_allowed: false,
      destructive_source_removal_allowed: false
    };
  }
  switch (recordOrSource.retention_class) {
    case 'EXACT':
      return {
        action: 'RETAIN_EXACT',
        summarization_allowed: false,
        active_prompt_removal_allowed: false,
        destructive_source_removal_allowed: false
      };
    case 'DURABLE':
      return {
        action: 'RETAIN_DURABLE',
        summarization_allowed: true,
        active_prompt_removal_allowed: false,
        destructive_source_removal_allowed: false
      };
    case 'EPISODIC':
      return {
        action: evidence.validated_replacement ? 'REPLACE_ACTIVE_VIEW' : 'RETAIN_EPISODIC',
        summarization_allowed: true,
        active_prompt_removal_allowed: evidence.validated_replacement,
        destructive_source_removal_allowed: false
      };
    case 'EVICTABLE':
      return {
        action: evidence.regenerable_from_sources ? 'EVICT_ACTIVE_VIEW' : 'RETAIN_EVICTABLE',
        summarization_allowed: true,
        active_prompt_removal_allowed: evidence.regenerable_from_sources,
        destructive_source_removal_allowed: false
      };
  }
}

export function createHierarchicalMemory(
  input: CreateHierarchicalMemoryInput,
  hashCanonical: MemoryCanonicalHasher
): Result<HierarchicalMemoryRecord, MemoryError> {
  const retention = memoryRetentionClass(input.category);
  if (!retention.ok) return retention;
  const sourceRefs = uniqueSorted(input.sourceRefs);
  if (sourceRefs.length === 0) return err({ code: 'MEMORY_SOURCE_REFS_REQUIRED', detail: input.memoryId });
  const provenance: MemoryProvenance = {
    source_turn_ids: uniqueSorted(input.provenance.source_turn_ids),
    source_event_ids: uniqueSorted(input.provenance.source_event_ids),
    entities: uniqueSorted(input.provenance.entities),
    locations: uniqueSorted(input.provenance.locations),
    quests: uniqueSorted(input.provenance.quests),
    time_range: { ...input.provenance.time_range },
    importance: input.provenance.importance,
    retrieval_keys: uniqueSorted(input.provenance.retrieval_keys),
    confidence: input.provenance.confidence,
    superseded_by: null
  };
  let payload: Record<string, unknown>;
  let content: HierarchicalMemoryContentV1;
  try {
    payload = canonicalClone(input.payload);
    content = canonicalClone({
      schema_version: '1.0',
      category: input.category as MemoryCategory,
      scope: input.scope,
      payload,
      provenance
    });
  } catch (error) {
    return err({
      code: 'MEMORY_INVALID_JSON',
      detail: error instanceof Error ? error.message : input.memoryId
    });
  }
  let record: HierarchicalMemoryRecord;
  try {
    record = {
      schema_version: '1.0',
      memory_id: input.memoryId,
      campaign_id: input.campaignId,
      branch_id: input.branchId,
      retention_class: retention.value,
      content,
      source_refs: [sourceRefs[0]!, ...sourceRefs.slice(1)],
      created_state_version: input.stateVersion,
      updated_state_version: input.stateVersion,
      exact_payload_sha256: retention.value === 'EXACT' ? hashCanonical(payload) : null
    };
  } catch (error) {
    return err({
      code: 'MEMORY_HASH_UNAVAILABLE',
      detail: error instanceof Error ? error.message : input.memoryId
    });
  }
  const errors = validateHierarchicalMemory(record, hashCanonical);
  return errors.length === 0
    ? ok(record)
    : err({ code: 'MEMORY_INVALID', detail: errors.join(',') });
}

function isCanonicalSet(values: readonly string[]): boolean {
  return values.join('\u0000') === uniqueSorted(values).join('\u0000');
}

export function validateHierarchicalMemory(
  record: HierarchicalMemoryRecord,
  hashCanonical: MemoryCanonicalHasher
): string[] {
  const errors: string[] = [];
  if (!isRecord(record) || !isHierarchicalMemoryContent(record.content)) return ['memory:content_shape'];
  if (record.schema_version !== '1.0' || record.content.schema_version !== '1.0') errors.push('memory:schema_version');
  if (typeof record.memory_id !== 'string' || !/^MEMORY-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(record.memory_id)) {
    errors.push('memory:memory_id');
  }
  if (typeof record.campaign_id !== 'string' || !/^CAMPAIGN-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(record.campaign_id)) {
    errors.push('memory:campaign_id');
  }
  if (typeof record.branch_id !== 'string' || !/^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(record.branch_id)) {
    errors.push('memory:branch_id');
  }
  const retention = memoryRetentionClass(record.content.category);
  if (!retention.ok || retention.value !== record.retention_class) errors.push('memory:retention_class');
  if (!Number.isSafeInteger(record.created_state_version) || record.created_state_version < 0) {
    errors.push('memory:created_state_version');
  }
  if (
    !Number.isSafeInteger(record.updated_state_version)
    || record.updated_state_version < record.created_state_version
  ) {
    errors.push('memory:updated_state_version');
  }
  if (!isStringArray(record.source_refs) || record.source_refs.length === 0 || !isCanonicalSet(record.source_refs)) {
    errors.push('memory:source_refs');
  }
  const provenance = record.content.provenance;
  if (provenance.source_turn_ids.length === 0 && provenance.source_event_ids.length === 0) {
    errors.push('memory:source_lineage_required');
  }
  for (const values of [
    provenance.source_turn_ids,
    provenance.source_event_ids,
    provenance.entities,
    provenance.locations,
    provenance.quests,
    provenance.retrieval_keys
  ]) {
    if (!isCanonicalSet(values)) errors.push('memory:provenance_not_canonical');
  }
  if (provenance.retrieval_keys.length === 0) errors.push('memory:retrieval_keys_required');
  if (provenance.time_range.start.length === 0 || provenance.time_range.end.length === 0) {
    errors.push('memory:time_range');
  }
  if (!Number.isFinite(provenance.importance) || provenance.importance < 0 || provenance.importance > 1) {
    errors.push('memory:importance');
  }
  if (!Number.isFinite(provenance.confidence) || provenance.confidence < 0 || provenance.confidence > 1) {
    errors.push('memory:confidence');
  }
  if (record.content.scope.scope_id.length === 0) errors.push('memory:scope_id');
  if (record.content.scope.level === 'NPC') {
    if (
      record.content.scope.npc_id === undefined
      || record.content.scope.npc_id !== record.content.scope.scope_id
    ) {
      errors.push('memory:npc_scope');
    }
  } else if (record.content.scope.npc_id !== undefined) {
    errors.push('memory:npc_scope_on_non_npc');
  }
  if (record.retention_class === 'EXACT') {
    let payloadHash: string;
    try {
      payloadHash = hashCanonical(record.content.payload);
    } catch {
      errors.push('memory:exact_payload_hash_unavailable');
      payloadHash = '';
    }
    if (record.exact_payload_sha256 !== payloadHash) {
      errors.push('memory:exact_payload_hash_mismatch');
    }
  } else if (record.exact_payload_sha256 !== null) {
    errors.push('memory:unexpected_exact_payload_hash');
  }
  return [...new Set(errors)];
}

export interface MemoryRetrievalQuery {
  readonly retrieval_keys?: readonly string[];
  readonly scope?: MemoryScope;
  readonly include_superseded?: boolean;
}

function cloneRecord(record: HierarchicalMemoryRecord): HierarchicalMemoryRecord {
  return canonicalClone(record);
}

function containsAll(haystack: readonly string[], needles: readonly string[]): boolean {
  const available = new Set(haystack);
  return needles.every(needle => available.has(needle));
}

function hierarchyRank(level: Exclude<MemoryScopeLevel, 'NPC'>): number {
  return { SCENE: 0, SESSION: 1, ARC: 2, CAMPAIGN: 3 }[level];
}

function validSupersessionLevel(source: MemoryScope, replacement: MemoryScope): boolean {
  if (source.level === 'NPC' || replacement.level === 'NPC') {
    return source.level === 'NPC'
      && replacement.level === 'NPC'
      && source.npc_id === replacement.npc_id;
  }
  return hierarchyRank(replacement.level) >= hierarchyRank(source.level);
}

export class HierarchicalMemoryIndex {
  readonly #records = new Map<string, HierarchicalMemoryRecord>();
  readonly #hashCanonical: MemoryCanonicalHasher;

  constructor(
    records: readonly HierarchicalMemoryRecord[],
    hashCanonical: MemoryCanonicalHasher
  ) {
    this.#hashCanonical = hashCanonical;
    for (const record of records) {
      const errors = validateHierarchicalMemory(record, this.#hashCanonical);
      if (errors.length > 0) throw new TypeError(`MEMORY_INVALID:${errors.join(',')}`);
      if (this.#records.has(record.memory_id)) throw new TypeError(`MEMORY_DUPLICATE:${record.memory_id}`);
      this.#records.set(record.memory_id, cloneRecord(record));
    }
  }

  snapshot(options: { readonly include_superseded?: boolean } = {}): HierarchicalMemoryRecord[] {
    return [...this.#records.values()]
      .filter(record => options.include_superseded === true || record.content.provenance.superseded_by === null)
      .sort((left, right) => compareCanonicalKeys(left.memory_id, right.memory_id))
      .map(cloneRecord);
  }

  retrieve(query: MemoryRetrievalQuery): HierarchicalMemoryRecord[] {
    const keys = uniqueSorted(query.retrieval_keys ?? []);
    return this.snapshot(query.include_superseded === undefined
      ? {}
      : { include_superseded: query.include_superseded })
      .filter(record => keys.length === 0 || containsAll(record.content.provenance.retrieval_keys, keys))
      .filter(record => query.scope === undefined || (
        record.content.scope.level === query.scope.level
        && record.content.scope.scope_id === query.scope.scope_id
        && record.content.scope.npc_id === query.scope.npc_id
      ));
  }

  supersede(
    sourceMemoryIds: readonly string[],
    replacement: HierarchicalMemoryRecord
  ): Result<void, MemoryError> {
    const replacementErrors = validateHierarchicalMemory(replacement, this.#hashCanonical);
    if (replacementErrors.length > 0) {
      return err({ code: 'MEMORY_INVALID', detail: replacementErrors.join(',') });
    }
    if (this.#records.has(replacement.memory_id)) {
      return err({ code: 'MEMORY_DUPLICATE', detail: replacement.memory_id });
    }
    const sources: HierarchicalMemoryRecord[] = [];
    for (const sourceId of uniqueSorted(sourceMemoryIds)) {
      const source = this.#records.get(sourceId);
      if (source === undefined) return err({ code: 'MEMORY_SOURCE_MISSING', detail: sourceId });
      if (source.retention_class === 'EXACT') return err({ code: 'MEMORY_EXACT_NOT_SUPERSEDABLE', detail: sourceId });
      if (source.campaign_id !== replacement.campaign_id || source.branch_id !== replacement.branch_id) {
        return err({ code: 'MEMORY_SCOPE_MISMATCH', detail: sourceId });
      }
      if (!validSupersessionLevel(source.content.scope, replacement.content.scope)) {
        return err({ code: 'MEMORY_HIERARCHY_REGRESSION', detail: sourceId });
      }
      const sourceTrace = source.content.provenance;
      const replacementTrace = replacement.content.provenance;
      if (
        !containsAll(replacement.source_refs, source.source_refs)
        || !containsAll(replacementTrace.source_turn_ids, sourceTrace.source_turn_ids)
        || !containsAll(replacementTrace.source_event_ids, sourceTrace.source_event_ids)
      ) {
        return err({ code: 'MEMORY_PROVENANCE_GAP', detail: sourceId });
      }
      sources.push(source);
    }
    if (sources.length === 0) return err({ code: 'MEMORY_SOURCE_REQUIRED', detail: replacement.memory_id });
    this.#records.set(replacement.memory_id, cloneRecord(replacement));
    for (const source of sources) {
      const updated = cloneRecord(source);
      updated.content.provenance.superseded_by = replacement.memory_id;
      updated.updated_state_version = Math.max(updated.updated_state_version, replacement.updated_state_version);
      this.#records.set(updated.memory_id, updated);
    }
    return ok(undefined);
  }
}
