/* GENERATED FILE - DO NOT EDIT. source=internal/checkpoint-manifest-v1.2.schema.json schema_sha256=60b9272dcf7f351e70bb8744167d17bb8da1585b428457426a08b4f24d8c5c89 */

/**
 * This interface was referenced by `CheckpointManifestV12`'s JSON-Schema
 * via the `definition` "relative_path".
 */
export type RelativePath = string;
/**
 * This interface was referenced by `CheckpointManifestV12`'s JSON-Schema
 * via the `definition` "sha256".
 */
export type Sha256 = string;

export interface CheckpointManifestV12 {
  schema_version: '1.2';
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
  artifacts: {
    relative_path: RelativePath;
    sha256: Sha256;
    byte_length: number;
    kind: 'dnd35_events' | 'rule_source';
  }[];
}
/**
 * This interface was referenced by `CheckpointManifestV12`'s JSON-Schema
 * via the `definition` "fingerprint_map".
 */
export interface FingerprintMap {
  [k: string]: Sha256;
}
