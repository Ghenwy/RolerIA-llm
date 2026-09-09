import crypto from 'node:crypto';
import type { DesignTurnEnvelope, SotRpgjobCard } from '@nyx/contracts';
import {
  canonicalJson,
  visibleKnowledgeForSubject,
  type CampaignState,
  type SubjectKnowledgeView
} from '@nyx/domain';

export const GM_CONTEXT_SECTION_ORDER = [
  'campaign_profile_language',
  'rules_mode_house_rules',
  'compact_core_canon',
  'pc_sheets',
  'party_inventory_summary_exact_refs',
  'current_scene_state',
  'present_npc_filtered_packets',
  'active_quests_open_threads',
  'retrieved_memories',
  'recent_raw_transcript',
  'current_player_message'
] as const;

export type GmContextSectionId = (typeof GM_CONTEXT_SECTION_ORDER)[number];

export interface C6ContextSection {
  readonly id: GmContextSectionId;
  readonly value: unknown;
}

export interface C6GmContextPacket {
  readonly schema_version: '1.0';
  readonly context_profile: 'c6-gm';
  readonly campaign_id: string;
  readonly branch_id: string;
  readonly state_version: number;
  readonly logical_session_id: string;
  readonly canonical_state_sha256: string;
  readonly context_sha256: string;
  readonly context_refs: readonly DesignTurnEnvelope.ContentRef[];
  readonly budget: {
    readonly target_min_input_tokens: 55_000;
    readonly target_max_input_tokens: 78_000;
    readonly max_input_tokens: 79_000;
  };
  readonly sections: readonly C6ContextSection[];
}

export interface C6GmContextBuildInput {
  readonly language: string;
  readonly rulesetId?: string;
  readonly rulesRegistry?: { readonly status: 'AVAILABLE' | 'UNAVAILABLE'; readonly rule_refs: readonly string[] };
  readonly playerMessage: string;
  /** Internal view selected from the validated campaign profile, never from player text. */
  readonly narrationScope?: 'PUBLIC_ALPHA';
  readonly presentNpcIds?: readonly string[];
  readonly scopedSecretIds?: readonly string[];
  readonly retrievedMemories?: readonly unknown[];
  readonly recentRawTranscript?: readonly unknown[];
  readonly activeOpenThreads?: readonly unknown[];
}

export interface C6ContextExpectation {
  readonly campaignId: string;
  readonly baseStateVersion: number;
}

