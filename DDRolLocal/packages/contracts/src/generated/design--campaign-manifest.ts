/* GENERATED FILE - DO NOT EDIT. source=design/campaign-manifest.schema.json schema_sha256=e37997332f192216cccd4b40c171c676e83949ab0da2955c567b0c5c4a52730a */

/**
 * This interface was referenced by `CampaignManifestV1`'s JSON-Schema
 * via the `definition` "relative_path".
 */
export type RelativePath = string;
/**
 * This interface was referenced by `CampaignManifestV1`'s JSON-Schema
 * via the `definition` "sha256".
 */
export type Sha256 = string;

export interface CampaignManifestV1 {
  schema_version: '1.0';
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
}
/**
 * This interface was referenced by `CampaignManifestV1`'s JSON-Schema
 * via the `definition` "fingerprint_map".
 */
export interface FingerprintMap {
  [k: string]: Sha256;
}
