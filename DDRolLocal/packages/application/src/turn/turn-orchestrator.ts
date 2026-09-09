import type {
  DesignTurnEnvelope,
  SotRpgjobCard,
  SotRpgworkerResult,
  SotTurnPlan,
  SotTurnResolution
} from '@nyx/contracts';
import type { OperationalLogger } from '@nyx/observability';
import { validateRuntimeContract, type CampaignTurnProfile } from '@nyx/contracts';
import type { LlmGateway, LlmGatewayError, LlmRequestOptions } from '../ports/llm-gateway.js';
import { validateTurnContextPacket, type TurnContextPacket, type TurnContextPort } from '../context/c3-context-packet.js';
import { buildC5WorkerResultPacket, validateC5WorkerResultPacket } from '../context/c5-worker-result-packet.js';
import { validateTurnPlanSemantics } from './turn-plan-semantics.js';
import { advanceMechanicalAction, validateMechanicalCandidate, type TurnMechanicalPort } from './mechanical-action.js';
import { parseGuidedTurnIntent } from './guided-intent.js';

export type TurnPortResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: TurnPortError };

export interface TurnPortError {
  code: string;
  message: string;
  details?: readonly string[];
}

export interface StateCommitCandidate {
  campaignId: string;
  turnId: string;
  baseStateVersion: number;
  plan: SotTurnPlan.TurnPlan;
  resolution: SotTurnResolution.TurnResolution;
}

export interface StateTransactionPort {
  commitCandidate(input: StateCommitCandidate): Promise<TurnPortResult<{ committedStateVersion: number }>>;
}

export interface TurnWorkerPort {
  beginTurn(context: TurnExecutionContext): Promise<TurnPortResult<void>>;
  executeForeground(
    jobs: readonly SotRpgjobCard.RPGJobCard[],
    context: TurnExecutionContext
  ): Promise<TurnPortResult<readonly SotRpgworkerResult.RPGWorkerResult[]>>;
  executeAwaited(
    resolution: SotTurnResolution.TurnResolution,
    context: TurnExecutionContext
  ): Promise<TurnPortResult<readonly SotRpgworkerResult.RPGWorkerResult[]>>;
  schedulePostResponse(
    jobs: readonly SotRpgjobCard.RPGJobCard[],
    context: TurnExecutionContext
  ): Promise<TurnPortResult<void>>;
}

export interface TurnDicePort {
  rollRequired(
    requests: readonly Record<string, unknown>[],
    context: TurnExecutionContext
  ): Promise<TurnPortResult<readonly DesignTurnEnvelope.RollRef[]>>;
}

export interface TurnExecutionContext {
  campaignId: string;
  turnId: string;
  baseStateVersion: number;
}

export interface RunTurnInput extends TurnExecutionContext {
  playerInput: string;
  contextRefs: readonly DesignTurnEnvelope.ContentRef[];
  language: string;
}

export type TurnTransition =
  | 'WAIT_PLAYER'
  | 'INGEST'
  | 'TOKEN_COUNT'
  | 'BUILD_CONTEXT'
  | 'GM_PLAN'
  | 'BUILD_QUEUE'
  | 'DISPATCH'
  | 'AWAIT_P0'
  | 'INTEGRATE_RESULTS'
  | 'GM_RESOLVE'
  | 'GM_NARRATE'
  | 'AWAIT_ROLL'
  | 'DETERMINISTIC_ROLLS'
  | 'AWAIT_WORKER'
  | 'STATE_TRANSACTION'
  | 'REPLAN'
  | 'SEND_PLAYER'
  | 'POST_RESPONSE_QUEUE'
  | 'MEMORY_GATE'
  | 'CHECKPOINT_GATE';

export interface CommittedTurn {
  status: 'COMMITTED';
  narration: string;
  committedStateVersion: number;
  transitions: readonly TurnTransition[];
  warnings?: readonly { readonly code: string; readonly message: string }[];
}

export interface BlockedTurn {
  status: 'BLOCKED';
  code: string;
  message: string;
  transitions: readonly TurnTransition[];
}

export type TurnOutcome = CommittedTurn | BlockedTurn;

export interface TurnOrchestratorDependencies {
  /** Existing embedded harnesses may supply their own policy; local composition always binds this port. */
  mechanics?: TurnMechanicalPort;
  observability?: OperationalLogger;
  gateway: LlmGateway;
  context: TurnContextPort;
  state: StateTransactionPort;
  workers: TurnWorkerPort;
  dice: TurnDicePort;
}

