/* GENERATED FILE - DO NOT EDIT. source=internal/dnd35-adapter-event.schema.json schema_sha256=2ff0666da18dce6940adf381245a9753029e3d70539c5e1d0d4923aaa838be38 */

export interface Dnd35AdapterEventV1 {
  schema_version: '1.0';
  event_id: string;
  event_type:
    | 'RACE_OPTION_SELECTED'
    | 'RACIAL_HD_APPLIED'
    | 'LEVEL_ADJUSTMENT_APPLIED'
    | 'PRESTIGE_ELIGIBILITY_CHECKED'
    | 'PRESTIGE_LEVEL_GAINED'
    | 'SPELLCASTING_PROGRESSION_CHOSEN'
    | 'MANIFESTING_PROGRESSION_CHOSEN'
    | 'RACE_VARIANT_CHOSEN'
    | 'RULE_SOURCE_REGISTERED'
    | 'RULE_RULING_RECORDED'
    | 'HOUSE_RULE_ENABLED'
    | 'HOUSE_RULE_DISABLED';
  campaign_id: string;
  branch_id: string;
  base_adapter_version: number;
  committed_adapter_version: number;
  actor_id: string;
  occurred_at: string;
  payload: {
    [k: string]: any;
  };
  /**
   * @minItems 1
   */
  source_refs: [string, ...string[]];
}
