import crypto from 'node:crypto';
import type {
  C5WorkerResultPacket,
  LlmCancellation,
  LlmGateway,
  LlmGatewayError,
  LlmGatewayResult,
  LlmHealth,
  LlmModelCatalog,
  LlmOperation,
  LlmRequestOptions,
  LlmTokenCount,
  TurnContextPacket
} from '@nyx/application';
import { llmTurnInput, validateC3TurnInput, validateC5WorkerResultBinding, validateTurnPlanSemantics, pendingExplicitDiceExpression } from '@nyx/application';
import {
  runtimeContractSchema,
  validateJsonSchema,
  validateRuntimeContract,
  type DesignTurnEnvelope,
  type RuntimeContractName,
  type SotRpgjobCard,
  type SotRpgworkerResult,
  type SotTurnPlan,
  type SotTurnResolution,
  type SotCompactionProposal,
  type SotRuleResolution,
  type DesignNarrationProposalV1
} from '@nyx/contracts';
import type { OperationalLogger } from '@nyx/observability';
import { turnPlanGenerationSchema } from './turn-plan-generation-schema.js';
import { turnResolutionGenerationSchema } from './turn-resolution-generation-schema.js';
import { workerResultGenerationSchema } from './worker-result-generation-schema.js';
import { PUBLIC_COMPACTION_PROMPT, PUBLIC_COMPACTION_CANON_CHECK, publicCompactionGenerationSchema } from './public-compaction-generation.js';
import { classifyContextPressure } from '../tokenizer/context-pressure.js';
import { ASSISTED_NARRATION_PROMPT, NARRATION_RETRY_INSTRUCTION, balancedDialogue, buildNarrationInput, narrationGenerationSchema } from './narration-boundary.js';

type WorkerId = SotRpgjobCard.RPGJobCard['worker_id'];
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const GM_FIRST_ATTEMPT_MAX_TOKENS = 3072;
const GM_RETRY_MAX_TOKENS = 2048;
const GM_RETRY_FORMAT_INSTRUCTION =
  'Reintento de formato: devuelve únicamente un objeto JSON válido y completo que cumpla el schema. ' +
  'Sé conciso: limita la narración a 1200 caracteres y usa arrays vacíos salvo elementos estrictamente necesarios. ' +
  'No añadas explicaciones fuera del JSON.';

const CANDIDATE_REJECTION_INSTRUCTIONS = {
  KNOWLEDGE_REJECTED: '\n\n[DESIGN] KNOWLEDGE_REJECTED: el State Engine rechazó la adquisición propuesta; no ocurrió ni se publicó. ' +
    'Responde desde el conocimiento o creencia existente sin convertir la conversación en aprendizaje. ' +
    'No repitas eventos sin fuente confirmada. Si no puedes responder sin inventar, reconoce la información ausente o devuelve BLOCKED.',
  STATE_REJECTED: '\n\n[DESIGN] STATE_REJECTED: el State Engine rechazó el candidato anterior; sus cambios no ocurrieron. ' +
    'Replanifica desde el snapshot confirmado y la acción declarada. No presupongas efectos rechazados; devuelve BLOCKED si falta evidencia.'
} as const;

function gmContextBudget(packet: TurnContextPacket | undefined): number | undefined {
  return packet !== undefined && 'context_profile' in packet && packet.context_profile === 'c6-gm'
    ? packet.budget.max_input_tokens
    : undefined;
}

export interface LlamaServerGatewayOptions {
  contextPerSlot?: number;
  dnd35RulesArbiterPrompt?: string;
  origin: string;
  modelId: string;
  gmPrompt: string;
  workerPrompts: Partial<Record<WorkerId, string>>;
  fetch?: FetchLike;
  observability?: OperationalLogger;
}

interface PendingHttpRequest {
  readonly operation: LlmOperation;
  readonly controller: AbortController;
  cancelled: boolean;
  timedOut: boolean;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: unknown } }[];
}

