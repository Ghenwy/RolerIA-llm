/* GENERATED FILE - DO NOT EDIT. source=internal/compaction-commit-v1.2.schema.json schema_sha256=cf4d1fad7fe77a199b6b70153b7ae03ef5ba5ffad10c9d00769b7a32fa4674b7 */

/**
 * Compatible reader for immutable 1.0/1.1 commits plus AMD-004 RUNTIME_CONTINUITY 1.2. No historical rewrite.
 */
export type CompactionCommitV1 = {
  schema_version: '1.0' | '1.1' | '1.2';
  commit_id: string;
  sequence: number;
  proposal_id: string;
  campaign_id: string;
  branch_id: string;
  base_state_version: number;
  previous_commit_id: string | null;
  pre_checkpoint_id: string;
  post_checkpoint_id: string;
  proposal_sha256: string;
  memory_index_sha256: string;
  validation_manifest: ValidationManifest;
  context_view: ContextView;
  /**
   * @minItems 1
   */
  memory_records: [
    {
      [k: string]: any;
    },
    ...{
      [k: string]: any;
    }[]
  ];
  committed_at: string;
  compaction_trigger?: 'TEST_SCENE_CLOSE' | 'RUNTIME_CONTINUITY';
  source_input_tokens?: number;
};
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "stringSet".
 */
export type StringSet = string[];

/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "validationManifest".
 */
export interface ValidationManifest {
  pc_sheet_fingerprints: FingerprintMap;
  relevant_npc_sheet_fingerprints: FingerprintMap;
  party_inventory_fingerprints: FingerprintMap;
  character_inventory_fingerprints: FingerprintMap;
  quest_fingerprints: FingerprintMap;
  canon_sha256: string;
  knowledge_sha256: string;
  pc_sheet_ids_checked: StringSet;
  relevant_npc_sheet_ids_checked: StringSet;
  party_inventory_ids_checked: StringSet;
  character_inventory_ids_checked: StringSet;
  quest_ids_checked: StringSet;
  canon_checked: true;
  knowledge_boundaries_checked: true;
  open_threads_checked: true;
  source_turn_ids_checked: StringSet;
  source_event_ids_checked: StringSet;
  source_event_range_covered: true;
  exact_refs_checked: StringSet;
  /**
   * @maxItems 0
   */
  unresolved_discrepancies: [];
  safe_to_evict_allowed: true;
  candidate_input_tokens: number;
  target_min_input_tokens: number;
  target_max_input_tokens: number;
}
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "fingerprintMap".
 */
export interface FingerprintMap {
  [k: string]: string;
}
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "contextView".
 */
export interface ContextView {
  schema_version: '1.0';
  campaign_id: string;
  branch_id: string;
  base_state_version: number;
  source_context_sha256: string;
  context_sha256: string;
  source_turn_range: TurnRange;
  retrieved_memory_ids: StringSet;
  recent_transcript_refs: StringSet;
  open_threads: {
    [k: string]: any;
  }[];
  preserved_exact_refs: StringSet;
}
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "turnRange".
 */
export interface TurnRange {
  from_turn: number;
  to_turn: number;
}
