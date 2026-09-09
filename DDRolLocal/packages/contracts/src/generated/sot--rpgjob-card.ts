/* GENERATED FILE - DO NOT EDIT. source=sot/rpgjob-card.schema.json schema_sha256=0a10565da554f073d85a8f8c068088b28c4d1ce93b9e5d379192dfae97e121a2 */

export interface RPGJobCard {
  schema_version: '1.0';
  job_id: string;
  turn_id: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  worker_id:
    | 'rpg.rules_arbiter'
    | 'rpg.npc_director'
    | 'rpg.world_simulator'
    | 'rpg.encounter_engine'
    | 'rpg.state_keeper'
    | 'rpg.memory_keeper'
    | 'rpg.canon_validator'
    | 'rpg.lore_curator';
  objective: string;
  base_state_version: number;
  inputs: {
    state_refs: string[];
    event_refs: string[];
    transcript_refs: string[];
    rules_refs: string[];
    facts: string[];
  };
  constraints: string[];
  dependencies: string[];
  blocking: boolean;
  expected_output: {
    type: string;
    required_fields: string[];
  };
  /**
   * @minItems 1
   */
  definition_of_done: [string, ...string[]];
  budget: {
    max_context_tokens: number;
    max_output_tokens: number;
    deadline_class: 'before_resolution' | 'before_narration' | 'after_response' | 'idle';
  };
  status: 'PENDING' | 'READY' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'BLOCKED' | 'FAILED' | 'STALE' | 'CANCELLED';
}