export interface C6WorkerContextPacket {
  readonly schema_version: '1.0';
  readonly context_profile: 'c6-worker';
  readonly campaign_id: string;
  readonly branch_id: string;
  readonly base_state_version: number;
  readonly job_id: string;
  readonly worker_id: SotRpgjobCard.RPGJobCard['worker_id'];
  readonly ruleset_id: string | null;
  readonly resolved_rules: readonly unknown[];
  readonly canonical_state_sha256: string;
  readonly context_sha256: string;
  readonly authorized_subject_ids: readonly string[];
  readonly inputs: {
    readonly state_refs: readonly string[];
    readonly event_refs: readonly string[];
    readonly transcript_refs: readonly string[];
    readonly rules_refs: readonly string[];
    readonly facts: readonly string[];
  };
  readonly constraints: readonly string[];
  readonly subject_knowledge: Readonly<Record<string, SubjectKnowledgeView>>;
  readonly budget: { readonly max_input_tokens: number };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalStateSha256(state: CampaignState): string {
  return sha256(canonicalJson(state));
}

function stateRef(
  campaignId: string,
  branchId: string,
  stateVersion: number,
  stateSha256: string
): DesignTurnEnvelope.ContentRef {
  return {
    id: `state:${campaignId}:${branchId}:${String(stateVersion)}`,
    sha256: stateSha256
  };
}

function sceneSubjectIds(state: CampaignState): string[] {
  const ids: string[] = [];
  for (const field of ['present_npc_ids', 'nearby_npc_ids', 'present_character_ids', 'active_character_ids']) {
    const value = state.scene[field];
    if (Array.isArray(value)) {
      ids.push(...value.filter((candidate): candidate is string => typeof candidate === 'string'));
    }
  }
  return uniqueSorted(ids);
}

function sceneNpcIds(state: CampaignState): string[] {
  return sceneSubjectIds(state).filter(id => state.characters[id]?.kind === 'npc');
}

function partyInventory(state: CampaignState): Record<string, unknown> {
  const playerIds = new Set(
    Object.values(state.characters)
      .filter(character => character.kind === 'player')
      .map(character => character.character_id)
  );
  return Object.fromEntries(
    Object.entries(state.inventories)
      .filter(([, inventory]) => inventory.owner_type === 'party' || playerIds.has(inventory.owner_id))
      .sort(([left], [right]) => compareUtf16(left, right))
  );
}

function publicCharacterView(character: CampaignState['characters'][string]): CampaignState['characters'][string] {
  const sheet = Object.fromEntries(
    Object.entries(character.sheet)
      .filter(([field]) => field !== 'knowledge' && field !== 'beliefs' && field !== 'secrets')
  );
  return { ...character, sheet };
}

function publicSecretIds(state: CampaignState): ReadonlySet<string> {
  const audience = uniqueSorted([...sceneSubjectIds(state), ...Object.values(state.characters)
    .filter(character => character.kind === 'player').map(character => character.character_id)]);
  // A missing/unregistered subject is not permission to expose a secret. Public Alpha has no private-dialogue selection.
  if (audience.length === 0 || audience.some(id => !Object.hasOwn(state.characters, id))) return new Set();
  return new Set(Object.entries(state.canon.secrets)
    .filter(([, secret]) => audience.every(id => secret.authorized_subject_ids.includes(id)))
    .map(([id]) => id));
}

function publicKnowledgeView(view: SubjectKnowledgeView, allowed: ReadonlySet<string>): SubjectKnowledgeView {
  const filterLinked = (entries: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(
    Object.entries(entries).filter(([, value]) => {
      if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'secret_id')) return true;
      const secretId = (value as Record<string, unknown>)['secret_id'];
      return typeof secretId === 'string' && allowed.has(secretId);
    })
  );
  return {
    knowledge: filterLinked(view.knowledge), beliefs: filterLinked(view.beliefs), rumors: filterLinked(view.rumors),
    authorized_secrets: Object.fromEntries(Object.entries(view.authorized_secrets).filter(([id]) => allowed.has(id)))
  };
}

function scopedSecrets(state: CampaignState, secretIds: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    uniqueSorted(secretIds)
      .map(id => [id, state.canon.secrets[id]] as const)
      .filter((entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] => entry[1] !== undefined)
      .map(([id, secret]) => [id, secret.value])
  );
}

function gmSections(state: CampaignState, input: C6GmContextBuildInput): C6ContextSection[] {
  const publicScope = input.narrationScope === 'PUBLIC_ALPHA';
  const allowedSecrets = publicScope ? publicSecretIds(state) : undefined;
  const presentNpcIds = uniqueSorted(publicScope ? sceneNpcIds(state) : input.presentNpcIds ?? sceneNpcIds(state));
  const npcPackets = Object.fromEntries(
    presentNpcIds
      .map(id => [id, state.characters[id]] as const)
      .filter((entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] => entry[1]?.kind === 'npc')
      .map(([id, character]) => [id, {
        character: publicCharacterView(character),
        ...(allowedSecrets === undefined ? visibleKnowledgeForSubject(state, id)
          : publicKnowledgeView(visibleKnowledgeForSubject(state, id), allowedSecrets))
      }])
  );
  const playerSheets = Object.fromEntries(
    Object.entries(state.characters)
      .filter(([, character]) => character.kind === 'player')
      .map(([id, character]) => [id, publicScope ? publicCharacterView(character) : character] as const)
      .sort(([left], [right]) => compareUtf16(left, right))
  );
  const values: Record<GmContextSectionId, unknown> = {
    campaign_profile_language: {
      campaign_id: state.campaign_id,
      branch_id: state.branch_id,
      language: input.language
    },
    rules_mode_house_rules: { ruleset_id: input.rulesetId ?? null, rulings: state.canon.rulings,
      ...(input.rulesRegistry === undefined ? {} : { source_registry: input.rulesRegistry }) },
    compact_core_canon: {
      facts: state.canon.facts,
      scoped_secrets: scopedSecrets(state, (input.scopedSecretIds ?? [])
        .filter(id => allowedSecrets === undefined || allowedSecrets.has(id)))
    },
    pc_sheets: playerSheets,
    party_inventory_summary_exact_refs: partyInventory(state),
    current_scene_state: { world: state.world, scene: state.scene },
    present_npc_filtered_packets: npcPackets,
    active_quests_open_threads: input.activeOpenThreads === undefined
      ? state.quests
      : { quests: state.quests, open_threads: input.activeOpenThreads },
    retrieved_memories: input.retrievedMemories ?? [],
    recent_raw_transcript: input.recentRawTranscript ?? [],
    current_player_message: input.playerMessage
  };
  return GM_CONTEXT_SECTION_ORDER.map(id => ({ id, value: canonicalClone(values[id]) }));
}

