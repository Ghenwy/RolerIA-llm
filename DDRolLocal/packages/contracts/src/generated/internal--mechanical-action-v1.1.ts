/* GENERATED FILE - DO NOT EDIT. source=internal/mechanical-action-v1.1.schema.json schema_sha256=7185eed1cdcab170a395eaaf68b886b75fc1c82a3a0d9ff07c8194ee8b864af3 */

/**
 * [DESIGN] Alpha normal registered weapon attack with code-only canonical health damage. Historical v1.0 remains unchanged. REQ-DND-006/007 and REQ-ST-003/011. target_health_snapshot is a literal copy of the protected Dnd35 health facet, checked by contract tests.
 */
export interface MechanicalActionV11 {
  schema_version: '1.1';
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
  target_health_snapshot: TargetHealthSnapshot;
}
/**
 * This interface was referenced by `MechanicalActionV11`'s JSON-Schema
 * via the `definition` "MechanicalActionProfile".
 */
export interface MechanicalActionProfile {
  schema_version: '1.1';
  action_id: string;
  kind: 'ATTACK';
  actor_id: string;
  target_id: string;
  effect: 'APPLY_WEAPON_DAMAGE';
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
  /**
   * Explicit source-gated attestation that this normal weapon action has no unsupported effects. Missing or nonempty is rejected.
   *
   * @maxItems 0
   */
  unsupported_effects: [];
}
/**
 * This interface was referenced by `MechanicalActionV11`'s JSON-Schema
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
 * This interface was referenced by `MechanicalActionV11`'s JSON-Schema
 * via the `definition` "MechanicalRollRef".
 */
export interface MechanicalRollRef {
  roll_id: string;
  expression: string;
  result: number;
  rng_counter: number;
}
/**
 * This interface was referenced by `MechanicalActionV11`'s JSON-Schema
 * via the `definition` "MechanicalRollRequest".
 */
export interface MechanicalRollRequest {
  roll_id: string;
  expression: string;
}
/**
 * This interface was referenced by `MechanicalActionV11`'s JSON-Schema
 * via the `definition` "MechanicalOutcome".
 */
export interface MechanicalOutcome {
  attack_total: number;
  natural_attack: number;
  hits: boolean;
  critical_confirmed: boolean;
  damage_total: number;
  effect: 'APPLY_WEAPON_DAMAGE';
}
/**
 * This interface was referenced by `MechanicalActionV11`'s JSON-Schema
 * via the `definition` "TargetHealthSnapshot".
 */
export interface TargetHealthSnapshot {
  hp_max: number;
  hp_current: number;
  temporary_hp: number;
  nonlethal_damage: number;
  hit_dice: string[];
  death_state: 'alive' | 'disabled' | 'dying' | 'stable' | 'dead' | 'destroyed';
}
