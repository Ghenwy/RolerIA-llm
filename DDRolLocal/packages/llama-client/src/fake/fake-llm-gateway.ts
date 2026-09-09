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
import { llmTurnInput, validateC3TurnInput, validateC5WorkerResultBinding } from '@nyx/application';
import {
  validateRuntimeContract,
  type DesignTurnEnvelope,
  type RuntimeContractName,
  type SotRpgjobCard,
  type SotRpgworkerResult,
  type SotTurnPlan,
  type SotTurnResolution,
  type SotCompactionProposal,
  type DesignNarrationProposalV1
} from '@nyx/contracts';
import { balancedDialogue, buildNarrationInput } from '../http/narration-boundary.js';

export type FakeLlmStep =
  | { readonly kind: 'success'; readonly value: unknown }
  | { readonly kind: 'json'; readonly value: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'pending' };

export interface FakeLlmScript {
  readonly narration?: readonly FakeLlmStep[];
  readonly compaction?: readonly FakeLlmStep[];
  readonly plan?: readonly FakeLlmStep[];
  readonly resolve?: readonly FakeLlmStep[];
  readonly worker?: readonly FakeLlmStep[];
  readonly health?: 'ok' | 'unhealthy';
  readonly modelIds?: readonly string[];
  readonly inputTokens?: number;
}

export interface FakeLlmCall {
  readonly operation: LlmOperation;
  readonly correlationId: string;
  readonly payload: unknown;
}

interface PendingRequest {
  readonly operation: LlmOperation;
  readonly finish: (result: LlmGatewayResult<never>) => void;
}

export class FakeLlmGateway implements LlmGateway {
  readonly calls: FakeLlmCall[] = [];
  readonly #plan: FakeLlmStep[];
  readonly #resolve: FakeLlmStep[];
  readonly #worker: FakeLlmStep[];
  readonly #compaction: FakeLlmStep[];
  readonly #narration: FakeLlmStep[];
  readonly #health: 'ok' | 'unhealthy';
  readonly #modelIds: readonly string[];
  readonly #inputTokens: number;
  readonly #pending = new Map<string, PendingRequest>();