export function buildC6GmContextPacket(
  state: CampaignState,
  input: C6GmContextBuildInput
): C6GmContextPacket {
  const stateSha256 = canonicalStateSha256(state);
  const logicalSessionId = `gm:${state.campaign_id}:${state.branch_id}`;
  const budget = {
    target_min_input_tokens: 55_000,
    target_max_input_tokens: 78_000,
    max_input_tokens: 79_000
  } as const;
  const sections = gmSections(state, input);
  const contextSha256 = sha256(canonicalJson({ logical_session_id: logicalSessionId, budget, sections }));
  return {
    schema_version: '1.0',
    context_profile: 'c6-gm',
    campaign_id: state.campaign_id,
    branch_id: state.branch_id,
    state_version: state.state_version,
    logical_session_id: logicalSessionId,
    canonical_state_sha256: stateSha256,
    context_sha256: contextSha256,
    context_refs: [stateRef(state.campaign_id, state.branch_id, state.state_version, stateSha256)],
    budget,
    sections
  };
}

export function validateC6ContextPacket(
  packet: C6GmContextPacket,
  expected: C6ContextExpectation
): string[] {
  const errors: string[] = [];
  if (packet.schema_version !== '1.0' || packet.context_profile !== 'c6-gm') errors.push('context_packet:profile');
  if (packet.campaign_id !== expected.campaignId) errors.push('context_packet:campaign_id_mismatch');
  if (packet.state_version !== expected.baseStateVersion) errors.push('context_packet:state_version_mismatch');
  if (packet.logical_session_id !== `gm:${packet.campaign_id}:${packet.branch_id}`) {
    errors.push('context_packet:logical_session_mismatch');
  }
  if (packet.sections.map(section => section.id).join(',') !== GM_CONTEXT_SECTION_ORDER.join(',')) {
    errors.push('context_packet:section_order');
  }
  const expectedHash = sha256(canonicalJson({
    logical_session_id: packet.logical_session_id,
    budget: packet.budget,
    sections: packet.sections
  }));
  if (packet.context_sha256 !== expectedHash) errors.push('context_packet:context_hash_mismatch');
  const expectedRef = stateRef(
    packet.campaign_id,
    packet.branch_id,
    packet.state_version,
    packet.canonical_state_sha256
  );
  if (
    packet.context_refs.length !== 1
    || packet.context_refs[0]?.id !== expectedRef.id
    || packet.context_refs[0]?.sha256 !== expectedRef.sha256
  ) {
    errors.push('context_packet:context_refs_mismatch');
  }
  if (
    packet.budget.target_min_input_tokens !== 55_000
    || packet.budget.target_max_input_tokens !== 78_000
    || packet.budget.max_input_tokens !== 79_000
  ) {
    errors.push('context_packet:budget');
  }
  return errors;
}

function authorizedSubjectIds(state: CampaignState, refs: readonly string[]): string[] {
  return uniqueSorted(
    refs
      .filter(reference => reference.startsWith('subject:'))
      .map(reference => reference.slice('subject:'.length))
      .filter(subjectId => subjectId.length > 0 && state.characters[subjectId] !== undefined)
  );
}

