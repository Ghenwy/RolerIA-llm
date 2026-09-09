import { validateJsonSchema } from '@nyx/contracts';
import { DiceEngine, err, ok, type DiceState, type Result } from '@nyx/domain';
import * as math from '../math/fundamental-formulas.js';
import * as actions from './modifiers-actions.js';
import * as combat from './combat.js';
import * as movement from './movement-maneuvers.js';
import * as magic from './magic-psionics.js';
import * as monster from './monster-multiclass.js';
import { getCondition } from './conditions.js';

type CalculationResult = Result<unknown, { code: string; message: string }>;
const n = { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };
const s = { type: 'string', minLength: 1, maxLength: 4096 };
const b = { type: 'boolean' };
const list = (items: object) => ({ type: 'array', maxItems: 4096, items });
const ns = list(n);
const ss = list(s);
const object = (properties: Record<string, object>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const enums = (...values: string[]) => ({ enum: values });
function bind<T>(schema: object, run: (input: T, rng: DiceState) => CalculationResult): (input: unknown, rng: DiceState) => CalculationResult {
  return (input, rng) => validateJsonSchema(schema, input).ok ? run(input as T, rng)
    : err({ code: 'SCHEMA_INVALID', message: 'Argumentos del cálculo fuera del contrato permitido.' });
}
const dice = new DiceEngine();
const action = enums('standard', 'move', 'full_round', 'free', 'swift', 'immediate', 'not_an_action');
const classLevel = object({ class_id: s, class_kind: enums('BASE', 'PRESTIGE'), class_level: n });
const calculations: Record<string, (input: unknown, rng: DiceState) => CalculationResult> = {
  armor_class: bind(object({ armor: n, shield: n, dexterity_modifier: n, size_modifier: n, natural_armor: n, deflection: n, dodge: n, other_modifiers: n, modifiers_lost_when_dex_denied: n }), math.calculateArmorClasses),
  check: bind<math.GeneralCheckInput>(object({ ability_modifier: n, ranks: n, typed_modifiers: ns, untyped_modifiers: ns, dc: n }), (input, rng) => math.resolveGeneralCheck(dice, rng, input)),
  save: bind<math.SavingThrowInput>(object({ base_save: n, ability_modifier: n, modifiers: ns, dc: n }), (input, rng) => math.resolveSavingThrow(dice, rng, input)),
  attack: bind<math.AttackInput>(object({ attack_kind: enums('MELEE', 'RANGED'), base_attack_bonus: n, strength_modifier: n, dexterity_modifier: n, size_modifier: n, modifiers: ns, armor_class: n }), (input, rng) => math.resolveAttack(dice, rng, input)),
  initiative: bind<math.InitiativeInput>(object({ dexterity_modifier: n, initiative_modifiers: ns }), (input, rng) => math.rollInitiative(dice, rng, input)),
  spell_resistance: bind<{ caster_level: number; resistance: number }>(object({ caster_level: n, resistance: n }), (input, rng) => math.resolveSpellResistance(dice, rng, input)),
  power_resistance: bind<{ manifester_level: number; resistance: number }>(object({ manifester_level: n, resistance: n }), (input, rng) => math.resolvePowerResistance(dice, rng, input)),
  spell_dc: bind<{ spell_level: number; key_ability_modifier: number; modifiers: number[] }>(object({ spell_level: n, key_ability_modifier: n, modifiers: ns }), input => math.spellSaveDc(input.spell_level, input.key_ability_modifier, input.modifiers)),
  power_dc: bind<{ power_level: number; key_ability_modifier: number; modifiers: number[] }>(object({ power_level: n, key_ability_modifier: n, modifiers: ns }), input => math.powerSaveDc(input.power_level, input.key_ability_modifier, input.modifiers)),
  stacking: bind(list(object({ value: n, type: s, source: s, circumstance: s, stacks: b }, ['value', 'type', 'source'])), actions.resolveModifierStack),
  actions: bind(object({ actions: list(action), previous_turn_immediate_used: b }, ['actions']), actions.validateActionEconomy),
  five_foot_step: bind(object({ other_movement_feet: n }), actions.validateFiveFootStep),
  charge: bind(object({ action, distance_feet: n, speed_feet: n, path_clear: b, terrain_valid: b }), actions.validateCharge),
  opportunity_attack: bind(object({ trigger: enums('LEAVE_THREATENED_SQUARE', 'DISTRACTING_ACTION', 'RANGED_ATTACK', 'CAST_SPELL', 'SPECIAL_MANEUVER', 'STAND_UP', 'USE_OBJECT'),
    threatens: b, line_of_effect: b, conditions_allow: b, used_this_round: n, maximum_this_round: n,
    protected_movement: enums('FIVE_FOOT_STEP', 'WITHDRAWAL_FIRST_SQUARE', 'EXPLICIT_RULE') }, ['trigger', 'threatens', 'line_of_effect', 'conditions_allow', 'used_this_round', 'maximum_this_round']), combat.evaluateOpportunityAttack),
  threat: bind(object({ size_id: s, natural_reach_feet: n, weapon_reach_feet: n, distance_feet: n, line_of_effect: b, conditions_allow: b }), combat.calculateThreat),
  cover: bind<{ cover: 'NONE' | 'STANDARD'; geometry_and_line_justify: boolean }>(object({ cover: enums('NONE', 'STANDARD'), geometry_and_line_justify: b }), input => combat.coverEffects(input.cover, input.geometry_and_line_justify)),
  concealment: bind<'NONE' | 'CONCEALMENT' | 'TOTAL_CONCEALMENT'>(enums('NONE', 'CONCEALMENT', 'TOTAL_CONCEALMENT'), (input, rng) => combat.resolveConcealment(dice, rng, input)),
  hit_points: bind(n, combat.classifyHitPoints),
  nonlethal: bind(object({ hp_current: n, nonlethal_damage: n }), combat.classifyNonlethalDamage),
  massive_damage: bind(object({ damage: n, enabled: b }), combat.requiresMassiveDamageSave),
  critical_damage: bind(object({ weapon_base_damage: n, multiplicable_numeric_modifiers: ns, extra_dice_damage: ns, multiplier: n }), combat.calculateCriticalDamage),
  diagonal_movement: bind(n, movement.diagonalMovementCost),
  grapple: bind(object({ base_attack_bonus: n, strength_modifier: n, special_size_modifier: n, modifiers: ns }), movement.grappleCheck),
  withdrawal: bind(object({ distance_feet: n, speed_feet: n }), movement.validateWithdrawal),
  withdrawal_provocation: bind({ ...n, minimum: 0, maximum: 4096 }, movement.withdrawalProvocation),
  powerful_build: bind(object({ space_feet: n, reach_feet: n, powerful_build: b }), movement.powerfulBuildSpaceAndReach),
  maneuver_plan: bind(enums('GRAPPLE', 'TRIP', 'BULL_RUSH', 'DISARM', 'SUNDER', 'OVERRUN'), movement.planCombatManeuver),
  concentration_dc: bind({ oneOf: [object({ kind: { const: 'DEFENSIVE' }, spell_level: n }), object({ kind: { const: 'DAMAGE_WHILE_CASTING' }, spell_level: n, damage_taken: n })] }, magic.concentrationDc),
  concentration: bind(object({ check_total: n, dc: n }), magic.resolveConcentration),
  spell_cast: bind(object({ spell: object({ source_class: s, spell_level: n, caster_level: n, ability: s, access: enums('PREPARED', 'KNOWN'), slot: s,
    components: ss, casting_time: s, range: s, target_or_area: s, duration: s, saving_throw: s, spell_resistance: b, material_cost_gp: n, xp_cost: n }), accepted: b }), magic.validateSpellCast),
  power_reserve: bind(object({ classes: list(object({ source_id: s, class_pp: n, bonus_pp: n, powers_known: ss, manifester_level: n })), racial_pp: n, other_sources: n }), magic.calculatePowerPointReserve),
  power_spend: bind(object({ pp_spent: n, manifester_level: n, explicit_exception: b }), magic.validatePowerPointSpend),
  power_augmentation: bind(object({ base_cost: n, augmentation_cost: n, manifester_level: n, base_save_dc: n, save_dc_increase: n, rule_explicitly_increases_dc: b }), magic.validatePowerAugmentation),
  transparency: bind<boolean>(b, input => ok(magic.psionicTransparency(input))),
  condition: bind<string>(s, input => { const value = getCondition(input); return value === undefined ? err({ code: 'UNREGISTERED_CONDITION', message: 'Condición no registrada.' }) : ok(value); }),
  monster_character: bind(object({ racial_entry_hd: n, racial_hd_policy: enums('REPLACE_WITH_FIRST_CLASS_LEVEL', 'RETAIN'), class_levels: list(classLevel), level_adjustment: n, racial_class_skills: ss }), monster.deriveMonstrousCharacter),
  class_progressions: bind(list(object({ source_id: s, kind: enums('BASE', 'PRESTIGE'), levels: n, bab: n, fortitude: n, reflex: n, will: n, caster_advancement: n, manifester_advancement: n,
    skill_points: n, features: ss, prerequisites_met_before_first_level: b }, ['source_id', 'kind', 'levels', 'bab', 'fortitude', 'reflex', 'will', 'caster_advancement', 'manifester_advancement'])), monster.combineClassProgressions)
};

/** Only existing deterministic functions are callable; there is no eval or expression DSL. */
export function runApplicationCalculation(kind: string, input: unknown, rng: DiceState): CalculationResult {
  return Object.hasOwn(calculations, kind) ? calculations[kind]!(input, structuredClone(rng))
    : err({ code: 'SCHEMA_INVALID', message: 'Operación no registrada.' });
}
