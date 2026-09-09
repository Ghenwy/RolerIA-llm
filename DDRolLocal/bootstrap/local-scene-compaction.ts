import {
  CompactionCoordinator, buildC6GmContextPacket, classifyContextPressure, llmTurnInput,
  type ApplicationPortResult, type CompactionSourceSnapshot, type CompactionRunOutcome, type LlmGateway
} from '@nyx/application';
import { validateRuntimeContract, type SotRpgjobCard } from '@nyx/contracts';
import { createHierarchicalMemory, validateHierarchicalMemory, type HierarchicalMemoryRecord } from '@nyx/domain';
import {
  CampaignWriterLock, JsonCampaignStore, JsonCheckpointStore, JsonCompactionStore, JsonTranscriptStore,
  canonicalJson, sha256
} from '@nyx/persistence-json';

const hash = (value: unknown): string => sha256(canonicalJson(value));
const fail = (code: string, message: string): ApplicationPortResult<never> => ({ ok: false, error: { code, message } });

/** Code-written pipeline provenance, not a semantic or cryptographic proof of public content. */
export function hasPublicAlphaMemoryProvenance(memories: readonly unknown[]): boolean {
  return memories.every(candidate => {
    if (!validateRuntimeContract('MemoryRecord', candidate).ok) return false;
    const memory = candidate as HierarchicalMemoryRecord;
    if (validateHierarchicalMemory(memory, hash).length > 0) return false;
    const provenance = memory.content.payload['public_context_provenance'];
    if (typeof provenance !== 'object' || provenance === null || Array.isArray(provenance)) return false;
    const fields = provenance as Record<string, unknown>;
    return Object.keys(fields).sort().join(',') === 'schema_version,scope,source_context_sha256'
      && fields['schema_version'] === '1.0' && fields['scope'] === 'PUBLIC_ALPHA'
      && typeof fields['source_context_sha256'] === 'string'
      && /^[a-f0-9]{64}$/.test(fields['source_context_sha256']);
  });
}

/** Only a player/GM pair is compactable; unmatched attempts remain exact context. */
export function completeTranscriptTurnIds(entries: readonly { turn_id: string; speaker: string }[]): string[] {
  const turns = [...new Set(entries.map(entry => entry.turn_id))];
  return turns.filter(turn => entries.filter(entry => entry.turn_id === turn && entry.speaker === 'player').length === 1
    && entries.filter(entry => entry.turn_id === turn && entry.speaker === 'gm').length === 1);
}

interface LocalCompactionInput {
  contextPerSlot?: number;
  campaignRoot: string; campaignId: string; branchId: string; gateway: LlmGateway; parentCheckpointId: string;
  createCheckpoint: () => Promise<ApplicationPortResult<{ checkpointId: string }>>;
  now: () => Date;
  turn?: { turnId: string; playerInput: string };
  narrationScope?: 'PUBLIC_ALPHA';
}

/** DEC-069: explicit short-test scene closure. Never selected by the production pressure policy. */
export function closeLocalTestScene(input: LocalCompactionInput): Promise<ApplicationPortResult<CompactionRunOutcome>> {
  return compactLocalCampaign(input, 'TEST_SCENE_CLOSE');
}

