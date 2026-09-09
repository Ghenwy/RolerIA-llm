/* GENERATED FILE - DO NOT EDIT. source=internal/domain-event-v1.1.schema.json schema_sha256=7c32efd392174b792a25a6607bf8f070e749f7eb732c096f27a071360a6145e3 */

export interface DomainEventV11 {
  schema_version: '1.1';
  event_id: string;
  event_type:
    | 'ITEM_ACQUIRED'
    | 'ITEM_TRANSFERRED'
    | 'ITEM_CONSUMED'
    | 'ITEM_CHARGES_CHANGED'
    | 'CURRENCY_CHANGED'
    | 'HP_CHANGED'
    | 'NONLETHAL_CHANGED'
    | 'CONDITION_ADDED'
    | 'CONDITION_REMOVED'
    | 'SPELL_SLOT_USED'
    | 'SPELL_SLOT_RESTORED'
    | 'DAILY_USE_CHANGED'
    | 'XP_CHANGED'
    | 'LEVEL_CHANGED'
    | 'LOCATION_CHANGED'
    | 'TIME_ADVANCED'
    | 'QUEST_UPDATED'
    | 'NPC_KNOWLEDGE_ADDED'
    | 'NPC_BELIEF_CHANGED'
    | 'RELATIONSHIP_CHANGED'
    | 'CANON_FACT_ADDED'
    | 'CHARACTER_DIED'
    | 'FACTION_CLOCK_CHANGED'
    | 'RULE_RULING_RECORDED'
    | 'DICE_ROLLED'
    | 'NPC_PROMOTED';
  campaign_id: string;
  branch_id: string;
  turn_id: string;
  base_state_version: number;
  committed_state_version: number;
  actor_id: string;
  targets: string[];
  correlation_id: string;
  occurred_at: string;
  campaign_time: string;
  committed: true;
  payload: {
    [k: string]: any;
  };
  /**
   * @minItems 1
   */
  evidence: [string, ...string[]];
  /**
   * @minItems 1
   */
  source_refs: [string, ...string[]];
}
