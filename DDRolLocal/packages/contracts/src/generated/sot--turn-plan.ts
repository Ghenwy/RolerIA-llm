/* GENERATED FILE - DO NOT EDIT. source=sot/turn-plan.schema.json schema_sha256=78d245578bdec074cc4cc3de9d2cbb0ded6cd0a0400eca110200332c0cb8beb6 */

export interface TurnPlan {
  schema_version: '1.0';
  turn_id: string;
  base_state_version: number;
  player_intent: {
    declared_action: string;
    target: string | null;
    desired_outcome: string | null;
    ambiguities: string[];
  };
  decision: 'DIRECT' | 'DELEGATE' | 'ASK_CLARIFICATION' | 'BLOCKED';
  /**
   * @maxItems 8
   */
  jobs:
    | []
    | [RPGJobCard]
    | [RPGJobCard, RPGJobCard]
    | [RPGJobCard, RPGJobCard, RPGJobCard]
    | [RPGJobCard, RPGJobCard, RPGJobCard, RPGJobCard]
    | [RPGJobCard, RPGJobCard, RPGJobCard, RPGJobCard, RPGJobCard]
    | [RPGJobCard, RPGJobCard, RPGJobCard, RPGJobCard, RPGJobCard, RPGJobCard]
    | [RPGJobCard, RPGJobCard, RPGJobCard, RPGJobCard, RPGJobCard, RPGJobCard, RPGJobCard]
    | [RPGJobCard, RPGJobCard, RPGJobCard, RPGJobCard, RPGJobCard, RPGJobCard, RPGJobCard, RPGJobCard];
  blocking_job_ids: string[];
  preconditions: string[];
  safety: {
    player_agency_preserved: boolean;
    secret_boundaries_preserved: boolean;
  };
}
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