  constructor(script: FakeLlmScript = {}) {
    this.#narration = [...(script.narration ?? [])];
    this.#plan = [...(script.plan ?? [])];
    this.#resolve = [...(script.resolve ?? [])];
    this.#worker = [...(script.worker ?? [])];
    this.#compaction = [...(script.compaction ?? [])];
    this.#health = script.health ?? 'ok';
    this.#modelIds = Object.freeze([...(script.modelIds ?? ['fake-nyx-rpg'])]);
    this.#inputTokens = script.inputTokens ?? 321;
    if (!Number.isSafeInteger(this.#inputTokens) || this.#inputTokens < 0) {
      throw new RangeError('inputTokens must be a non-negative safe integer');
    }
  }

  async health(options: LlmRequestOptions): Promise<LlmGatewayResult<LlmHealth>> {
    this.#record('HEALTH', options, null);
    if (this.#health === 'unhealthy') return this.#error('RUNTIME_UNHEALTHY', 'HEALTH', options, true);
    return { ok: true, value: { status: 'ok' } };
  }

  async listModels(options: LlmRequestOptions): Promise<LlmGatewayResult<LlmModelCatalog>> {
    this.#record('MODELS', options, null);
    void options;
    return { ok: true, value: { modelIds: this.#modelIds } };
  }

  async countInputTokens(input: unknown, options: LlmRequestOptions): Promise<LlmGatewayResult<LlmTokenCount>> {
    this.#record('COUNT_TOKENS', options, input);
    return { ok: true, value: { inputTokens: this.#inputTokens } };
  }

  async narrate(
    envelope: DesignTurnEnvelope.TurnEnvelopeV1,
    options: LlmRequestOptions,
    contextPacket: TurnContextPacket
  ): Promise<LlmGatewayResult<DesignNarrationProposalV1.NarrationProposalV1>> {
    const input = buildNarrationInput(envelope, options, contextPacket);
    if (!input.ok) return this.#error('INVALID_INPUT', 'NARRATE', options, false, input.errors);
    this.#record('NARRATE', options, input.value);
    const result = await this.#execute<DesignNarrationProposalV1.NarrationProposalV1>('NARRATE', 'NarrationProposal', this.#narration, options);
    return result.ok && !balancedDialogue(result.value.narration)
      ? this.#error('SCHEMA_INVALID', 'NARRATE', options, false, ['/narration:unbalanced-quotes']) : result;
  }

  async plan(
    envelope: DesignTurnEnvelope.TurnEnvelopeV1,
    options: LlmRequestOptions,
    contextPacket?: TurnContextPacket
  ): Promise<LlmGatewayResult<SotTurnPlan.TurnPlan>> {
    this.#record('PLAN', options, contextPacket === undefined ? envelope : llmTurnInput(envelope, contextPacket));
    const valid = this.#validateInput('PLAN', 'TurnEnvelope', envelope, options);
    if (!valid.ok) return valid;
    if (envelope.phase !== 'PLAN') return this.#error('INVALID_INPUT', 'PLAN', options, false, ['/phase:const']);
    if (contextPacket !== undefined) {
      const contextErrors = validateC3TurnInput(envelope, contextPacket);
      if (contextErrors.length > 0) return this.#error('INVALID_INPUT', 'PLAN', options, false, contextErrors);
    }
    return this.#execute('PLAN', 'TurnPlan', this.#plan, options);
  }

  async resolve(
    envelope: DesignTurnEnvelope.TurnEnvelopeV1,
    options: LlmRequestOptions,
    contextPacket?: TurnContextPacket,
    workerResultPacket?: C5WorkerResultPacket
  ): Promise<LlmGatewayResult<SotTurnResolution.TurnResolution>> {
    this.#record('RESOLVE', options, contextPacket === undefined ? envelope : llmTurnInput(envelope, contextPacket, workerResultPacket));
    const valid = this.#validateInput('RESOLVE', 'TurnEnvelope', envelope, options);
    if (!valid.ok) return valid;
    if (envelope.phase !== 'RESOLVE') return this.#error('INVALID_INPUT', 'RESOLVE', options, false, ['/phase:const']);
    const bindingErrors = validateC5WorkerResultBinding(envelope, workerResultPacket);
    if (bindingErrors.length > 0) return this.#error('INVALID_INPUT', 'RESOLVE', options, false, bindingErrors);
    if (workerResultPacket !== undefined && contextPacket === undefined) {
      return this.#error('INVALID_INPUT', 'RESOLVE', options, false, ['context_packet:required_with_worker_results']);
    }
    if (contextPacket !== undefined) {
      const contextErrors = validateC3TurnInput(envelope, contextPacket);
      if (contextErrors.length > 0) return this.#error('INVALID_INPUT', 'RESOLVE', options, false, contextErrors);
    }
    return this.#execute('RESOLVE', 'TurnResolution', this.#resolve, options);
  }

  async runWorker(
    job: SotRpgjobCard.RPGJobCard,
    _context: readonly unknown[],
    options: LlmRequestOptions
  ): Promise<LlmGatewayResult<SotRpgworkerResult.RPGWorkerResult>> {
    this.#record('WORKER', options, { job, context: _context });
    const valid = this.#validateInput('WORKER', 'RPGJobCard', job, options);
    if (!valid.ok) return valid;
    return this.#execute('WORKER', 'RPGWorkerResult', this.#worker, options);
  }

  async proposeCompaction(input: unknown, options: LlmRequestOptions): Promise<LlmGatewayResult<SotCompactionProposal.CompactionProposal>> {
    this.#record('WORKER', options, { compaction: input });
    return this.#execute('WORKER', 'CompactionProposal', this.#compaction, options);
  }

  async cancel(correlationId: string): Promise<LlmGatewayResult<LlmCancellation>> {
    const pending = this.#pending.get(correlationId);
    if (pending === undefined) return { ok: true, value: { cancelled: false } };
    this.#pending.delete(correlationId);
    pending.finish({
      ok: false,
      error: {
        code: 'CANCELLED',
        operation: pending.operation,
        correlationId,
        retryable: false
      }
    });
    return { ok: true, value: { cancelled: true } };
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

  #record(operation: LlmOperation, options: LlmRequestOptions, payload: unknown): void {
    this.calls.push({
      operation,
      correlationId: options.correlationId,
      payload: structuredClone(payload)
    });
  }

  async #execute<T>(
    operation: LlmOperation,
    contract: RuntimeContractName,
    queue: FakeLlmStep[],
    options: LlmRequestOptions
  ): Promise<LlmGatewayResult<T>> {
    if (this.#pending.has(options.correlationId)) {
      return this.#error('CORRELATION_CONFLICT', operation, options, false);
    }
    const step = queue.shift();
    if (step === undefined) return this.#error('NO_SCRIPT', operation, options, false);
    if (step.kind === 'timeout') return this.#error('TIMEOUT', operation, options, true);
    if (step.kind === 'pending') {
      return new Promise<LlmGatewayResult<T>>(resolve => {
        this.#pending.set(options.correlationId, {
          operation,
          finish: resolve as (result: LlmGatewayResult<never>) => void
        });
      });
    }

    let value: unknown = step.value;
    if (step.kind === 'json') {
      try {
        value = JSON.parse(step.value) as unknown;
      } catch {
        return this.#error('INVALID_JSON', operation, options, true);
      }
    }
    const validation = validateRuntimeContract(contract, value);
    if (!validation.ok) return this.#error('SCHEMA_INVALID', operation, options, true, validation.errors);
    return { ok: true, value: value as T };
  }

  #error(
    code: LlmGatewayError['code'],
    operation: LlmOperation,
    options: LlmRequestOptions,
    retryable: boolean,
    details?: readonly string[]
  ): LlmGatewayResult<never> {
    const error: LlmGatewayError = {
      code,
      operation,
      correlationId: options.correlationId,
      retryable,
      ...(details === undefined ? {} : { details })
    };
    return { ok: false, error };
  }
}