export interface TurnOrchestratorOptions {
  maxResolveCycles: number;
  maxReplans: number;
  requestTimeoutMs?: number;
  /** Trusted composition selects from the persisted campaign manifest, never player input. */
  profile?: CampaignTurnProfile;
}

function requestOptions(input: RunTurnInput, phase: string, sequence: number, timeoutMs: number): LlmRequestOptions {
  return {
    correlationId: `${input.turnId}-${phase}-${sequence}`,
    timeoutMs
  };
}

function llmMessage(error: LlmGatewayError): string {
  return `LlmGateway ${error.operation} falló con ${error.code}.`;
}

function isSafeIntegerAtLeast(value: number, minimum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum;
}

/** [DESIGN] Conservative beta guard for literal NdS requests, not a natural-language rules parser.
 * Only the first explicit expression is mandatory here; later dice may be conditional (e.g. damage).
 * A quoted/ambiguous expression may block for clarification; this never executes dice on its own.
 */
export function pendingExplicitDiceExpression(playerInput: unknown, rolls: readonly DesignTurnEnvelope.RollRef[]): string | undefined {
  if (typeof playerInput !== 'string') return undefined;
  const expression = /\b[1-9]\d*d[1-9]\d*(?:[+-]\d+)?(?=$|[ \t\r\n,.;:!?)»”"'])(?![ \t\r\n]*[+-])/iu.exec(playerInput)?.[0].toLowerCase();
  return expression !== undefined && !rolls.some(roll => roll.expression === expression) ? expression : undefined;
}

export class TurnOrchestrator {
  readonly #dependencies: TurnOrchestratorDependencies;
  readonly #options: TurnOrchestratorOptions;

  constructor(dependencies: TurnOrchestratorDependencies, options: TurnOrchestratorOptions) {
    if (
      !isSafeIntegerAtLeast(options.maxResolveCycles, 1) ||
      !isSafeIntegerAtLeast(options.maxReplans, 0) ||
      (options.requestTimeoutMs !== undefined && !isSafeIntegerAtLeast(options.requestTimeoutMs, 1)) ||
      (options.profile !== undefined && !['ASSISTED_ALPHA', 'AUTOMATIC_EXPERIMENTAL'].includes(options.profile))
    ) {
      throw new RangeError('Los límites del orquestador deben ser enteros seguros y no negativos.');
    }
    this.#dependencies = dependencies;
    this.#options = options;
  }

  async runTurn(input: RunTurnInput): Promise<TurnOutcome> {
    const transitions: TurnTransition[] = ['WAIT_PLAYER', 'INGEST', 'BUILD_CONTEXT'];
    // A no-action result is still a prepared boundary required by the shared commit port.
    const prepared = await this.#dependencies.mechanics?.prepare(input);
    if (prepared !== undefined && !prepared.ok) return this.#blocked(prepared.error.code, prepared.error.message, transitions);
    const mechanicalAction = prepared?.value;
    const context: TurnExecutionContext = {
      campaignId: input.campaignId,
      turnId: input.turnId,
      baseStateVersion: input.baseStateVersion
    };
    const beganTurn = await this.#dependencies.workers.beginTurn(context);
    if (!beganTurn.ok) return this.#blocked(beganTurn.error.code, beganTurn.error.message, transitions);
    const builtContext = await this.#dependencies.context.build({
      campaignId: input.campaignId,
      turnId: input.turnId,
      baseStateVersion: input.baseStateVersion,
      requestedRefs: input.contextRefs,
      language: input.language,
      playerMessage: input.playerInput
    });
    if (!builtContext.ok) {
      return this.#blocked(builtContext.error.code, builtContext.error.message, transitions);
    }
    const contextPacket = builtContext.value;
    const contextErrors = validateTurnContextPacket(contextPacket, {
      campaignId: input.campaignId,
      baseStateVersion: input.baseStateVersion
    });
    if (contextErrors.length > 0) {
      return this.#blocked('CONTEXT_PACKET_INVALID', `Context packet inválido: ${contextErrors.join(', ')}.`, transitions);
    }
    const planEnvelope: DesignTurnEnvelope.TurnEnvelopeV1 = {
      schema_version: '1.0',
      campaign_id: input.campaignId,
      turn_id: input.turnId,
      phase: 'PLAN',
      base_state_version: input.baseStateVersion,
      player_input: input.playerInput,
      context_refs: [...contextPacket.context_refs],
      worker_results: [],
      deterministic_rolls: [],
      language: input.language
    };
    if (this.#options.profile === 'ASSISTED_ALPHA') {
      return this.#runAssistedTurn(input, planEnvelope, contextPacket, transitions);
    }
    transitions.push('TOKEN_COUNT');
    let replans = 0;
    let candidateRejection: LlmRequestOptions['candidateRejection'];
    let resolveCycles = 0;
    const deterministicRolls: DesignTurnEnvelope.RollRef[] = [];
    while (true) {
      transitions.push('GM_PLAN');
      const planned = await this.#dependencies.gateway.plan(
        planEnvelope,
        { ...requestOptions(input, 'PLAN', replans, this.#options.requestTimeoutMs ?? 30_000),
          ...(candidateRejection === undefined ? {} : { candidateRejection }) },
        contextPacket
      );
      if (!planned.ok) return this.#blocked(`LLM_${planned.error.code}`, llmMessage(planned.error), transitions);
      const plan = planned.value;
      const semantic = validateTurnPlanSemantics(plan, {
        turnId: input.turnId,
        baseStateVersion: input.baseStateVersion
      });
      if (!semantic.ok) {
        return this.#blocked('PLAN_SEMANTIC_INVALID', `TurnPlan semánticamente inválido: ${semantic.errors.join(', ')}.`, transitions);
      }
      if (!plan.safety.player_agency_preserved) {
        return this.#blocked('PLAYER_AGENCY_VIOLATION', 'TurnPlan no preserva la agencia del jugador.', transitions);
      }
      if (!plan.safety.secret_boundaries_preserved) {
        return this.#blocked('SECRET_BOUNDARY_VIOLATION', 'TurnPlan no preserva los límites de secretos.', transitions);
      }
      if (plan.decision === 'ASK_CLARIFICATION') {
        return this.#blocked('PLAN_ASK_CLARIFICATION', 'TurnPlan requiere aclaración del jugador antes de resolver.', transitions);
      }
      if (plan.decision === 'BLOCKED') {
        return this.#blocked('PLAN_BLOCKED', 'TurnPlan bloqueó el turno antes de resolver.', transitions);
      }

      transitions.push('BUILD_QUEUE', 'DISPATCH', 'AWAIT_P0');
      const foregroundJobs = plan.jobs.filter(candidate => candidate.priority === 'P0' || candidate.priority === 'P1');
      const foreground = await this.#dependencies.workers.executeForeground(foregroundJobs, context);
      if (!foreground.ok) return this.#blocked(foreground.error.code, foreground.error.message, transitions);
      const workerResults: SotRpgworkerResult.RPGWorkerResult[] = [...foreground.value];
      transitions.push('INTEGRATE_RESULTS');

      while (true) {
        resolveCycles += 1;
        if (resolveCycles > this.#options.maxResolveCycles) {
          return this.#blocked('RESOLVE_CYCLE_EXHAUSTED', 'RESOLVE excedió el límite seguro de ciclos.', transitions);
        }
        transitions.push('GM_RESOLVE');
        const workerResultPacket = buildC5WorkerResultPacket(workerResults);
        const resolveEnvelope: DesignTurnEnvelope.TurnEnvelopeV1 = {
          ...planEnvelope,
          phase: 'RESOLVE',
          player_input: null,
          worker_results: [...workerResultPacket.result_refs],
          deterministic_rolls: [...deterministicRolls]
        };
        const workerPacketErrors = validateC5WorkerResultPacket(resolveEnvelope, workerResultPacket);
        if (workerPacketErrors.length > 0) {
          return this.#blocked(
            'WORKER_RESULT_PACKET_INVALID',
            `Worker result packet inválido: ${workerPacketErrors.join(', ')}.`,
            transitions
          );
        }
        const advanced = mechanicalAction == null ? undefined : advanceMechanicalAction(mechanicalAction, deterministicRolls);
        if (advanced !== undefined && !advanced.ok) return this.#blocked(advanced.error.code, advanced.error.message, transitions);
        const mechanicalFrame = advanced?.value ?? mechanicalAction;
        const resolved = await this.#dependencies.gateway.resolve(
          resolveEnvelope,
          { ...requestOptions(input, 'RESOLVE', resolveCycles, this.#options.requestTimeoutMs ?? 30_000),
            turnPlan: plan,
            ...(candidateRejection === undefined ? {} : { candidateRejection }),
            ...(mechanicalFrame === undefined ? {} : { mechanicalAction: mechanicalFrame }) },
          contextPacket,
          workerResultPacket
        );
        if (!resolved.ok) return this.#blocked(`LLM_${resolved.error.code}`, llmMessage(resolved.error), transitions);
        const candidate = resolved.value;
        if (candidate.turn_id !== input.turnId || candidate.base_state_version !== input.baseStateVersion) {
          return this.#blocked('RESOLUTION_IDENTITY_MISMATCH', 'TurnResolution no coincide con el turno o estado base.', transitions);
        }
        if (mechanicalFrame !== undefined) {
          const allowed = validateMechanicalCandidate(mechanicalFrame, candidate);
          if (!allowed.ok) return this.#blocked(allowed.error.code, allowed.error.message, transitions);
        }

        if (candidate.resolution_status === 'AWAITING_ROLL') {
          transitions.push('AWAIT_ROLL');
          if (candidate.required_rolls.length === 0) {
            return this.#blocked('ROLL_REQUEST_MISSING', 'AWAITING_ROLL no contiene tiradas requeridas.', transitions);
          }
          transitions.push('DETERMINISTIC_ROLLS');
          const rolled = await this.#dependencies.dice.rollRequired(candidate.required_rolls, context);
          if (!rolled.ok) return this.#blocked(rolled.error.code, rolled.error.message, transitions);
          for (const ref of rolled.value) {
            if (!deterministicRolls.some(existing => existing.roll_id === ref.roll_id)) deterministicRolls.push(ref);
          }
          continue;
        }

        if (candidate.resolution_status === 'AWAITING_WORKER') {
          transitions.push('AWAIT_WORKER', 'DISPATCH');
          const awaited = await this.#dependencies.workers.executeAwaited(candidate, context);
          if (!awaited.ok) return this.#blocked(awaited.error.code, awaited.error.message, transitions);
          if (awaited.value.length === 0) {
            return this.#blocked('WORKER_RESULT_MISSING', 'AWAITING_WORKER no produjo ningún resultado confirmado.', transitions);
          }
          workerResults.push(...awaited.value);
          transitions.push('INTEGRATE_RESULTS');
          continue;
        }

        if (candidate.resolution_status === 'BLOCKED') {
          return this.#blocked('RESOLUTION_BLOCKED', 'GM_RESOLVE bloqueó el turno sin confirmar cambios.', transitions);
        }

        if (mechanicalAction == null && pendingExplicitDiceExpression(input.playerInput, deterministicRolls) !== undefined) {
          return this.#blocked('EXPLICIT_DICE_UNRESOLVED',
            'La expresión de dados explícita no tiene una tirada del motor en este turno; requiere resolución o aclaración.', transitions);
        }
        transitions.push('STATE_TRANSACTION');
        const committed = await this.#dependencies.state.commitCandidate({
          campaignId: input.campaignId,
          turnId: input.turnId,
          baseStateVersion: input.baseStateVersion,
          plan,
          resolution: candidate
        });
        if (!committed.ok) {
          this.#dependencies.observability?.record({ correlationId: `${input.turnId}-STATE-${replans}`,
            component: 'turn', operation: 'candidate.reject', code: committed.error.code, status: 'REJECTED',
            campaignId: input.campaignId, turnId: input.turnId, stateVersion: input.baseStateVersion,
            retryCount: replans });
          if (replans >= this.#options.maxReplans) {
            return this.#blocked('REPLAN_EXHAUSTED', committed.error.message, transitions);
          }
          replans += 1;
          candidateRejection = committed.error.code.startsWith('KNOWLEDGE_')
            ? 'KNOWLEDGE_REJECTED' : 'STATE_REJECTED';
          transitions.push('REPLAN');
          break;
        }

        transitions.push('SEND_PLAYER', 'POST_RESPONSE_QUEUE');
        const postResponse = await this.#dependencies.workers.schedulePostResponse(plan.jobs, {
          ...context,
          baseStateVersion: committed.value.committedStateVersion
        });
        transitions.push('MEMORY_GATE', 'CHECKPOINT_GATE', 'WAIT_PLAYER');
        return {
          status: 'COMMITTED',
          narration: candidate.player_facing_narration,
          committedStateVersion: committed.value.committedStateVersion,
          transitions,
          ...(postResponse.ok
            ? {}
            : { warnings: [{ code: postResponse.error.code, message: postResponse.error.message }] })
        };
      }
    }
  }

  async #runAssistedTurn(
    input: RunTurnInput,
    envelope: DesignTurnEnvelope.TurnEnvelopeV1,
    contextPacket: TurnContextPacket,
    transitions: TurnTransition[]
  ): Promise<TurnOutcome> {
    const parsed = parseGuidedTurnIntent(input.playerInput);
    if (!parsed.ok) return this.#blocked(parsed.error.code, parsed.error.message, transitions);
    if (parsed.value.kind !== 'conversation' && (!['travel', 'action'].includes(parsed.value.kind)
      || this.#dependencies.mechanics?.resolveAssistedMechanic === undefined)) {
      return this.#blocked('GUIDED_CAPABILITY_UNAVAILABLE', 'La operación seleccionada no está habilitada en este flujo asistido.', transitions);
    }
    const gateway = this.#dependencies.gateway;
    if (parsed.value.kind === 'conversation' && gateway.narrate === undefined) {
      return this.#blocked('ASSISTED_NARRATION_UNAVAILABLE', 'El gateway no ofrece narración asistida; no se utilizará el GM automático.', transitions);
    }
    let narration: string;
    if (parsed.value.kind === 'conversation') {
      transitions.push('TOKEN_COUNT', 'GM_NARRATE');
      const proposal = await gateway.narrate!(envelope,
        requestOptions(input, 'NARRATE', 0, this.#options.requestTimeoutMs ?? 30_000), contextPacket);
      if (!proposal.ok) return this.#blocked(`LLM_${proposal.error.code}`, llmMessage(proposal.error), transitions);
      if (!validateRuntimeContract('NarrationProposal', proposal.value).ok) {
        return this.#blocked('NARRATION_PROPOSAL_INVALID', 'La propuesta no contiene exclusivamente una narración válida.', transitions);
      }
      narration = proposal.value.narration;
    } else {
      const receipt = await this.#dependencies.mechanics!.resolveAssistedMechanic!(input);
      if (!receipt.ok) return this.#blocked(receipt.error.code, receipt.error.message, transitions);
      narration = receipt.value.narration;
    }
    // Code owns administrative fields. These flags describe the enforced explicit-effects policy,
    // not a claim that free prose has passed human agency/quality acceptance.
    const plan: SotTurnPlan.TurnPlan = {
      schema_version: '1.0', turn_id: input.turnId, base_state_version: input.baseStateVersion,
      player_intent: { declared_action: input.playerInput, target: null, desired_outcome: null, ambiguities: [] },
      decision: 'DIRECT', jobs: [], blocking_job_ids: [], preconditions: [],
      safety: { player_agency_preserved: true, secret_boundaries_preserved: true }
    };
    const resolution: SotTurnResolution.TurnResolution = {
      schema_version: '1.0', turn_id: input.turnId, base_state_version: input.baseStateVersion,
      resolution_status: 'READY', required_rolls: [], events_to_commit: [], patches_to_commit: [],
      player_facing_narration: narration, open_threads: [], memory_signals: [],
      checkpoint_recommended: false
    };
    if (!validateRuntimeContract('TurnPlan', plan).ok || !validateRuntimeContract('TurnResolution', resolution).ok) {
      return this.#blocked('ASSISTED_CANDIDATE_INVALID', 'El código no pudo construir un candidato compatible.', transitions);
    }
    transitions.push('STATE_TRANSACTION');
    const committed = await this.#dependencies.state.commitCandidate({
      campaignId: input.campaignId, turnId: input.turnId, baseStateVersion: input.baseStateVersion, plan, resolution
    });
    if (!committed.ok) return this.#blocked(committed.error.code, committed.error.message, transitions);
    transitions.push('SEND_PLAYER', 'MEMORY_GATE', 'CHECKPOINT_GATE', 'WAIT_PLAYER');
    return { status: 'COMMITTED', narration: resolution.player_facing_narration,
      committedStateVersion: committed.value.committedStateVersion, transitions };
  }

  #blocked(code: string, message: string, transitions: readonly TurnTransition[]): BlockedTurn {
    return { status: 'BLOCKED', code, message, transitions: [...transitions, 'WAIT_PLAYER'] };
  }
}
