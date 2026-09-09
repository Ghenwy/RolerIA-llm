/* GENERATED FILE - DO NOT EDIT. source=internal/mechanical-action-v1.schema.json schema_sha256=1824f3ee546de1057a9fb8e97f0f9c4ce55ff4136992c5ef6073292857967b5c */

/**
 * [DESIGN] Confirmed local attack action. Outcome is calculated damage, not implicit HP mutation. REQ-ST-011 / REQ-DND-005 / IMP-C09-T03. Existing SOT contracts unchanged.
 */
export interface MechanicalActionV1 {
  schema_version: '1.0';
  campaign_id: string;
  branch_id: string;
  turn_id: string;
  base_state_version: number;
  base_rng_counter: number;
  profile: MechanicalActionProfile;
  parameters: ConfirmedAttackParameters;
  /**
   * @maxItems 6
   */
  rolls:
    | []
    | [MechanicalRollRef]
    | [MechanicalRollRef, MechanicalRollRef]
    | [MechanicalRollRef, MechanicalRollRef, MechanicalRollRef]
    | [MechanicalRollRef, MechanicalRollRef, MechanicalRollRef, MechanicalRollRef]
    | [MechanicalRollRef, MechanicalRollRef, MechanicalRollRef, MechanicalRollRef, MechanicalRollRef]
    | [
        MechanicalRollRef,
        MechanicalRollRef,
        MechanicalRollRef,
        MechanicalRollRef,
        MechanicalRollRef,
        MechanicalRollRef
      ];
  next_roll: MechanicalRollRequest | null;
  outcome: MechanicalOutcome | null;
  narration: string | null;
}
/**
 * This interface was referenced by `MechanicalActionV1`'s JSON-Schema
 * via the `definition` "MechanicalActionProfile".
 */
export interface MechanicalActionProfile {
  schema_version: '1.0';
  action_id: string;
  kind: 'ATTACK';
  actor_id: string;
  target_id: string;
  effect: 'CALCULATE_DAMAGE_ONLY';
  parameter_refs: {
    /**
     * @minItems 1
     * @maxItems 8
     */
    attack_bonus:
      | [string]
      | [string, string]
      | [string, string, string]
      | [string, string, string, string]
      | [string, string, string, string, string]
      | [string, string, string, string, string, string]
      | [string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string];
    /**
     * @minItems 1
     * @maxItems 8
     */
    armor_class:
      | [string]
      | [string, string]
      | [string, string, string]
      | [string, string, string, string]
      | [string, string, string, string, string]
      | [string, string, string, string, string, string]
      | [string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string];
    /**
     * @minItems 1
     * @maxItems 8
     */
    damage_expression:
      | [string]
      | [string, string]
      | [string, string, string]
      | [string, string, string, string]
      | [string, string, string, string, string]
      | [string, string, string, string, string, string]
      | [string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string];
    /**
     * @minItems 1
     * @maxItems 8
     */
    critical_threshold:
      | [string]
      | [string, string]
      | [string, string, string]
      | [string, string, string, string]
      | [string, string, string, string, string]
      | [string, string, string, string, string, string]
      | [string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string];
    /**
     * @minItems 1
     * @maxItems 8
     */
    critical_multiplier:
      | [string]
      | [string, string]
      | [string, string, string]
      | [string, string, string, string]
      | [string, string, string, string, string]
      | [string, string, string, string, string, string]
      | [string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string];
    /**
     * @minItems 1
     * @maxItems 8
     */
    critical_immune:
      | [string]
      | [string, string]
      | [string, string, string]
      | [string, string, string, string]
      | [string, string, string, string, string]
      | [string, string, string, string, string, string]
      | [string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string];
  };
  /**
   * @minItems 1
   */
  source_refs: [string, ...string[]];
}
/**
 * This interface was referenced by `MechanicalActionV1`'s JSON-Schema
 * via the `definition` "ConfirmedAttackParameters".
 */
export interface ConfirmedAttackParameters {
  attack_bonus: number;
  armor_class: number;
  damage_expression: string;
  critical_threshold: number;
  critical_multiplier: number;
  critical_immune: boolean;
}
/**
 * This interface was referenced by `MechanicalActionV1`'s JSON-Schema
 * via the `definition` "MechanicalRollRef".
 */
export interface MechanicalRollRef {
  roll_id: string;
  expression: string;
  result: number;
  rng_counter: number;
}
/**
 * This interface was referenced by `MechanicalActionV1`'s JSON-Schema
 * via the `definition` "MechanicalRollRequest".
 */
export interface MechanicalRollRequest {
  roll_id: string;
  expression: string;
}
/**
 * This interface was referenced by `MechanicalActionV1`'s JSON-Schema
 * via the `definition` "MechanicalOutcome".
 */
export interface MechanicalOutcome {
  attack_total: number;
  natural_attack: number;
  hits: boolean;
  critical_confirmed: boolean;
  damage_total: number;
  effect: 'CALCULATE_DAMAGE_ONLY';
}