function secretLeaves(value: unknown): string[] {
  if (typeof value === 'string') return value.length === 0 ? [] : [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(secretLeaves);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(secretLeaves);
  return [];
}

function authorizedForAny(secret: CampaignState['canon']['secrets'][string], subjectIds: readonly string[]): boolean {
  return subjectIds.some(subjectId => secret.authorized_subject_ids.includes(subjectId));
}

export function buildC6WorkerContextPacket(
  state: CampaignState,
  job: SotRpgjobCard.RPGJobCard,
  authority?: { readonly rulesetId: string; readonly resolvedRules: readonly unknown[] }
): C6WorkerContextPacket {
  const subjects = authorizedSubjectIds(state, job.inputs.state_refs);
  const restrictedLeaves = Object.values(state.canon.secrets)
    .filter(secret => !authorizedForAny(secret, subjects))
    .flatMap(secret => secretLeaves(secret.value));
  const facts = uniqueSorted(job.inputs.facts).filter(
    fact => !restrictedLeaves.some(secret => secret.length > 0 && fact.includes(secret))
  );
  const subjectKnowledge = Object.fromEntries(
    subjects.map(subjectId => [subjectId, visibleKnowledgeForSubject(state, subjectId)])
  );
  const base = {
    schema_version: '1.0' as const,
    context_profile: 'c6-worker' as const,
    campaign_id: state.campaign_id,
    branch_id: state.branch_id,
    base_state_version: job.base_state_version,
    job_id: job.job_id,
    worker_id: job.worker_id,
    ruleset_id: authority?.rulesetId ?? null,
    resolved_rules: canonicalClone(authority?.resolvedRules ?? []),
    canonical_state_sha256: canonicalStateSha256(state),
    authorized_subject_ids: subjects,
    inputs: {
      state_refs: uniqueSorted(job.inputs.state_refs),
      event_refs: uniqueSorted(job.inputs.event_refs),
      transcript_refs: uniqueSorted(job.inputs.transcript_refs),
      rules_refs: uniqueSorted(job.inputs.rules_refs),
      facts
    },
    constraints: uniqueSorted(job.constraints),
    subject_knowledge: canonicalClone(subjectKnowledge),
    budget: { max_input_tokens: job.budget.max_context_tokens }
  };
  return canonicalClone({
    ...base,
    context_sha256: sha256(canonicalJson(base))
  });
}

export function validateC6WorkerContextPacket(
  packet: C6WorkerContextPacket,
  state: CampaignState,
  job: SotRpgjobCard.RPGJobCard
): string[] {
  const errors: string[] = [];
  if (packet.schema_version !== '1.0' || packet.context_profile !== 'c6-worker') {
    errors.push('worker_context:profile');
  }
  if (
    packet.campaign_id !== state.campaign_id
    || packet.branch_id !== state.branch_id
    || packet.base_state_version !== state.state_version
    || packet.base_state_version !== job.base_state_version
  ) {
    errors.push('worker_context:state_identity');
  }
  if (packet.job_id !== job.job_id || packet.worker_id !== job.worker_id) {
    errors.push('worker_context:job_identity');
  }
  if (packet.canonical_state_sha256 !== canonicalStateSha256(state)) {
    errors.push('worker_context:canonical_state_hash');
  }
  const expectedSubjects = authorizedSubjectIds(state, job.inputs.state_refs);
  if (job.worker_id === 'rpg.npc_director' && !expectedSubjects.some(id => state.characters[id]?.kind === 'npc')) {
    errors.push('worker_context:npc_subject_required');
  }
  if (packet.authorized_subject_ids.join(',') !== expectedSubjects.join(',')) {
    errors.push('worker_context:authorized_subjects');
  }
  if (packet.budget.max_input_tokens !== job.budget.max_context_tokens) {
    errors.push('worker_context:budget');
  }
  const { context_sha256: contextSha256, ...content } = packet;
  if (contextSha256 !== sha256(canonicalJson(content))) {
    errors.push('worker_context:context_hash');
  }
  return errors;
}
