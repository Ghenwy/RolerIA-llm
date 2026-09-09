/* GENERATED FILE - DO NOT EDIT. source=design/campaign-manifest-v1.2.schema.json schema_sha256=eba6ecdf3a82dcf1ce95e4c0fddd1b408e3bbbaa28293df7e6298c60d1a7a1fb */

/**
 * This interface was referenced by `CampaignManifestV12`'s JSON-Schema
 * via the `definition` "relative_path".
 */
export type RelativePath = string;
/**
 * This interface was referenced by `CampaignManifestV12`'s JSON-Schema
 * via the `definition` "sha256".
 */
export type Sha256 = string;

/**
 * [DESIGN] New campaigns may explicitly record 64K without relabelling historical 96K/112K manifests. Versions 1.0/1.1 remain readable; no automatic persisted migration.
 */
export interface CampaignManifestV12 {
  schema_version: '1.2';
  campaign_id: string;
  language: string;
  ruleset_id: string;
  runtime_profile: '64k' | '96k' | '112k';
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
 * This interface was referenced by `CampaignManifestV12`'s JSON-Schema
 * via the `definition` "fingerprint_map".
 */
export interface FingerprintMap {
  [k: string]: Sha256;
}
