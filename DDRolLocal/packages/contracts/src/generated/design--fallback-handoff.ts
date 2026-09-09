/* GENERATED FILE - DO NOT EDIT. source=design/fallback-handoff.schema.json schema_sha256=c59838e9002616686cfcec731259085224b4e76fea40baba8ac86b55ad52e1dd */

export type FallbackHandoffV1 = {
  schema_version: '1.0';
  campaign_id: string;
  branch_id: string;
  committed_state_version: number;
  checkpoint_id: string;
  event_tail_hash: Sha256;
  rng_hash: Sha256;
  source_runtime: 'typescript' | 'python';
  target_runtime: 'typescript' | 'python';
  reason: string;
  integrity_status: 'PASS';
  foreign_writer_lock_present: false;
};
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "sha256".
 */
export type Sha256 = string;
