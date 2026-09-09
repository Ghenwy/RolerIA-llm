import type {
  DesignTurnEnvelope,
  SotRpgjobCard,
  SotRpgworkerResult,
  SotTurnPlan,
  SotTurnResolution,
  SotCompactionProposal,
  DesignNarrationProposalV1
} from '@nyx/contracts';
import type { MechanicalAction } from '../turn/mechanical-action.js';
import type { TurnContextPacket } from '../context/c3-context-packet.js';
import type { C5WorkerResultPacket } from '../context/c5-worker-result-packet.js';

export type LlmOperation = 'HEALTH' | 'MODELS' | 'COUNT_TOKENS' | 'PLAN' | 'RESOLVE' | 'WORKER' | 'NARRATE';

export type LlmGatewayErrorCode =
  | 'CAPACITY_EXHAUSTED'
  | 'CANCELLED'
  | 'CORRELATION_CONFLICT'
  | 'CONTEXT_LIMIT'
  | 'INVALID_INPUT'
  | 'INVALID_JSON'
  | 'INVALID_RESPONSE'
  | 'HTTP_ERROR'
  | 'NO_SCRIPT'
  | 'RUNTIME_UNHEALTHY'
  | 'SCHEMA_INVALID'
  | 'TIMEOUT';

export interface LlmRequestOptions {
  correlationId: string;
  timeoutMs: number;
  workerAttempt?: 0 | 1;
  mechanicalAction?: MechanicalAction | null;
  /** Safe, finite feedback only; never forward StatePort messages or rejected payloads. */
  candidateRejection?: 'KNOWLEDGE_REJECTED' | 'STATE_REJECTED';
  turnPlan?: SotTurnPlan.TurnPlan;
}

export interface LlmGatewayError {
  code: LlmGatewayErrorCode;
  operation: LlmOperation;
  correlationId: string;
  retryable: boolean;
  details?: readonly string[];
}

export type LlmGatewayResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: LlmGatewayError };

export interface LlmHealth {
  status: 'ok';
}

export interface LlmModelCatalog {
  modelIds: readonly string[];
}

export interface LlmTokenCount {
  inputTokens: number;
}

export interface LlmCancellation {
  cancelled: boolean;
}

export interface LlmGateway {
  /** Optional capability: absence blocks the assisted profile, never falls back to automatic PLAN/RESOLVE. */
  narrate?(
    envelope: DesignTurnEnvelope.TurnEnvelopeV1,
    options: LlmRequestOptions,
    contextPacket: TurnContextPacket
  ): Promise<LlmGatewayResult<DesignNarrationProposalV1.NarrationProposalV1>>;
  proposeCompaction(input: unknown, options: LlmRequestOptions): Promise<LlmGatewayResult<SotCompactionProposal.CompactionProposal>>;
  health(options: LlmRequestOptions): Promise<LlmGatewayResult<LlmHealth>>;
  listModels(options: LlmRequestOptions): Promise<LlmGatewayResult<LlmModelCatalog>>;
  countInputTokens(input: unknown, options: LlmRequestOptions): Promise<LlmGatewayResult<LlmTokenCount>>;
  plan(
    envelope: DesignTurnEnvelope.TurnEnvelopeV1,
    options: LlmRequestOptions,
    contextPacket?: TurnContextPacket
  ): Promise<LlmGatewayResult<SotTurnPlan.TurnPlan>>;
  resolve(
    envelope: DesignTurnEnvelope.TurnEnvelopeV1,
    options: LlmRequestOptions,
    contextPacket?: TurnContextPacket,
    workerResultPacket?: C5WorkerResultPacket
  ): Promise<LlmGatewayResult<SotTurnResolution.TurnResolution>>;
  runWorker(
    job: SotRpgjobCard.RPGJobCard,
    context: readonly unknown[],
    options: LlmRequestOptions
  ): Promise<LlmGatewayResult<SotRpgworkerResult.RPGWorkerResult>>;
  cancel(correlationId: string): Promise<LlmGatewayResult<LlmCancellation>>;
}
