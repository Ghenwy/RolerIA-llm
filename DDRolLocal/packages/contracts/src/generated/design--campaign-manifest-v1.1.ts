/* GENERATED FILE - DO NOT EDIT. source=design/campaign-manifest-v1.1.schema.json schema_sha256=90b0f8d4eaade3f0d8d71370de7c3c5eda08f35bc50c1029c43f83e582b97ecd */

/**
 * This interface was referenced by `CampaignManifestV11`'s JSON-Schema
 * via the `definition` "relative_path".
 */
export type RelativePath = string;
/**
 * This interface was referenced by `CampaignManifestV11`'s JSON-Schema
 * via the `definition` "sha256".
 */
export type Sha256 = string;

/**
 * [DESIGN DEC-081/082] Persist the assisted/experimental boundary explicitly. New campaigns only; version 1.0 is preserved and interpreted as historical automatic mode without rewriting. The caller cannot override a persisted turn profile.
 */
export interface CampaignManifestV11 {
  schema_version: '1.1';
  campaign_id: string;
  language: string;
  ruleset_id: string;
  runtime_profile: '96k' | '112k';
  active_branch_id: string;
  state_version: number;
  paths: {
    state: RelativePath;
    events: RelativePath;
    transcript: RelativePath;
    checkpoints: RelativePath;
  };
  fingerprints: {
    schemas: FingerprintMap;
    prompts: FingerprintMap;
    model: Sha256;
  };
  last_checkpoint_at: string | null;
  turn_profile: 'ASSISTED_ALPHA' | 'AUTOMATIC_EXPERIMENTAL';
}
/**
 * This interface was referenced by `CampaignManifestV11`'s JSON-Schema
 * via the `definition` "fingerprint_map".
 */
export interface FingerprintMap {
  [k: string]: Sha256;
}