/** Same coordinator and durable stores; production never receives the short-test trigger. */
export async function compactLocalCampaign(input: LocalCompactionInput, trigger?: 'TEST_SCENE_CLOSE'): Promise<ApplicationPortResult<CompactionRunOutcome>> {
  const shortScene = trigger === 'TEST_SCENE_CLOSE';
  const { campaignRoot, campaignId, branchId, gateway } = input;
  const startingState = await new JsonCampaignStore(campaignRoot).open(branchId);
  if (!startingState.ok) return startingState;
  const lock = new CampaignWriterLock(campaignRoot);
  const lease = await lock.acquire({ campaign_id: campaignId, branch_id: branchId, owner_runtime: 'typescript', pid: process.pid,
    acquired_at: input.now().toISOString(), state_sha256: hash(startingState.value), checkpoint_id: input.parentCheckpointId });
  if (!lease.ok) return lease;
  try {
    const campaigns = new JsonCampaignStore(campaignRoot);
    const compactions = new JsonCompactionStore(campaignRoot, { branch_id: branchId });
    const active = await compactions.current();
    if (!active.ok) return active;
    if (shortScene && active.value !== null) return fail('TEST_SCENE_ALREADY_CLOSED', 'La prueba corta sólo compacta una escena por campaña.');
    const opened = await campaigns.open(branchId);
    if (!opened.ok) return opened;
    const state = opened.value;
    if (hash(state) !== hash(startingState.value)) return fail('STALE_STATE', 'El estado cambió antes de adquirir el lock.');
    const events = await campaigns.events.tail(branchId);
    if (!events.ok) return events;
    const transcriptStore = new JsonTranscriptStore(campaignRoot);
    const transcript = await transcriptStore.tail(branchId);
    if (!transcript.ok) return transcript;
    const priorMemories = (active.value?.memory_records ?? []) as unknown as HierarchicalMemoryRecord[];
    if (input.narrationScope === 'PUBLIC_ALPHA' && !hasPublicAlphaMemoryProvenance(priorMemories)) {
      return fail('PUBLIC_MEMORY_PROVENANCE_REQUIRED', 'La memoria previa no acredita el pipeline público Alpha; no se reclasifica ni se descarta.');
    }
    const summarized = new Set(priorMemories.flatMap(memory => memory.content.provenance.source_turn_ids));
    const retained = new Set(active.value?.context_view.recent_transcript_refs ?? []);
    const activeTranscript = transcript.value.filter(entry => !summarized.has(entry.turn_id)
      || retained.has(`transcript:${entry.transcript_id}`) || retained.has(`transcript:${entry.turn_id}`));
    const invalidPair = [...new Set(activeTranscript.map(entry => entry.turn_id))].some(turn => {
      const entries = activeTranscript.filter(entry => entry.turn_id === turn);
      const players = entries.filter(entry => entry.speaker === 'player').length;
      const gms = entries.filter(entry => entry.speaker === 'gm').length;
      return players > 1 || gms > 1 || (gms === 1 && (players !== 1
        || entries.findIndex(entry => entry.speaker === 'gm') < entries.findIndex(entry => entry.speaker === 'player')));
    });
    if (invalidPair) return fail('INCOMPLETE_SCENE', 'El transcript contiene respuestas duplicadas o sin entrada previa.');
    const turns = completeTranscriptTurnIds(activeTranscript);
    const oldTurnIds = turns.slice(0, -2);
    const oldTranscript = activeTranscript.filter(entry => oldTurnIds.includes(entry.turn_id));
    const recentTranscript = activeTranscript.filter(entry => !oldTurnIds.includes(entry.turn_id));
    const beforeHash = hash({ state, events: events.value, transcript: transcript.value });
    const packet = (memories: readonly unknown[], recent: typeof transcript.value, threads?: readonly Record<string, unknown>[], playerMessage = input.turn?.playerInput ?? 'Continuar la escena.') =>
      buildC6GmContextPacket(state, { language: 'es', playerMessage,
        recentRawTranscript: recent, retrievedMemories: memories, ...(threads ? { activeOpenThreads: threads } : {}),
        ...(input.narrationScope === undefined ? {} : { narrationScope: input.narrationScope }) });
    const countInput = (memories: readonly unknown[], recent: typeof transcript.value, threads?: readonly Record<string, unknown>[]) => {
      const context = packet(memories, recent, threads);
      return shortScene ? context : llmTurnInput({ schema_version: '1.0', campaign_id: campaignId,
        turn_id: input.turn?.turnId ?? 'TURN-MEMORY-GATE', phase: 'PLAN', base_state_version: state.state_version,
        player_input: input.turn?.playerInput ?? 'Continuar la escena.', context_refs: [...context.context_refs],
        worker_results: [], deterministic_rolls: [], language: 'es' }, context);
    };
    const counted = await gateway.countInputTokens(countInput(priorMemories, activeTranscript, active.value?.context_view.open_threads), { correlationId: `SCENE-${campaignId}-SOURCE`, timeoutMs: 180000 });
    if (!counted.ok) return fail(`LLM_${counted.error.code}`, 'No se pudo contar el contexto de origen.');
    const pressure = classifyContextPressure(counted.value.inputTokens);
    // AMD-004: preempt the 79K GM limit and the ten-turn raw window without truncating history.
    // Preempt smaller physical slots, reserving headroom for Keeper input/response overhead.
    // This is a trigger, not an estimated token count; the gateway admits each exact request again.
    const slotPressure = input.contextPerSlot !== undefined && counted.value.inputTokens >= input.contextPerSlot - 8192;
    if (!shortScene && !slotPressure && pressure.state === 'GREEN' && turns.length < 10) return { ok: true, value: { status: 'SKIPPED', pressure } };
    if (shortScene && (counted.value.inputTokens < 2 || counted.value.inputTokens >= 72000)) return fail('INVALID_COMPACTION_TRIGGER', 'La excepción requiere contexto corto con conteo real menor que 72K.');
    if (turns.length < 3 || (shortScene && turns.length > 10))
      return fail('INCOMPLETE_SCENE', 'Se requieren turnos completos y confirmados antes de compactar.');
    const fingerprints = (entries: [string, unknown][]) => Object.fromEntries(entries.map(([id, value]) => [id, hash(value)]));
    const characters = Object.entries(state.characters);
    const source: CompactionSourceSnapshot = {
      campaign_id: campaignId, branch_id: branchId, base_state_version: state.state_version,
      source_context_sha256: hash(countInput(priorMemories, activeTranscript, active.value?.context_view.open_threads)),
      active_compaction_commit_id: active.value?.commit_id ?? null,
      pc_sheet_fingerprints: fingerprints(characters.filter(([, c]) => c.kind === 'player').map(([id, c]) => [id, c.sheet])),
      relevant_npc_sheet_fingerprints: fingerprints(characters.filter(([, c]) => c.kind === 'npc').map(([id, c]) => [id, c.sheet])),
      party_inventory_fingerprints: fingerprints(Object.entries(state.inventories).filter(([, i]) => i.owner_type === 'party')),
      character_inventory_fingerprints: fingerprints(Object.entries(state.inventories).filter(([, i]) => i.owner_type === 'character')),
      quest_fingerprints: fingerprints(Object.entries(state.quests)), canon_sha256: hash(state.canon),
      knowledge_sha256: hash({ knowledge: state.knowledge, beliefs: state.beliefs, rumors: state.rumors }),
      expected_exact_refs: [...characters.map(([id]) => `state:${id}`), ...Object.keys(state.inventories).map(id => `inventory:${id}`),
        ...Object.keys(state.quests).map(id => `quest:${id}`), `canon:${campaignId}`, `knowledge:${campaignId}`,
        ...events.value.map(event => `event:${event.event_id}`)],
      source_turn_ids: oldTurnIds, source_event_ids: events.value.map(event => event.event_id),
      open_thread_ids: [...new Set([...Object.keys(state.quests), ...(active.value?.context_view.open_threads ?? [])
        .flatMap(thread => typeof thread['thread_id'] === 'string' ? [thread['thread_id']] : [])])],
      // Unpaired attempts are outside every evictable complete-turn range, never summarized as facts.
      recent_transcript: activeTranscript.map(entry => ({ turn: turns.includes(entry.turn_id)
        ? turns.indexOf(entry.turn_id) + 1 : turns.length + 1, ref: `transcript:${entry.transcript_id}` }))
    };
    const pre = await input.createCheckpoint();
    if (!pre.ok) return pre;
    // Compaction never writes canonical state or transcript. Recovery verifies PRE and that those sources stayed byte-equivalent.
    const verifyUnchanged = async (): Promise<ApplicationPortResult<void>> => {
      const checkpoint = await new JsonCheckpointStore(campaignRoot, campaigns).load(pre.value.checkpointId);
      const reopened = await campaigns.open(branchId);
      const newEvents = await campaigns.events.tail(branchId);
      const newTranscript = await transcriptStore.tail(branchId);
      if (!checkpoint.ok || !reopened.ok || !newEvents.ok || !newTranscript.ok
        || hash({ state: reopened.value, events: newEvents.value, transcript: newTranscript.value }) !== beforeHash
        || hash(checkpoint.value.state) !== hash(state)) return fail('COMPACTION_SOURCE_CHANGED', 'Las fuentes exactas no coinciden con PRE. No se activa memoria.');
      const stillActive = await compactions.current();
      if (!stillActive.ok || (stillActive.value?.commit_id ?? null) !== (active.value?.commit_id ?? null))
        return fail('COMPACTION_BASE_MISMATCH', 'La memoria activa cambió; se conserva PRE.');
      return { ok: true, value: undefined };
    };
    const publicPacket = input.narrationScope === 'PUBLIC_ALPHA'
      ? packet(priorMemories, oldTranscript, active.value?.context_view.open_threads, '') : undefined;
    const proposalInput = publicPacket === undefined
      ? { source, turn_range: { from_turn: 1, to_turn: oldTurnIds.length }, state, events: events.value, transcript: oldTranscript }
      // PUBLIC_ALPHA already contains every old record in recent_raw_transcript, with the same refs.
      : { proposal_scope: 'PUBLIC_CONTEXT_ONLY_V1', source, turn_range: { from_turn: 1, to_turn: oldTurnIds.length }, context_packet: publicPacket,
        instructions: 'Resume sólo esta vista pública y su transcript exacto. Las fuentes EXACT privadas se conservan íntegras en estado y checkpoints; sus referencias y fingerprints acreditan conservación, no autorización para copiar su contenido. No infieras datos privados ausentes.' };
    const sourceStillExact = await verifyUnchanged();
    if (!sourceStillExact.ok) return sourceStillExact;
    const proposal = await gateway.proposeCompaction(proposalInput, { correlationId: `SCENE-${campaignId}-MEMORY`, timeoutMs: 180000 });
    if (!proposal.ok) return fail(`LLM_${proposal.error.code}`, 'Memory Keeper no produjo una propuesta válida; fuentes y PRE conservados.');
    const contract = validateRuntimeContract('CompactionProposal', proposal.value);
    if (!contract.ok) return fail('COMPACTION_VALIDATION_FAILED', 'Propuesta inválida.');
    if (proposal.value.source_turn_range.from_turn !== 1 || proposal.value.source_turn_range.to_turn !== oldTurnIds.length)
      return fail('COMPACTION_VALIDATION_FAILED', 'Rango no solicitado; se conserva el contexto original.');
    const memory = createHierarchicalMemory({
      memoryId: `MEMORY-SCENE-${hash(proposal.value).slice(0, 24)}`, campaignId, branchId,
      category: 'scene_summary', scope: { level: 'SCENE', scope_id: shortScene ? 'SCENE-TEST-CLOSE' : `SCENE-${hash(oldTurnIds).slice(0, 20)}` },
      payload: { summary: proposal.value.scene_summary, durable_memories: proposal.value.durable_memories,
        npc_memory_proposals: proposal.value.npc_memory_patches,
        ...(publicPacket === undefined ? {} : { public_context_provenance: {
          schema_version: '1.0', scope: 'PUBLIC_ALPHA', source_context_sha256: hash(proposalInput)
        } }) },
      provenance: { source_turn_ids: oldTurnIds, source_event_ids: [...source.source_event_ids],
        entities: Object.keys(state.characters), locations: [], quests: Object.keys(state.quests),
        time_range: { start: oldTranscript[0]!.occurred_at, end: oldTranscript.at(-1)!.occurred_at },
        importance: 1, retrieval_keys: proposal.value.retrieval_keys, confidence: 1 },
      sourceRefs: [...oldTranscript.map(entry => `transcript:${entry.transcript_id}`), ...source.expected_exact_refs], stateVersion: state.state_version
    }, hash);
    if (!memory.ok) return fail(memory.error.code, 'No se pudo construir una memoria válida.');
    const job: SotRpgjobCard.RPGJobCard = {
      schema_version: '1.0', job_id: `JOB-SCENE-${hash(proposal.value).slice(0, 20).toUpperCase()}`, turn_id: 'TURN-SCENE-CLOSE',
      worker_id: 'rpg.canon_validator', base_state_version: state.state_version, priority: 'P0', blocking: true, status: 'READY',
      objective: 'Verificar pérdida cero de EXACT, DURABLE, secretos y fuentes en la compactación de escena.',
      inputs: { state_refs: [...source.expected_exact_refs], event_refs: source.source_event_ids.map(id => `event:${id}`),
        transcript_refs: oldTranscript.map(entry => `transcript:${entry.transcript_id}`), rules_refs: [], facts: [] },
      constraints: ['No modificar estado ni inferir datos faltantes; rechazar toda pérdida o discrepancia.',
        ...(publicPacket === undefined ? [] : ['La propuesta resume sólo la vista pública; rechazar divulgación privada en resumen, memorias, threads o claves. Los EXACT privados permanecen en estado y checkpoints, no requieren copiarse al resumen público.'])], dependencies: [],
      expected_output: { type: 'RPGWorkerResult', required_fields: ['status', 'dod', 'unresolved'] },
      definition_of_done: ['Todos los elementos exactos y durables conservados; cero discrepancias.'],
      budget: { max_context_tokens: shortScene ? 16384 : 50000, max_output_tokens: 2048, deadline_class: 'before_resolution' }
    };
    const coordinator = new CompactionCoordinator({
      proposal: { create: async () => ({ ok: true, value: proposal.value }) },
      canon: { validate: async () => {
        const validated = await gateway.runWorker(job, [{ state, events: events.value, transcript: oldTranscript, proposal: proposal.value,
          ...(publicPacket === undefined ? {} : { public_context_packet: publicPacket }) }],
          { correlationId: `SCENE-${campaignId}-CANON`, timeoutMs: 180000 });
        if (!validated.ok) return fail(`LLM_${validated.error.code}`, 'Canon Validator no disponible.');
        const value = validated.value;
        if (!validateRuntimeContract('RPGWorkerResult', value).ok || value.job_id !== job.job_id || value.turn_id !== job.turn_id
          || value.worker_id !== job.worker_id || value.base_state_version !== state.state_version
          || value.status !== 'completed' || !value.dod.passed || value.dod.missing.length > 0 || value.unresolved.length > 0
          || value.proposed_events.length > 0 || value.proposed_patches.length > 0) return fail('COMPACTION_CANON_REJECTED', 'Canon Validator no confirmó pérdida cero.');
        return verifyUnchanged();
      } },
      checkpoints: {
        create: async phase => {
          const unchanged = await verifyUnchanged();
          if (!unchanged.ok) return unchanged;
          if (phase.phase === 'PRE') return { ok: true, value: { checkpoint_id: pre.value.checkpointId } };
          const post = await input.createCheckpoint();
          return post.ok ? { ok: true, value: { checkpoint_id: post.value.checkpointId } } : post;
        },
        restore: verifyUnchanged
      },
      store: compactions,
      tokens: { count: async candidate => {
        const result = await gateway.countInputTokens(countInput(candidate.memory_records, recentTranscript, candidate.context_view.open_threads),
          { correlationId: `SCENE-${campaignId}-CANDIDATE`, timeoutMs: 180000 });
        return result.ok ? { ok: true, value: result.value.inputTokens } : fail(`LLM_${result.error.code}`, 'No se pudo contar el candidato.');
      } }, hashCanonical: hash
    });
    return await coordinator.run({ trigger: shortScene ? 'TEST_SCENE_CLOSE' : 'RUNTIME_CONTINUITY', input_tokens: counted.value.inputTokens,
      source, memories: [...priorMemories, memory.value], now: input.now().toISOString() });
  } finally {
    await lock.release(lease.value.token);
  }
}
