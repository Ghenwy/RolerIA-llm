import crypto from 'node:crypto';
import type { DesignTurnEnvelope } from '@nyx/contracts';
import { canonicalJson, type CampaignState } from '@nyx/domain';
import type { C5WorkerResultPacket } from './c5-worker-result-packet.js';
import {
  validateC6ContextPacket,
  type C6GmContextPacket
} from './c6-context-builder.js';

export interface C3ContextPacket {
  readonly schema_version: '1.0';
  readonly campaign_id: string;
  readonly branch_id: string;
  readonly state_version: number;
  readonly canonical_state_sha256: string;
  readonly context_refs: readonly DesignTurnEnvelope.ContentRef[];
  readonly canonical_state: CampaignState;
}

export interface C3ContextExpectation {
  readonly campaignId: string;
  readonly baseStateVersion: number;
}

export interface TurnContextBuildInput extends C3ContextExpectation {
  readonly turnId: string;
  readonly requestedRefs: readonly DesignTurnEnvelope.ContentRef[];
  readonly language: string;
  readonly playerMessage: string;
}

export type TurnContextPacket = C3ContextPacket | C6GmContextPacket;

export type TurnContextResult =
  | { readonly ok: true; readonly value: TurnContextPacket }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export interface TurnContextPort {
  build(input: TurnContextBuildInput): Promise<TurnContextResult>;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stateRef(packet: Pick<C3ContextPacket, 'campaign_id' | 'branch_id' | 'state_version' | 'canonical_state_sha256'>): DesignTurnEnvelope.ContentRef {
  return {
    id: `state:${packet.campaign_id}:${packet.branch_id}:${String(packet.state_version)}`,
    sha256: packet.canonical_state_sha256
  };
}

export function buildC3ContextPacket(state: CampaignState): C3ContextPacket {
  const canonicalState = structuredClone(state);
  const packet: C3ContextPacket = {
    schema_version: '1.0',
    campaign_id: canonicalState.campaign_id,
    branch_id: canonicalState.branch_id,
    state_version: canonicalState.state_version,
    canonical_state_sha256: sha256(canonicalJson(canonicalState)),
    context_refs: [],
    canonical_state: canonicalState
  };
  return { ...packet, context_refs: [stateRef(packet)] };
}

export function validateC3ContextPacket(
  packet: C3ContextPacket,
  expected: C3ContextExpectation
): string[] {
  const errors: string[] = [];
  if (packet.schema_version !== '1.0') errors.push('context_packet:schema_version');
  if (packet.campaign_id !== expected.campaignId) errors.push('context_packet:campaign_id_mismatch');
  if (packet.state_version !== expected.baseStateVersion) errors.push('context_packet:state_version_mismatch');
  if (packet.canonical_state.campaign_id !== packet.campaign_id) errors.push('context_packet:canonical_campaign_id_mismatch');
  if (packet.canonical_state.branch_id !== packet.branch_id) errors.push('context_packet:canonical_branch_id_mismatch');
  if (packet.canonical_state.state_version !== packet.state_version) errors.push('context_packet:canonical_state_version_mismatch');
  if (sha256(canonicalJson(packet.canonical_state)) !== packet.canonical_state_sha256) {
    errors.push('context_packet:canonical_state_hash_mismatch');
  }
  const expectedRef = stateRef(packet);
  if (
    packet.context_refs.length !== 1 ||
    packet.context_refs[0]?.id !== expectedRef.id ||
    packet.context_refs[0]?.sha256 !== expectedRef.sha256
  ) {
    errors.push('context_packet:context_refs_mismatch');
  }
  return errors;
}

export function isC6ContextPacket(packet: TurnContextPacket): packet is C6GmContextPacket {
  return 'context_profile' in packet && packet.context_profile === 'c6-gm';
}

export function validateTurnContextPacket(
  packet: TurnContextPacket,
  expected: C3ContextExpectation
): string[] {
  return isC6ContextPacket(packet)
    ? validateC6ContextPacket(packet, expected)
    : validateC3ContextPacket(packet, expected);
}

export function validateC3TurnInput(
  envelope: DesignTurnEnvelope.TurnEnvelopeV1,
  contextPacket: TurnContextPacket
): string[] {
  const errors = validateTurnContextPacket(contextPacket, {
    campaignId: envelope.campaign_id,
    baseStateVersion: envelope.base_state_version
  });
  if (
    envelope.context_refs.length !== contextPacket.context_refs.length ||
    envelope.context_refs.some((reference, index) => {
      const expected = contextPacket.context_refs[index];
      return expected?.id !== reference.id || expected.sha256 !== reference.sha256;
    })
  ) {
    errors.push('context_packet:envelope_refs_mismatch');
  }
  return errors;
}

export function llmTurnInput(
  envelope: DesignTurnEnvelope.TurnEnvelopeV1,
  contextPacket: TurnContextPacket,
  workerResultPacket?: C5WorkerResultPacket
): {
  readonly turn_envelope: DesignTurnEnvelope.TurnEnvelopeV1;
  readonly context_packet: TurnContextPacket;
  readonly worker_result_packet?: C5WorkerResultPacket;
} {
  return workerResultPacket === undefined
    ? { turn_envelope: envelope, context_packet: contextPacket }
    : { turn_envelope: envelope, context_packet: contextPacket, worker_result_packet: workerResultPacket };
}
