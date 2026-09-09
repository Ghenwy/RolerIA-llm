import type { DesignFallbackHandoff } from '@nyx/contracts';
import { validateRuntimeContract } from '@nyx/contracts';

export type RuntimeOwner = 'typescript' | 'python';

export interface ConfirmedHandoffBoundary {
  readonly campaign_id: string;
  readonly branch_id: string;
  readonly committed_state_version: number;
  readonly checkpoint_id: string;
  readonly state_sha256: string;
  readonly event_tail_hash: string;
  readonly rng_hash: string;
  readonly transaction_status: 'IDLE' | 'ACTIVE';
  readonly foreign_writer_lock_present: boolean;
}

export type HandoffErrorCode =
  | 'HANDOFF_BOUNDARY_UNAVAILABLE'
  | 'HANDOFF_TRANSACTION_ACTIVE'
  | 'HANDOFF_LOCK_PRESENT'
  | 'HANDOFF_CONTRACT_INVALID'
  | 'HANDOFF_TARGET_MISMATCH'
  | 'HANDOFF_BOUNDARY_MISMATCH'
  | 'HANDOFF_PERSIST_FAILED'
  | 'HANDOFF_LOCK_ACQUIRE_FAILED'
  | 'HANDOFF_LOCK_RELEASE_FAILED';

export interface HandoffError {
  readonly code: HandoffErrorCode;
  readonly message: string;
}

export type HandoffResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: HandoffError };

export interface FallbackHandoffAdapter {
  inspectConfirmedBoundary(): Promise<HandoffResult<ConfirmedHandoffBoundary>>;
  persistHandoff(handoff: DesignFallbackHandoff.FallbackHandoffV1): Promise<HandoffResult<void>>;
  acquireTargetWriter(
    targetRuntime: RuntimeOwner,
    boundary: ConfirmedHandoffBoundary,
    handoff: DesignFallbackHandoff.FallbackHandoffV1
  ): Promise<HandoffResult<{ token: string }>>;
}

export interface PrepareHandoffInput {
  readonly sourceRuntime: RuntimeOwner;
  readonly targetRuntime: RuntimeOwner;
  readonly reason: string;
}

function failure(code: HandoffErrorCode, message: string): HandoffResult<never> {
  return { ok: false, error: { code, message } };
}

function boundaryReady(boundary: ConfirmedHandoffBoundary): HandoffResult<true> {
  if (boundary.transaction_status !== 'IDLE') {
    return failure('HANDOFF_TRANSACTION_ACTIVE', 'No se permite handoff durante una transacción.');
  }
  if (boundary.foreign_writer_lock_present) {
    return failure('HANDOFF_LOCK_PRESENT', 'Debe liberarse el writer antes del handoff.');
  }
  return { ok: true, value: true };
}

function contractValid(value: unknown): value is DesignFallbackHandoff.FallbackHandoffV1 {
  return validateRuntimeContract('FallbackHandoff', value).ok;
}

function matchesBoundary(
  handoff: DesignFallbackHandoff.FallbackHandoffV1,
  boundary: ConfirmedHandoffBoundary
): boolean {
  return handoff.campaign_id === boundary.campaign_id &&
    handoff.branch_id === boundary.branch_id &&
    handoff.committed_state_version === boundary.committed_state_version &&
    handoff.checkpoint_id === boundary.checkpoint_id &&
    handoff.event_tail_hash === boundary.event_tail_hash &&
    handoff.rng_hash === boundary.rng_hash;
}

export class FallbackHandoffCoordinator {
  readonly #adapter: FallbackHandoffAdapter;

  constructor(adapter: FallbackHandoffAdapter) {
    this.#adapter = adapter;
  }

  async prepare(input: PrepareHandoffInput): Promise<HandoffResult<DesignFallbackHandoff.FallbackHandoffV1>> {
    const boundary = await this.#adapter.inspectConfirmedBoundary();
    if (!boundary.ok) return boundary;
    const ready = boundaryReady(boundary.value);
    if (!ready.ok) return ready;
    if (input.reason.trim().length === 0) {
      return failure('HANDOFF_CONTRACT_INVALID', 'El handoff requiere una razón explícita.');
    }
    const handoff: DesignFallbackHandoff.FallbackHandoffV1 = {
      schema_version: '1.0',
      campaign_id: boundary.value.campaign_id,
      branch_id: boundary.value.branch_id,
      committed_state_version: boundary.value.committed_state_version,
      checkpoint_id: boundary.value.checkpoint_id,
      event_tail_hash: boundary.value.event_tail_hash,
      rng_hash: boundary.value.rng_hash,
      source_runtime: input.sourceRuntime,
      target_runtime: input.targetRuntime,
      reason: input.reason,
      integrity_status: 'PASS',
      foreign_writer_lock_present: false
    };
    if (!contractValid(handoff)) {
      return failure('HANDOFF_CONTRACT_INVALID', 'El FallbackHandoff no cumple su schema.');
    }
    const persisted = await this.#adapter.persistHandoff(handoff);
    return persisted.ok ? { ok: true, value: handoff } : persisted;
  }

  async accept(
    handoff: DesignFallbackHandoff.FallbackHandoffV1,
    expectedTarget: RuntimeOwner
  ): Promise<HandoffResult<{
    handoff: DesignFallbackHandoff.FallbackHandoffV1;
    lease: { token: string };
  }>> {
    if (!contractValid(handoff)) {
      return failure('HANDOFF_CONTRACT_INVALID', 'El FallbackHandoff no cumple su schema.');
    }
    if (handoff.target_runtime !== expectedTarget) {
      return failure('HANDOFF_TARGET_MISMATCH', 'El handoff pertenece a otro runtime destino.');
    }
    const boundary = await this.#adapter.inspectConfirmedBoundary();
    if (!boundary.ok) return boundary;
    const ready = boundaryReady(boundary.value);
    if (!ready.ok) return ready;
    if (!matchesBoundary(handoff, boundary.value)) {
      return failure('HANDOFF_BOUNDARY_MISMATCH', 'El handoff no coincide con el último checkpoint confirmado.');
    }
    const lease = await this.#adapter.acquireTargetWriter(expectedTarget, boundary.value, handoff);
    return lease.ok ? { ok: true, value: { handoff, lease: lease.value } } : lease;
  }
}
