/* GENERATED FILE - DO NOT EDIT. source=internal/checkpoint-manifest.schema.json schema_sha256=af5e83c4daa04abdd7566bf8574d7f91451431dc7f44b53668c1235fff7e6cb6 */

/**
 * This interface was referenced by `CheckpointManifestV1`'s JSON-Schema
 * via the `definition` "sha256".
 */
export type Sha256 = string;

export interface CheckpointManifestV1 {
  schema_version: '1.0';
  checkpoint_id: string;
  campaign_id: string;
  branch_id: string;
  parent_checkpoint_id: string | null;
  state_version: number;
  state_sha256: Sha256;
  event_tail_hash: Sha256;
  rng_hash: Sha256;
  schema_fingerprints: FingerprintMap;
  prompt_fingerprints: FingerprintMap;
  model_fingerprint: Sha256;
  created_at: string;
}
/**
 * This interface was referenced by `CheckpointManifestV1`'s JSON-Schema
 * via the `definition` "fingerprint_map".
 */
export interface FingerprintMap {
  [k: string]: Sha256;
}
