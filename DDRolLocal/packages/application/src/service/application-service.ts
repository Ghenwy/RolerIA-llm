import type { LlmGateway } from '../ports/llm-gateway.js';
import type { RunTurnInput, TurnOutcome } from '../turn/turn-orchestrator.js';
import type { OperationalLogger } from '@nyx/observability';
import { validateRuntimeContract, type CampaignManifest, type RuntimeProfileName } from '@nyx/contracts';
import type { CampaignRulesPort } from '../ports/rules-adapter.js';
import { parseGuidedTurnIntent } from '../turn/guided-intent.js';

export type ApplicationPortResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export interface RuntimeControlPort {
  status(): Promise<ApplicationPortResult<{ state: 'running' | 'stopped' | 'unhealthy' }>>;
  start(profile?: RuntimeProfileName): Promise<ApplicationPortResult<{ state: 'running' }>>;
  stop(): Promise<ApplicationPortResult<{ state: 'stopped' }>>;
}

export interface CampaignAdministrationPort {
  create(campaignId: string): Promise<ApplicationPortResult<{ campaignId: string; branchId: string }>>;
  open(campaignId: string): Promise<ApplicationPortResult<{ campaignId: string; branchId: string }>>;
  verify(campaignId: string): Promise<ApplicationPortResult<{ campaignId: string; valid: boolean }>>;
  save(campaignId: string): Promise<ApplicationPortResult<{ campaignId: string; checkpointId: string }>>;
  load(checkpointId: string): Promise<ApplicationPortResult<{ checkpointId: string; campaignId: string }>>;
  rollback(checkpointId: string): Promise<ApplicationPortResult<{ checkpointId: string; campaignId: string }>>;
  branch(
    checkpointId: string,
    branchId: string
  ): Promise<ApplicationPortResult<{ checkpointId: string; campaignId: string; branchId: string }>>;
}

export interface FallbackControlPort {
  status(): Promise<ApplicationPortResult<{ available: boolean; active: boolean }>>;
  play(campaignId: string): Promise<ApplicationPortResult<{ available: boolean; active: boolean; campaignId: string }>>;
}

export interface DiagnosticPort {
  inspect(): Promise<ApplicationPortResult<{ checks: readonly { name: string; status: 'PASS' | 'FAIL'; detail: string }[] }>>;
}

export type WorkerOperationalStatus =
  | 'PENDING'
  | 'READY'
  | 'RUNNING'
  | 'COMPLETED'
  | 'PARTIAL'
  | 'BLOCKED'
  | 'FAILED'
  | 'STALE'
  | 'CANCELLED';

export interface WorkerQueueReadModel {
  readonly campaignId: string;
  readonly stateVersion: number;
  readonly queuedJobs: number;
  readonly statusCounts: Readonly<Partial<Record<WorkerOperationalStatus, number>>>;
  readonly failures: readonly {
    readonly jobId: string;
    readonly priority: 'P2' | 'P3';
    readonly status: Exclude<WorkerOperationalStatus, 'PENDING' | 'READY' | 'RUNNING' | 'COMPLETED'>;
    readonly reasonCode: string;
    readonly retryEligible: boolean;
  }[];
  readonly lastCheckpointId: string | null;
}

export interface WorkerOperationsPort {
  status(campaignId: string): Promise<ApplicationPortResult<WorkerQueueReadModel>>;
}

export interface TurnRunnerPort {
  runTurn(input: RunTurnInput): Promise<TurnOutcome>;
  releasePostResponse(): void;
}

export interface ApplicationDependencies {
  gateway: LlmGateway;
  turns: TurnRunnerPort;
  runtime: RuntimeControlPort;
  campaigns: CampaignAdministrationPort;
  fallback: FallbackControlPort;
  diagnostics?: DiagnosticPort;
  workers?: WorkerOperationsPort;
  rules?: CampaignRulesPort;
  observability?: OperationalLogger;
}

