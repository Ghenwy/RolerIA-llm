import type { InternalCheckpointManifest, InternalCheckpointManifestV11 } from '../generated/index.js';

export interface CheckpointManifestV11Metadata {
  state_file: string;
  event_file: string;
  event_count: number;
  event_tail_event_id: string | null;
  campaign_time: string;
}

/** [DESIGN] Requires inspected checkpoint artifacts; no position or time is inferred. */
export function migrateCheckpointManifestV1ToV11(
  manifest: InternalCheckpointManifest.CheckpointManifestV1,
  metadata: CheckpointManifestV11Metadata
): InternalCheckpointManifestV11.CheckpointManifestV11 {
  return { ...manifest, ...metadata, schema_version: '1.1' };
}
