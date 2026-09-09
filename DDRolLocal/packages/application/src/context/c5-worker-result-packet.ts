import crypto from 'node:crypto';
import { validateRuntimeContract, type DesignTurnEnvelope, type SotRpgworkerResult } from '@nyx/contracts';
import { canonicalJson } from '@nyx/domain';

export interface C5WorkerResultPacket {
  readonly schema_version: '1.0';
  readonly result_refs: readonly DesignTurnEnvelope.ResultRef[];
  readonly results: readonly SotRpgworkerResult.RPGWorkerResult[];
}

function resultSha256(result: SotRpgworkerResult.RPGWorkerResult): string {
  return crypto.createHash('sha256').update(canonicalJson(result)).digest('hex');
}

export function workerResultRef(result: SotRpgworkerResult.RPGWorkerResult): DesignTurnEnvelope.ResultRef {
  return {
    job_id: result.job_id,
    worker_id: result.worker_id,
    base_state_version: result.base_state_version,
    status: 'COMPLETED',
    sha256: resultSha256(result)
  };
}

export function buildC5WorkerResultPacket(
  results: readonly SotRpgworkerResult.RPGWorkerResult[]
): C5WorkerResultPacket {
  const copies = structuredClone(results);
  return {
    schema_version: '1.0',
    result_refs: copies.map(workerResultRef),
    results: copies
  };
}

export function validateC5WorkerResultPacket(
  envelope: DesignTurnEnvelope.TurnEnvelopeV1,
  packet: C5WorkerResultPacket
): string[] {
  const errors: string[] = [];
  if (packet.schema_version !== '1.0') errors.push('worker_result_packet:schema_version');
  if (packet.results.length !== packet.result_refs.length || packet.result_refs.length !== envelope.worker_results.length) {
    errors.push('worker_result_packet:ref_count_mismatch');
  }

  const envelopeRefs = new Map(envelope.worker_results.map(reference => [reference.job_id, reference]));
  const packetRefs = new Map(packet.result_refs.map(reference => [reference.job_id, reference]));
  const seen = new Set<string>();
  for (const result of packet.results) {
    const validation = validateRuntimeContract('RPGWorkerResult', result);
    if (!validation.ok) {
      errors.push(...validation.errors.map(error => `worker_result_packet:contract:${result.job_id}:${error}`));
    }
    if (seen.has(result.job_id)) errors.push(`worker_result_packet:duplicate_job_id:${result.job_id}`);
    seen.add(result.job_id);
    if (result.status !== 'completed') errors.push(`worker_result_packet:not_completed:${result.job_id}`);
    if (result.turn_id !== envelope.turn_id) errors.push(`worker_result_packet:turn_mismatch:${result.job_id}`);
    if (result.base_state_version !== envelope.base_state_version) errors.push(`worker_result_packet:stale:${result.job_id}`);

    const expected = workerResultRef(result);
    const packetRef = packetRefs.get(result.job_id);
    const envelopeRef = envelopeRefs.get(result.job_id);
    if (packetRef === undefined || envelopeRef === undefined) {
      errors.push(`worker_result_packet:missing_ref:${result.job_id}`);
      continue;
    }
    if (packetRef.sha256 !== expected.sha256 || envelopeRef.sha256 !== expected.sha256) {
      errors.push(`worker_result_packet:hash_mismatch:${result.job_id}`);
    }
    if (
      packetRef.worker_id !== result.worker_id
      || envelopeRef.worker_id !== result.worker_id
      || packetRef.base_state_version !== result.base_state_version
      || envelopeRef.base_state_version !== result.base_state_version
      || packetRef.status !== 'COMPLETED'
      || envelopeRef.status !== 'COMPLETED'
    ) {
      errors.push(`worker_result_packet:identity_mismatch:${result.job_id}`);
    }
  }
  for (const reference of envelope.worker_results) {
    if (!seen.has(reference.job_id)) errors.push(`worker_result_packet:unresolved_ref:${reference.job_id}`);
  }
  return errors;
}

export function validateC5WorkerResultBinding(
  envelope: DesignTurnEnvelope.TurnEnvelopeV1,
  packet: C5WorkerResultPacket | undefined
): string[] {
  if (packet === undefined) {
    return envelope.worker_results.length === 0 ? [] : ['worker_result_packet:required'];
  }
  return validateC5WorkerResultPacket(envelope, packet);
}