export type ApplicationCommand =
  | { readonly kind: 'rules'; readonly action: 'resolve' | 'validate-character' | 'validate-prestige' | 'validate-race'; readonly campaignId: string; readonly input: unknown }
  | { readonly kind: 'doctor' }
  | { readonly kind: 'runtime'; readonly action: 'status' | 'start' | 'stop'; readonly profile?: RuntimeProfileName }
  | { readonly kind: 'campaign'; readonly action: 'create' | 'open'; readonly campaignId: string }
  | { readonly kind: 'play'; readonly input: RunTurnInput }
  | { readonly kind: 'verify'; readonly campaignId: string }
  | { readonly kind: 'save'; readonly campaignId: string }
  | { readonly kind: 'load'; readonly checkpointId: string }
  | { readonly kind: 'rollback'; readonly checkpointId: string }
  | { readonly kind: 'branch'; readonly checkpointId: string; readonly branchId: string }
  | { readonly kind: 'fallback'; readonly action: 'status' }
  | { readonly kind: 'fallback'; readonly action: 'play'; readonly campaignId: string }
  | { readonly kind: 'operator'; readonly campaignId: string };

export interface ApplicationResponse {
  readonly ok: boolean;
  readonly code: string;
  readonly message: string;
  readonly data?: unknown;
}

export interface ApplicationCommandHandler {
  execute(command: ApplicationCommand): Promise<ApplicationResponse>;
}

export interface NyxApplicationServiceOptions {
  readonly requiredModelId?: string;
}

function portResponse<T>(
  result: ApplicationPortResult<T>,
  successCode: string,
  successMessage: string
): ApplicationResponse {
  if (!result.ok) return { ok: false, code: result.error.code, message: result.error.message };
  return { ok: true, code: successCode, message: successMessage, data: result.value };
}

export class NyxApplicationService implements ApplicationCommandHandler {
  readonly #dependencies: ApplicationDependencies;
  readonly #options: NyxApplicationServiceOptions;

  constructor(dependencies: ApplicationDependencies, options: NyxApplicationServiceOptions = {}) {
    this.#dependencies = dependencies;
    this.#options = options;
  }

  async execute(command: ApplicationCommand): Promise<ApplicationResponse> {
    let response: ApplicationResponse;
    try {
      response = await this.#executeCommand(command);
    } catch {
      response = {
        ok: false,
        code: 'APPLICATION_ADAPTER_FAILURE',
        message: 'La operación local falló de forma segura; no se confirmó ningún cambio.'
      };
    }
    this.#observe(command, response);
    try {
      await this.#dependencies.observability?.flush?.();
    } catch {
      // El vaciado del log no cambia una respuesta canónica ya calculada.
    }
    return response;
  }