interface CompletionPolicy {
  readonly slot: number;
  readonly generationSchema?: object;
  readonly maxContextTokens?: number;
  readonly maxTokens?: number;
  readonly completedRolls?: readonly DesignTurnEnvelope.RollRef[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deterministicRequestSeed(correlationId: string): number {
  return crypto.createHash('sha256').update(correlationId).digest().readUInt32BE(0) & 0x7fffffff;
}

export class LlamaServerGateway implements LlmGateway {
  readonly #origin: string;
  readonly #contextPerSlot: number | undefined;
  readonly #modelId: string;
  readonly #gmPrompt: string;
  readonly #workerPrompts: Partial<Record<WorkerId, string>>;
  readonly #fetch: FetchLike;
  readonly #observability: OperationalLogger | undefined;
  readonly #pending = new Map<string, PendingHttpRequest>();
  readonly #narrationRequests = new Set<string>();
  readonly #workerSlotsInUse = new Set<number>();
  readonly #dnd35RulesArbiterPrompt: string | undefined;

  constructor(options: LlamaServerGatewayOptions) {
    if (options.contextPerSlot !== undefined && (!Number.isSafeInteger(options.contextPerSlot) || options.contextPerSlot < 1)) {
      throw new Error('contextPerSlot debe ser un entero positivo.');
    }
    this.#contextPerSlot = options.contextPerSlot;
    this.#dnd35RulesArbiterPrompt = options.dnd35RulesArbiterPrompt;
    const origin = new URL(options.origin);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password) {
      throw new Error('LlamaServerGateway sólo admite un origen HTTP loopback 127.0.0.1.');
    }
    if (origin.pathname !== '/' || origin.search || origin.hash) {
      throw new Error('El origen de llama-server no puede contener ruta, query ni fragmento.');
    }
    if (options.modelId.length === 0 || options.gmPrompt.length === 0) {
      throw new Error('modelId y gmPrompt son obligatorios.');
    }
    this.#origin = origin.origin;
    this.#modelId = options.modelId;
    this.#gmPrompt = options.gmPrompt;
    this.#workerPrompts = { ...options.workerPrompts };
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#observability = options.observability;
  }

  async health(options: LlmRequestOptions): Promise<LlmGatewayResult<LlmHealth>> {
    const response = await this.#requestJson('HEALTH', '/health', options, { method: 'GET' });
    if (!response.ok) return response;
    if (!isRecord(response.value) || response.value['status'] !== 'ok') {
      return this.#error('RUNTIME_UNHEALTHY', 'HEALTH', options, true);
    }
    return { ok: true, value: { status: 'ok' } };
  }

  async listModels(options: LlmRequestOptions): Promise<LlmGatewayResult<LlmModelCatalog>> {
    const response = await this.#requestJson('MODELS', '/v1/models', options, { method: 'GET' });
    if (!response.ok) return response;
    if (!isRecord(response.value) || !Array.isArray(response.value['data'])) {
      return this.#error('INVALID_RESPONSE', 'MODELS', options, false);
    }
    const modelIds = response.value['data']
      .filter(isRecord)
      .map(model => model['id'])
      .filter((id): id is string => typeof id === 'string');
    return { ok: true, value: { modelIds } };
  }

  async countInputTokens(input: unknown, options: LlmRequestOptions): Promise<LlmGatewayResult<LlmTokenCount>> {
    const messages = this.#messages(this.#gmPrompt, input, 'COUNT_TOKENS', options);
    if (!messages.ok) return messages;
    return this.#countMessages(messages.value, options);
  }

  async #countMessages(
    messages: readonly { role: 'system' | 'user'; content: string }[],
    options: LlmRequestOptions
  ): Promise<LlmGatewayResult<LlmTokenCount>> {
    const response = await this.#requestJson('COUNT_TOKENS', '/v1/chat/completions/input_tokens', options, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.#modelId, messages })
    });
    if (!response.ok) return response;
    if (!isRecord(response.value) || !Number.isSafeInteger(response.value['input_tokens']) || Number(response.value['input_tokens']) < 0) {
      return this.#error('INVALID_RESPONSE', 'COUNT_TOKENS', options, false);
    }
    return { ok: true, value: { inputTokens: Number(response.value['input_tokens']) } };
  }

  async narrate(
    envelope: DesignTurnEnvelope.TurnEnvelopeV1,
    options: LlmRequestOptions,
    contextPacket: TurnContextPacket
  ): Promise<LlmGatewayResult<DesignNarrationProposalV1.NarrationProposalV1>> {
    const input = buildNarrationInput(envelope, options, contextPacket);
    if (!input.ok) return this.#error('INVALID_INPUT', 'NARRATE', options, false, input.errors);
    if (this.#narrationRequests.has(options.correlationId)) return this.#error('CORRELATION_CONFLICT', 'NARRATE', options, false);
    const maxContextTokens = gmContextBudget(contextPacket);
    this.#narrationRequests.add(options.correlationId);
    try {
      return await this.#completion('NARRATE', 'NarrationProposal', ASSISTED_NARRATION_PROMPT, input.value, options,
        { slot: 0, generationSchema: narrationGenerationSchema(), ...(maxContextTokens === undefined ? {} : { maxContextTokens }) });
    } finally {
      this.#narrationRequests.delete(options.correlationId);
    }
  }

  async plan(
    envelope: DesignTurnEnvelope.TurnEnvelopeV1,
    options: LlmRequestOptions,
    contextPacket?: TurnContextPacket
  ): Promise<LlmGatewayResult<SotTurnPlan.TurnPlan>> {
    const valid = this.#validateInput('PLAN', 'TurnEnvelope', envelope, options);
    if (!valid.ok) return valid;
    if (envelope.phase !== 'PLAN') return this.#error('INVALID_INPUT', 'PLAN', options, false, ['/phase:const']);
    const input = this.#turnInput('PLAN', envelope, contextPacket, options);
    if (!input.ok) return input;
    const maxContextTokens = gmContextBudget(contextPacket);
    return this.#completion(
      'PLAN',
      'TurnPlan',
      this.#gmPrompt,
      input.value,
      options,
      {
        slot: 0,
        ...(maxContextTokens === undefined
          ? {}
          : { maxContextTokens }),
        generationSchema: turnPlanGenerationSchema({
          turnId: envelope.turn_id,
          baseStateVersion: envelope.base_state_version
        })
      }
    );
  }

  async resolve(
    envelope: DesignTurnEnvelope.TurnEnvelopeV1,
    options: LlmRequestOptions,
    contextPacket?: TurnContextPacket,
    workerResultPacket?: C5WorkerResultPacket
  ): Promise<LlmGatewayResult<SotTurnResolution.TurnResolution>> {
    const valid = this.#validateInput('RESOLVE', 'TurnEnvelope', envelope, options);
    if (!valid.ok) return valid;
    if (envelope.phase !== 'RESOLVE') return this.#error('INVALID_INPUT', 'RESOLVE', options, false, ['/phase:const']);
    const input = this.#turnInput('RESOLVE', envelope, contextPacket, options, workerResultPacket);
    if (!input.ok) return input;
    if (options.turnPlan !== undefined && (!validateRuntimeContract('TurnPlan', options.turnPlan).ok
      || !validateTurnPlanSemantics(options.turnPlan, { turnId: envelope.turn_id, baseStateVersion: envelope.base_state_version }).ok)) {
      return this.#error('INVALID_INPUT', 'RESOLVE', options, false, ['/turn_plan:binding']);
    }
    const maxContextTokens = gmContextBudget(contextPacket);
    const playerMessage = contextPacket !== undefined && 'sections' in contextPacket
      ? contextPacket.sections.find(section => section.id === 'current_player_message')?.value
      : envelope.player_input;
    const pendingExpression = options.mechanicalAction == null ? pendingExplicitDiceExpression(playerMessage, envelope.deterministic_rolls) : undefined;
    const mechanical = options.mechanicalAction;
    if (mechanical != null && (!validateRuntimeContract('MechanicalAction', mechanical).ok
      || mechanical.campaign_id !== envelope.campaign_id || mechanical.turn_id !== envelope.turn_id
      || mechanical.base_state_version !== envelope.base_state_version
      || JSON.stringify(mechanical.rolls) !== JSON.stringify(envelope.deterministic_rolls))) {
      return this.#error('INVALID_INPUT', 'RESOLVE', options, false, ['/mechanical_action:binding']);
    }
    const payload = { ...(input.value as Record<string, unknown>),
      ...(mechanical === undefined ? {} : { mechanical_action: mechanical }),
      ...(options.turnPlan === undefined ? {} : { turn_plan: options.turnPlan }) };
    return this.#completion('RESOLVE', 'TurnResolution', this.#gmPrompt, payload, options, {
      slot: 0,
      completedRolls: envelope.deterministic_rolls,
      ...(maxContextTokens === undefined
        ? {}
        : { maxContextTokens }),
      generationSchema: turnResolutionGenerationSchema({
        turnId: envelope.turn_id,
        baseStateVersion: envelope.base_state_version,
        ...(mechanical === undefined ? {} : { mechanicalAction: mechanical }),
        ...(pendingExpression === undefined ? {} : { pendingExplicitExpression: pendingExpression })
      })
    });
  }

  #turnInput(
    operation: 'PLAN' | 'RESOLVE',
    envelope: DesignTurnEnvelope.TurnEnvelopeV1,
    contextPacket: TurnContextPacket | undefined,
    options: LlmRequestOptions,
    workerResultPacket?: C5WorkerResultPacket
  ): LlmGatewayResult<unknown> {
    const bindingErrors = validateC5WorkerResultBinding(envelope, workerResultPacket);
    if (bindingErrors.length > 0) return this.#error('INVALID_INPUT', operation, options, false, bindingErrors);
    if (contextPacket === undefined) {
      return workerResultPacket === undefined
        ? { ok: true, value: envelope }
        : this.#error('INVALID_INPUT', operation, options, false, ['context_packet:required_with_worker_results']);
    }
    const errors = [
      ...validateC3TurnInput(envelope, contextPacket)
    ];
    return errors.length === 0
      ? { ok: true, value: llmTurnInput(envelope, contextPacket, workerResultPacket) }
      : this.#error('INVALID_INPUT', operation, options, false, errors);
  }

  async runWorker(
    job: SotRpgjobCard.RPGJobCard,
    context: readonly unknown[],
    options: LlmRequestOptions
  ): Promise<LlmGatewayResult<SotRpgworkerResult.RPGWorkerResult>> {
    const valid = this.#validateInput('WORKER', 'RPGJobCard', job, options);
    if (!valid.ok) return valid;
    const prompt = this.#workerPrompts[job.worker_id];
    if (prompt === undefined || prompt.length === 0) {
      return this.#error('INVALID_INPUT', 'WORKER', options, false, [`missing-prompt:${job.worker_id}`]);
    }
    const attempt = options.workerAttempt ?? 0;
    if (attempt !== 0 && attempt !== 1) {
      return this.#error('INVALID_INPUT', 'WORKER', options, false, ['workerAttempt:enum']);
    }
    const slot = this.#acquireWorkerSlot();
    if (slot === undefined) {
      return this.#error('CAPACITY_EXHAUSTED', 'WORKER', options, true, ['worker_slots:2']);
    }
    try {
      return await this.#completion(
        'WORKER',
        'RPGWorkerResult',
        job.worker_id === 'rpg.canon_validator' && context.some(value =>
          typeof value === 'object' && value !== null && 'proposal' in value && 'public_context_packet' in value)
          ? `${prompt}\n\n${PUBLIC_COMPACTION_CANON_CHECK}` : prompt,
        { job, context },
        options,
        {
          slot,
          maxContextTokens: job.budget.max_context_tokens,
          maxTokens: job.budget.max_output_tokens,
          generationSchema: workerResultGenerationSchema(job)
        }
      );
    } finally {
      this.#workerSlotsInUse.delete(slot);
    }
  }

  async proposeCompaction(input: unknown, options: LlmRequestOptions): Promise<LlmGatewayResult<SotCompactionProposal.CompactionProposal>> {
    const prompt = this.#workerPrompts['rpg.memory_keeper'];
    if (!prompt) return this.#error('INVALID_INPUT', 'WORKER', options, false, ['missing-prompt:rpg.memory_keeper']);
    // Scoped generation constraints, not a migration or a repair of historical proposals.
    const publicContextOnly = isRecord(input) && input['proposal_scope'] === 'PUBLIC_CONTEXT_ONLY_V1';
    const generationSchema = publicContextOnly ? publicCompactionGenerationSchema(input) : undefined;
    if (publicContextOnly && !generationSchema) return this.#error('INVALID_INPUT', 'WORKER', options, false, ['compaction:source']);
    const scopedPrompt = publicContextOnly ? PUBLIC_COMPACTION_PROMPT : prompt;
    const generationInput = publicContextOnly && isRecord(input) && isRecord(input['source'])
      ? { context_packet: input['context_packet'], turn_range: input['turn_range'],
        open_thread_ids: input['source']['open_thread_ids'], source_turn_ids: input['source']['source_turn_ids'] }
      : input;
    const slot = this.#acquireWorkerSlot();
    if (slot === undefined) return this.#error('CAPACITY_EXHAUSTED', 'WORKER', options, true, ['worker_slots:2']);
    try {
      return await this.#completion('WORKER', 'CompactionProposal', scopedPrompt, generationInput, options,
        { slot, maxContextTokens: 70_000, maxTokens: 3072, ...(generationSchema ? { generationSchema } : {}) });
    } finally {
      this.#workerSlotsInUse.delete(slot);
    }
  }

  async cancel(correlationId: string): Promise<LlmGatewayResult<LlmCancellation>> {
    const pending = this.#pending.get(correlationId)
      ?? (this.#narrationRequests.has(correlationId) ? this.#pending.get(`${correlationId}-RETRY-1`) : undefined);
    if (pending === undefined) return { ok: true, value: { cancelled: false } };
    pending.cancelled = true;
    pending.controller.abort();
    return { ok: true, value: { cancelled: true } };
  }

  async arbitrateRule(input: unknown, options: LlmRequestOptions): Promise<LlmGatewayResult<SotRuleResolution.UrnNyxRpgDnd35RuleResolution10>> {
    if (!this.#dnd35RulesArbiterPrompt || !isRecord(input) || !validateRuntimeContract('RuleQuery', input['query']).ok) {
      return this.#error('INVALID_INPUT', 'WORKER', options, false, ['dnd35-prompt-or-query']);
    }
    const slot = this.#acquireWorkerSlot();
    if (slot === undefined) return this.#error('CAPACITY_EXHAUSTED', 'WORKER', options, true, ['worker_slots:2']);
    try {
      return await this.#completion('WORKER', 'RuleResolution', this.#dnd35RulesArbiterPrompt, input, options,
        { slot, maxContextTokens: 16_384, maxTokens: 1024 });
    } finally {
      this.#workerSlotsInUse.delete(slot);
    }
  }

  #messages(
    system: string,
    input: unknown,
    operation: LlmOperation,
    options: LlmRequestOptions
  ): LlmGatewayResult<readonly { role: 'system' | 'user'; content: string }[]> {
    try {
      // NARRATE validates the original packet first, then sends intent once as the final player message.
      // Other operations keep their historical request serialization.
      const content = JSON.stringify(operation === 'NARRATE' && isRecord(input)
        ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'player_input')) : input);
      if (typeof content !== 'string') throw new TypeError('Input is not JSON serializable.');
      const payload = input as { context_packet?: { sections?: { id: string; value: unknown }[] };
        turn_envelope?: { player_input?: unknown }; player_input?: unknown } | null;
      const currentMessage = operation === 'WORKER' ? undefined
        : payload?.context_packet?.sections?.find(section => section.id === 'current_player_message')?.value
          ?? payload?.turn_envelope?.player_input ?? payload?.player_input;
      const rejection = options.candidateRejection;
      if (rejection !== undefined && rejection !== 'KNOWLEDGE_REJECTED' && rejection !== 'STATE_REJECTED') {
        return this.#error('INVALID_INPUT', operation, options, false, ['/candidate_rejection:enum']);
      }
      const feedback = rejection === undefined || operation === 'WORKER' ? '' : CANDIDATE_REJECTION_INSTRUCTIONS[rejection];
      return {
        ok: true,
        value: [
          { role: 'system', content: system + feedback },
          { role: 'user', content },
          ...(typeof currentMessage === 'string' ? [{ role: 'user' as const, content: currentMessage }] : [])
        ]
      };
    } catch {
      return this.#error('INVALID_INPUT', operation, options, false, ['input:not-json-serializable']);
    }
  }

  async #completion<T>(
    operation: 'PLAN' | 'RESOLVE' | 'WORKER' | 'NARRATE',
    contract: RuntimeContractName,
    prompt: string,
    input: unknown,
    options: LlmRequestOptions,
    policy: CompletionPolicy
  ): Promise<LlmGatewayResult<T>> {
    const messages = this.#messages(prompt, input, operation, options);
    if (!messages.ok) return messages;
    // Only the new assisted operation shares a monotonic budget; historical operations are unchanged.
    const deadline = operation === 'NARRATE' ? performance.now() + options.timeoutMs : undefined;
    const remaining = (request: LlmRequestOptions): LlmRequestOptions => deadline === undefined ? request
      : { ...request, timeoutMs: Math.max(0, Math.floor(deadline - performance.now())) };
    const maximumAttempts = operation === 'WORKER' ? 1 : 2;
    let semanticFeedback = '';
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const gmRetry = operation !== 'WORKER' && attempt === 1;
      const attemptOptions = gmRetry
        ? { ...options, correlationId: `${options.correlationId}-RETRY-1` }
        : options;
      const attemptMessages = gmRetry
        ? [
            {
              role: 'system' as const,
              content: `${messages.value[0]!.content}\n\n${operation === 'NARRATE' ? NARRATION_RETRY_INSTRUCTION : GM_RETRY_FORMAT_INSTRUCTION}${semanticFeedback}`
            },
            ...messages.value.slice(1)
          ]
        : messages.value;
      // Count the exact request, including retry feedback; never estimate added tokens.
      const countOptions = remaining(attemptOptions);
      if (deadline !== undefined && countOptions.timeoutMs <= 0) return this.#error('TIMEOUT', operation, attemptOptions, false);
      const counted = await this.#countMessages(attemptMessages, countOptions);
      if (!counted.ok) return counted;
      const outputTokens = operation === 'WORKER' ? policy.maxTokens ?? 128
        : gmRetry ? GM_RETRY_MAX_TOKENS : GM_FIRST_ATTEMPT_MAX_TOKENS;
      if (this.#contextPerSlot !== undefined && counted.value.inputTokens + outputTokens > this.#contextPerSlot) {
        return this.#error('CONTEXT_LIMIT', 'COUNT_TOKENS', attemptOptions, false, [
          `slot:context_per_slot:${this.#contextPerSlot}`, `input_tokens:${counted.value.inputTokens}`, `output_tokens:${outputTokens}`
        ]);
      }
      if (policy.maxContextTokens !== undefined && counted.value.inputTokens > policy.maxContextTokens) {
        return this.#error('CONTEXT_LIMIT', 'COUNT_TOKENS', attemptOptions, false, [
          `budget:max_context_tokens:${policy.maxContextTokens}`,
          `input_tokens:${counted.value.inputTokens}`
        ]);
      }
      const pressure = classifyContextPressure(counted.value.inputTokens);
      if (pressure.blocksExpansion) {
        return this.#error('CONTEXT_LIMIT', 'COUNT_TOKENS', attemptOptions, false, [
          `pressure:${pressure.state}`,
          `input_tokens:${pressure.inputTokens}`
        ]);
      }
      const completionOptions = remaining(attemptOptions);
      if (deadline !== undefined && completionOptions.timeoutMs <= 0) return this.#error('TIMEOUT', operation, attemptOptions, false);
      const response = await this.#requestJson(operation, '/v1/chat/completions', completionOptions, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.#modelId,
          id_slot: policy.slot,
          seed: deterministicRequestSeed(attemptOptions.correlationId),
          cache_prompt: true,
          stream: false,
          ...(operation === 'WORKER' ? {
            temperature: options.workerAttempt === 1 ? 0.1 : 0.25,
            top_p: options.workerAttempt === 1 ? 0.9 : 0.95,
            repeat_penalty: 1,
            max_tokens: policy.maxTokens ?? 128
          } : {
            temperature: gmRetry ? 0.1 : 0.75,
            top_p: gmRetry ? 0.9 : 0.95,
            repeat_penalty: 1,
            max_tokens: gmRetry ? GM_RETRY_MAX_TOKENS : GM_FIRST_ATTEMPT_MAX_TOKENS
          }),
          chat_template_kwargs: { enable_thinking: false },
          messages: attemptMessages,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: contract,
              strict: true,
              schema: policy.generationSchema ?? runtimeContractSchema(contract)
            }
          }
        })
      });
      if (!response.ok) {
        if (attempt === 0 && operation !== 'WORKER' && response.error.code === 'TIMEOUT') continue;
        return response;
      }
      const body = response.value as ChatCompletionResponse;
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string') return this.#error('INVALID_RESPONSE', operation, options, false);
      let value: unknown;
      try {
        value = JSON.parse(content) as unknown;
      } catch {
        if (attempt === 0 && operation !== 'WORKER') continue;
        return this.#error('INVALID_JSON', operation, options, true);
      }
      const validation = validateRuntimeContract(contract, value);
      if (!validation.ok) {
        if (attempt === 0 && operation !== 'WORKER') continue;
        return this.#error('SCHEMA_INVALID', operation, options, true, validation.errors);
      }
      if (policy.generationSchema !== undefined) {
        const generationValidation = validateJsonSchema(policy.generationSchema, value);
        if (!generationValidation.ok) {
          if (attempt === 0 && operation !== 'WORKER') continue;
          return this.#error('SCHEMA_INVALID', operation, options, true, generationValidation.errors);
        }
      }
      if (contract === 'TurnPlan') {
        const planned = value as SotTurnPlan.TurnPlan;
        const semantic = validateTurnPlanSemantics(planned, {
          turnId: planned.turn_id, baseStateVersion: planned.base_state_version
        });
        if (!semantic.ok) {
          semanticFeedback = '\nCorrige las dependencias y bloqueos de PLAN: sin autociclos ni IDs desconocidos; ' +
            'blocking_job_ids contiene exactamente los trabajos blocking=true. Usa DIRECT si no necesitas delegar. ' +
            'Nunca delegues ROLL_RESULT: sólo Dice Engine tira dados mediante RESOLVE AWAITING_ROLL, no los workers.';
          if (attempt === 0) continue;
          return this.#error('SCHEMA_INVALID', operation, options, false, semantic.errors);
        }
      }
      if (contract === 'NarrationProposal' && !balancedDialogue((value as DesignNarrationProposalV1.NarrationProposalV1).narration)) {
        semanticFeedback = '\nCierra correctamente las comillas del diálogo, sin cierres sobrantes. No añadas hechos ni efectos.';
        if (attempt === 0) continue;
        return this.#error('SCHEMA_INVALID', operation, options, false, ['/narration:unbalanced-quotes']);
      }
      if (contract === 'TurnResolution') {
        const resolution = value as SotTurnResolution.TurnResolution;
        if (resolution.resolution_status === 'READY' && !balancedDialogue(resolution.player_facing_narration)) {
          semanticFeedback = '\nCorrige sólo el cierre de comillas del diálogo: cada « tiene un » y cada “ tiene un ”, ' +
            'sin cierres sobrantes. No añadas comillas externas a la narración. Conserva la acción y los hechos confirmados.';
          if (attempt === 0) continue;
          return this.#error('SCHEMA_INVALID', operation, options, false, ['/player_facing_narration:unbalanced-quotes']);
        }
        const repeated = resolution.required_rolls.some(request =>
          policy.completedRolls?.some(roll => roll.roll_id === request['roll_id']));
        if (repeated) {
          semanticFeedback = '\nLas tiradas presentes en deterministic_rolls YA están resueltas por el Dice Engine. ' +
            'Usa sus resultados; no vuelvas a solicitar esos roll_id. Solicita sólo una nueva tirada necesaria ' +
            '(por ejemplo daño tras impacto), o devuelve READY si ya puedes resolver, o BLOCKED si no puedes.';
          if (attempt === 0) continue;
          return this.#error('SCHEMA_INVALID', operation, options, false, ['/required_rolls:already-resolved']);
        }
      }
      if (deadline !== undefined && performance.now() >= deadline) return this.#error('TIMEOUT', operation, attemptOptions, false);
      return { ok: true, value: value as T };
    }
    return this.#error('INVALID_RESPONSE', operation, options, false);
  }

  #validateInput(
    operation: LlmOperation,
    contract: RuntimeContractName,
    value: unknown,
    options: LlmRequestOptions
  ): LlmGatewayResult<never> | { readonly ok: true } {
    const validation = validateRuntimeContract(contract, value);
    if (validation.ok) return validation;
    return this.#error('INVALID_INPUT', operation, options, false, validation.errors);
  }

  #acquireWorkerSlot(): number | undefined {
    for (const slot of [1, 2]) {
      if (this.#workerSlotsInUse.has(slot)) continue;
      this.#workerSlotsInUse.add(slot);
      return slot;
    }
    return undefined;
  }

  async #requestJson(
    operation: LlmOperation,
    path: string,
    options: LlmRequestOptions,
    init: RequestInit
  ): Promise<LlmGatewayResult<unknown>> {
    const startedAt = Date.now();
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.correlationId.length === 0) {
      return this.#error('INVALID_INPUT', operation, options, false);
    }
    if (this.#pending.has(options.correlationId)) {
      return this.#error('CORRELATION_CONFLICT', operation, options, false);
    }
    const pending: PendingHttpRequest = {
      operation,
      controller: new AbortController(),
      cancelled: false,
      timedOut: false
    };
    this.#pending.set(options.correlationId, pending);
    const timeout = setTimeout(() => {
      pending.timedOut = true;
      pending.controller.abort();
    }, options.timeoutMs);
    try {
      const response = await this.#fetch(`${this.#origin}${path}`, { ...init, signal: pending.controller.signal });
      if (!response.ok) return this.#error('HTTP_ERROR', operation, options, true, [`status:${response.status}`]);
      try {
        const result = { ok: true as const, value: await response.json() as unknown };
        this.#recordOutcome(operation, options, 'OK', 'PASS', Date.now() - startedAt);
        return result;
      } catch {
        return this.#error('INVALID_RESPONSE', operation, options, false, ['body:not-json']);
      }
    } catch {
      if (pending.cancelled) return this.#error('CANCELLED', operation, options, false);
      if (pending.timedOut) return this.#error('TIMEOUT', operation, options, true);
      return this.#error('HTTP_ERROR', operation, options, true, ['network-failure']);
    } finally {
      clearTimeout(timeout);
      this.#pending.delete(options.correlationId);
    }
  }

  #error(
    code: LlmGatewayError['code'],
    operation: LlmOperation,
    options: LlmRequestOptions,
    retryable: boolean,
    details?: readonly string[]
  ): LlmGatewayResult<never> {
    this.#recordOutcome(operation, options, code, 'FAIL');
    return {
      ok: false,
      error: {
        code,
        operation,
        correlationId: options.correlationId,
        retryable,
        ...(details === undefined ? {} : { details })
      }
    };
  }

  #recordOutcome(
    operation: LlmOperation,
    options: LlmRequestOptions,
    code: string,
    status: 'PASS' | 'FAIL',
    elapsedMs?: number
  ): void {
    try {
      this.#observability?.record({
        correlationId: options.correlationId,
        component: 'runtime',
        operation,
        code,
        status,
        ...(elapsedMs === undefined ? {} : { metrics: { elapsed_ms: elapsedMs } })
      });
    } catch {
      // El gateway conserva su resultado aunque falle la telemetría local.
    }
  }
}
