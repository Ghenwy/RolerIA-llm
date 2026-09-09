import type { CampaignManifestV1 } from './generated/design--campaign-manifest.js';
import type { CampaignManifestV11 } from './generated/design--campaign-manifest-v1.1.js';
import type { CampaignManifestV12 } from './generated/design--campaign-manifest-v1.2.js';
import type { RuntimeProfileV1 } from './generated/design--runtime-profile.js';
import type { RuntimeProfileV11 } from './generated/design--runtime-profile-v1.1.js';

export * from './generated/index.js';
export * from './migrations/checkpoint-manifest-1.0-to-1.1.js';
export * from './migrations/domain-event-1.0-to-1.1.js';
export * from './migrations/transaction-journal-1.0-to-1.1.js';
export * from './runtime-validation.js';
// A union of generated contracts, not a hand-maintained parallel manifest model.
export type CampaignManifest =
  | CampaignManifestV1
  | CampaignManifestV11
  | CampaignManifestV12;
export type CampaignTurnProfile = CampaignManifestV11['turn_profile'];
export type RuntimeProfile = RuntimeProfileV1 | RuntimeProfileV11;
export type RuntimeProfileName = RuntimeProfile['profile'];
