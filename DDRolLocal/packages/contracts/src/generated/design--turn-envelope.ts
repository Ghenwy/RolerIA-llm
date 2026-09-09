/* GENERATED FILE - DO NOT EDIT. source=design/turn-envelope.schema.json schema_sha256=d6ecf6649c8c5db90fc5566934cf728a8f8fa1107e4d4cf717c71cd2897bd578 */

export type TurnEnvelopeV1 = {
  schema_version: '1.0';
  campaign_id: string;
  turn_id: string;
  phase: 'PLAN' | 'RESOLVE';
  base_state_version: number;
  player_input: string | null;
  context_refs: ContentRef[];
  worker_results: ResultRef[];
  deterministic_rolls: RollRef[];
  language: string;
};
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "sha256".
 */
export type Sha256 = string;

/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "content_ref".
 */
export interface ContentRef {
  id: string;
  sha256: Sha256;
}
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "result_ref".
 */
export interface ResultRef {
  job_id: string;
  worker_id: string;
  base_state_version: number;
  status: 'COMPLETED';
  sha256: Sha256;
}
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "roll_ref".
 */
export interface RollRef {
  roll_id: string;
  expression: string;
  result: number;
  rng_counter: number;
}