  async #executeCommand(command: ApplicationCommand): Promise<ApplicationResponse> {
    switch (command.kind) {
      case 'rules':
        return await this.#rules(command);
      case 'doctor':
        return await this.#doctor();
      case 'runtime':
        return await this.#runtime(command.action, command.profile);
      case 'campaign':
        return await this.#campaign(command.action, command.campaignId);
      case 'play':
        return await this.#play(command.input);
      case 'verify':
        return portResponse(await this.#dependencies.campaigns.verify(command.campaignId), 'CAMPAIGN_VERIFIED', 'Campaña verificada.');
      case 'save':
        return portResponse(await this.#dependencies.campaigns.save(command.campaignId), 'CHECKPOINT_SAVED', 'Checkpoint creado.');
      case 'load':
        return portResponse(await this.#dependencies.campaigns.load(command.checkpointId), 'CHECKPOINT_LOADED', 'Checkpoint cargado.');
      case 'rollback':
        return portResponse(await this.#dependencies.campaigns.rollback(command.checkpointId), 'ROLLBACK_CREATED', 'Rollback registrado.');
      case 'branch':
        return portResponse(
          await this.#dependencies.campaigns.branch(command.checkpointId, command.branchId),
          'BRANCH_CREATED',
          'Rama creada.'
        );
      case 'fallback':
        return command.action === 'status'
          ? await this.#fallbackStatus()
          : await this.#fallbackPlay(command.campaignId);
      case 'operator':
        return await this.#operator(command.campaignId);
    }
  }

  async #rules(command: Extract<ApplicationCommand, { kind: 'rules' }>): Promise<ApplicationResponse> {
    const invalid = { ok: false, code: 'SCHEMA_INVALID', message: 'Comando de reglas inválido.' };
    if (Object.keys(command).length !== 4
      || !['kind', 'action', 'campaignId', 'input'].every(key => Object.hasOwn(command, key))
      || typeof command.campaignId !== 'string'
      || !/^CAMPAIGN-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(command.campaignId)
      || !['resolve', 'validate-character', 'validate-prestige', 'validate-race'].includes(command.action)) return invalid;
    if (this.#dependencies.rules === undefined) {
      return { ok: false, code: 'RULES_ADAPTER_UNAVAILABLE', message: 'No hay adapter de reglas configurado.' };
    }
    const binding = await this.#dependencies.rules.open(command.campaignId);
    if (!binding.ok) return portResponse(binding, '', '');
    if (!validateRuntimeContract('CampaignManifest', binding.value.manifest).ok) return invalid;
    const manifest = binding.value.manifest as CampaignManifest;
    const adapter = binding.value.adapter;
    if (manifest.campaign_id !== command.campaignId || manifest.ruleset_id !== adapter.rulesetId) {
      return { ok: false, code: 'RULESET_MISMATCH', message: 'El adapter no corresponde a la campaña validada.' };
    }
    switch (command.action) {
      case 'resolve': return portResponse(adapter.resolveRule(command.input), 'RULES_RESOLVED', 'Consulta reglamentaria evaluada.');
      case 'validate-character': return portResponse(adapter.validateCharacter(command.input), 'CHARACTER_VALIDATED', 'Ficha evaluada sin modificarla.');
      case 'validate-prestige': return portResponse(adapter.validatePrestige(command.input), 'PRESTIGE_VALIDATED', 'Elegibilidad hipotética evaluada.');
      case 'validate-race': return portResponse(adapter.validateRace(command.input), 'RACE_VALIDATED', 'Aplicación racial candidata evaluada.');
    }
  }

  #observe(command: ApplicationCommand, response: ApplicationResponse): void {
    const action = 'action' in command ? command.action : undefined;
    const campaignId = 'campaignId' in command
      ? command.campaignId
      : command.kind === 'play'
        ? command.input.campaignId
        : undefined;
    const turnId = command.kind === 'play' ? command.input.turnId : undefined;
    const checkpointId = 'checkpointId' in command ? command.checkpointId : undefined;
    try {
      this.#dependencies.observability?.record({
        correlationId: turnId ?? campaignId ?? checkpointId ?? `APPLICATION-${command.kind}`,
        component: 'application',
        operation: action === undefined ? command.kind : `${command.kind}.${action}`,
        code: response.code,
        status: response.ok ? 'PASS' : 'FAIL',
        ...(campaignId === undefined ? {} : { campaignId }),
        ...(turnId === undefined ? {} : { turnId }),
        ...(checkpointId === undefined ? {} : { checkpointId })
      });
    } catch {
      // El resultado de aplicación no depende del sink operativo.
    }
  }

  async #doctor(): Promise<ApplicationResponse> {
    const diagnostics = this.#dependencies.diagnostics === undefined
      ? undefined
      : await this.#dependencies.diagnostics.inspect();
    if (diagnostics !== undefined && !diagnostics.ok) {
      return { ok: false, code: diagnostics.error.code, message: diagnostics.error.message };
    }
    const options = { correlationId: 'DOCTOR-HEALTH', timeoutMs: 5_000 };
    const health = await this.#dependencies.gateway.health(options);
    if (!health.ok) return { ok: false, code: health.error.code, message: 'Runtime local no preparado.' };
    const models = await this.#dependencies.gateway.listModels({ ...options, correlationId: 'DOCTOR-MODELS' });
    if (!models.ok) return { ok: false, code: models.error.code, message: 'No se pudo consultar el catálogo de modelos.' };
    if (models.value.modelIds.length === 0) {
      return { ok: false, code: 'MODEL_CATALOG_EMPTY', message: 'El runtime no anuncia ningún modelo.' };
    }
    if (this.#options.requiredModelId !== undefined && !models.value.modelIds.includes(this.#options.requiredModelId)) {
      return { ok: false, code: 'REQUIRED_MODEL_MISSING', message: 'El runtime no anuncia el modelo configurado.' };
    }
    return {
      ok: true,
      code: 'DOCTOR_OK',
      message: 'Runtime local preparado.',
      data: {
        modelIds: [...models.value.modelIds],
        ...(diagnostics?.ok === true ? { checks: diagnostics.value.checks } : {})
      }
    };
  }

  async #runtime(action: 'status' | 'start' | 'stop', profile?: RuntimeProfileName): Promise<ApplicationResponse> {
    const result = action === 'start'
      ? await this.#dependencies.runtime.start(profile)
      : await this.#dependencies.runtime[action]();
    return portResponse(result, `RUNTIME_${action.toUpperCase()}_OK`, `Runtime ${action} completado.`);
  }

  async #campaign(action: 'create' | 'open', campaignId: string): Promise<ApplicationResponse> {
    const result = await this.#dependencies.campaigns[action](campaignId);
    const successCode = action === 'create' ? 'CAMPAIGN_CREATED' : 'CAMPAIGN_OPENED';
    return portResponse(result, successCode, `Campaña ${action} completada.`);
  }

  async #play(input: RunTurnInput): Promise<ApplicationResponse> {
    if (typeof input.playerInput === 'string' && input.playerInput.trim().startsWith('/')) {
      const parsed = parseGuidedTurnIntent(input.playerInput);
      if (!parsed.ok) return portResponse(parsed, '', '');
      if (parsed.value.kind === 'rule') {
        if (this.#dependencies.rules?.resolveRegistered === undefined) return {
          ok: false, code: 'RULES_ADAPTER_UNAVAILABLE', message: 'La consulta registrada no está disponible; no se ha consultado al modelo.'
        };
        const result = await this.#dependencies.rules.resolveRegistered(input.campaignId, parsed.value, input.baseStateVersion);
        return result.ok ? { ok: true, code: 'RULES_RESOLVED',
          message: `${result.value.ruling}\nFuentes: ${result.value.sourceRefs.join(', ')}`, data: result.value
        } : portResponse(result, '', '');
      }
    }
    const outcome = await this.#dependencies.turns.runTurn(input);
    if (outcome.status === 'BLOCKED') {
      const playerMessage = outcome.code === 'PLAN_ASK_CLARIFICATION'
        ? 'Necesito que aclares tu acción antes de continuar.'
        : outcome.code.startsWith('MECHANICAL_')
          ? 'La mecánica no pudo confirmarse; no se aplicó ningún cambio. Usa /action <id> para una acción registrada o aclara la acción antes de continuar.'
        : outcome.code === 'PLAYER_AGENCY_VIOLATION'
          ? 'No puedo resolver esa acción sin preservar tu agencia.'
          : 'El turno no pudo confirmarse; no se aplicó ningún cambio.';
      const response = { ok: false, code: outcome.code, message: playerMessage };
      this.#dependencies.turns.releasePostResponse();
      return response;
    }
    const response = {
      ok: true,
      code: 'TURN_COMMITTED',
      message: outcome.narration,
      data: {
        committedStateVersion: outcome.committedStateVersion,
        ...(outcome.warnings === undefined ? {} : { warnings: outcome.warnings })
      }
    };
    this.#dependencies.turns.releasePostResponse();
    return response;
  }

  async #fallbackStatus(): Promise<ApplicationResponse> {
    return portResponse(
      await this.#dependencies.fallback.status(),
      'FALLBACK_STATUS_OK',
      'Fallback status completado.'
    );
  }

  async #fallbackPlay(campaignId: string): Promise<ApplicationResponse> {
    return portResponse(
      await this.#dependencies.fallback.play(campaignId),
      'FALLBACK_PLAY_OK',
      'Fallback play completado.'
    );
  }

  async #operator(campaignId: string): Promise<ApplicationResponse> {
    if (this.#dependencies.workers === undefined) {
      return { ok: false, code: 'OPERATOR_STATUS_UNAVAILABLE', message: 'Estado operativo no disponible.' };
    }
    const [workers, runtime] = await Promise.all([
      this.#dependencies.workers.status(campaignId),
      this.#dependencies.runtime.status()
    ]);
    if (!workers.ok) return { ok: false, code: workers.error.code, message: workers.error.message };
    if (!runtime.ok) return { ok: false, code: runtime.error.code, message: runtime.error.message };
    const runtimeLabel = runtime.value.state === 'running'
      ? 'saludable'
      : runtime.value.state === 'stopped'
        ? 'detenido'
        : 'no disponible';
    return {
      ok: true,
      code: 'OPERATOR_STATUS_OK',
      message: 'Estado operativo preparado.',
      data: { runtime: runtimeLabel, ...workers.value }
    };
  }
}
