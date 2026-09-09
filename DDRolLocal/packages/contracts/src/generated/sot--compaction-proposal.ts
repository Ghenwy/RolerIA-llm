/* GENERATED FILE - DO NOT EDIT. source=sot/compaction-proposal.schema.json schema_sha256=aa53dfc0e0714b5e6a14e1f45e8817b5bd737aaa46ef21f034c7e1c67a518b97 */

export interface CompactionProposal {
  schema_version: '1.0';
  proposal_id: string;
  campaign_id: string;
  base_state_version: number;
  source_turn_range: {
    from_turn: number;
    to_turn: number;
  };
  preserved_exact_refs: string[];
  scene_summary: string;
  durable_memories: {
    [k: string]: any;
  }[];
  npc_memory_patches: {
    [k: string]: any;
  }[];
  open_threads: {
    [k: string]: any;
  }[];
  retrieval_keys: string[];
  state_patch_proposals: {
    [k: string]: any;
  }[];
  safe_to_evict: {
    allowed: boolean;
    turn_ranges: {
      [k: string]: any;
    }[];
    reason: string;
  };
  validation_manifest: {
    character_sheets_checked: string[];
    inventories_checked: string[];
    quests_checked: string[];
    canon_checked: boolean;
    knowledge_boundaries_checked: boolean;
    unresolved_discrepancies: string[];
  };
}
