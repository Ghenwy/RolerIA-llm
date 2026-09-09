/* GENERATED FILE - DO NOT EDIT. source=internal/checkpoint-manifest-v1.1.schema.json schema_sha256=4f08734ad83e949c9ca290f78381e943155dbcc8b282f8f0e83801f59150d784 */

/**
 * This interface was referenced by `CheckpointManifestV11`'s JSON-Schema
 * via the `definition` "relative_path".
 */
export type RelativePath = string;
/**
 * This interface was referenced by `CheckpointManifestV11`'s JSON-Schema
 * via the `definition` "sha256".
 */
export type Sha256 = string;

export interface CheckpointManifestV11 {
  schema_version: '1.1';
  checkpoint_id: string;
  campaign_id: string;
  branch_id: string;
  parent_checkpoint_id: string | null;
  state_version: number;
  state_file: RelativePath;
  state_sha256: Sha256;
  event_file: RelativePath;
  event_count: number;
  event_tail_event_id: string | null;
  event_tail_hash: Sha256;
  campaign_time: string;
  rng_hash: Sha256;
  schema_fingerprints: FingerprintMap;
  prompt_fingerprints: FingerprintMap;
  model_fingerprint: Sha256;
  created_at: string;
}
/**
 * This interface was referenced by `CheckpointManifestV11`'s JSON-Schema
 * via the `definition` "fingerprint_map".
 */
export interface FingerprintMap {
  [k: string]: Sha256;
}
