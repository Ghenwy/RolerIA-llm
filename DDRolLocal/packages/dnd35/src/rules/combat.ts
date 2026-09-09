import type { DiceEngine, DiceState } from '@nyx/domain';
import { healthStateForHitPoints, ok, type Result } from '@nyx/domain';
import { isNonNegativeSafeInteger, isSafeInteger, ruleError, safeRuleSum, type DndRuleError } from './rule-support.js';

type DicePort = Pick<DiceEngine, 'roll'>;
export type OpportunityTrigger =
  | 'LEAVE_THREATENED_SQUARE'
  | 'DISTRACTING_ACTION'
  | 'RANGED_ATTACK'
  | 'CAST_SPELL'
  | 'SPECIAL_MANEUVER'
  | 'STAND_UP'
  | 'USE_OBJECT';

export function evaluateOpportunityAttack(input: {
  readonly trigger: OpportunityTrigger;
  readonly threatens: boolean;
  readonly line_of_effect: boolean;
  readonly conditions_allow: boolean;
  readonly used_this_round: number;
  readonly maximum_this_round: number;
  readonly protected_movement?: 'FIVE_FOOT_STEP' | 'WITHDRAWAL_FIRST_SQUARE' | 'EXPLICIT_RULE';
}): Result<{ readonly provokes: boolean; readonly reason?: 'NO_THREAT' | 'ROUND_LIMIT' | 'PROTECTED_MOVEMENT' }, DndRuleError> {
  const triggers = new Set<OpportunityTrigger>([
    'LEAVE_THREATENED_SQUARE', 'DISTRACTING_ACTION', 'RANGED_ATTACK', 'CAST_SPELL',
    'SPECIAL_MANEUVER', 'STAND_UP', 'USE_OBJECT'
  ]);
  if (!triggers.has(input.trigger)
    || !isNonNegativeSafeInteger(input.used_this_round)
    || !isNonNegativeSafeInteger(input.maximum_this_round)
    || input.maximum_this_round < 1
    || typeof input.threatens !== 'boolean'
    || typeof input.line_of_effect !== 'boolean'
    || typeof input.conditions_allow !== 'boolean') {
    return ruleError('INVALID_RULE_INPUT', 'Los datos del ataque de oportunidad no son válidos.');
  }
  if (input.trigger === 'LEAVE_THREATENED_SQUARE' && input.protected_movement !== undefined) {
    return ok({ provokes: false, reason: 'PROTECTED_MOVEMENT' });
  }
  if (!input.threatens || !input.line_of_effect || !input.conditions_allow) return ok({ provokes: false, reason: 'NO_THREAT' });
  if (input.used_this_round >= input.maximum_this_round) return ok({ provokes: false, reason: 'ROUND_LIMIT' });
  return ok({ provokes: true });
}

export function calculateThreat(input: {
  readonly size_id: string;
  readonly natural_reach_feet: number;
  readonly weapon_reach_feet: number;
  readonly distance_feet: number;
  readonly line_of_effect: boolean;
  readonly conditions_allow: boolean;
}): Result<{ readonly threatens: boolean; readonly effective_reach_feet: number }, DndRuleError> {
  if (typeof input.size_id !== 'string'
    || input.size_id.length === 0
    || !isNonNegativeSafeInteger(input.natural_reach_feet)
    || !isNonNegativeSafeInteger(input.weapon_reach_feet)
    || !isNonNegativeSafeInteger(input.distance_feet)
    || typeof input.line_of_effect !== 'boolean'
    || typeof input.conditions_allow !== 'boolean') {
    return ruleError('INVALID_RULE_INPUT', 'Tamaño, alcance, arma, posición, línea o condiciones no válidos.');
  }
  const effectiveReach = Math.max(input.natural_reach_feet, input.weapon_reach_feet);
  return ok({
    threatens: input.distance_feet <= effectiveReach && input.line_of_effect && input.conditions_allow,
    effective_reach_feet: effectiveReach
  });
}

export function coverEffects(
  cover: 'NONE' | 'STANDARD',
  geometry_and_line_justify: boolean
): Result<{ readonly armor_class_bonus: number; readonly reflex_bonus: number }, DndRuleError> {
  if (cover !== 'NONE' && cover !== 'STANDARD') return ruleError('INVALID_RULE_INPUT', 'Tipo de cobertura desconocido.');
  if (cover === 'STANDARD' && !geometry_and_line_justify) return ruleError('UNJUSTIFIED_COVER', 'La geometría no justifica cobertura.');
  return ok(cover === 'STANDARD'
    ? { armor_class_bonus: 4, reflex_bonus: 2 }
    : { armor_class_bonus: 0, reflex_bonus: 0 });
}

export function resolveConcealment(
  dice: DicePort,
  rng: DiceState,
  concealment: 'NONE' | 'CONCEALMENT' | 'TOTAL_CONCEALMENT'
): Result<{
  readonly miss_chance_percent: 0 | 20 | 50;
  readonly misses: boolean;
  readonly next_rng: DiceState;
  readonly roll_record?: ReturnType<DicePort['roll']> extends Result<infer T, unknown> ? T extends { record: infer R } ? R : never : never;
}, DndRuleError> {
  const chance = concealment === 'NONE' ? 0 : concealment === 'CONCEALMENT' ? 20 : concealment === 'TOTAL_CONCEALMENT' ? 50 : undefined;
  if (chance === undefined) return ruleError('INVALID_RULE_INPUT', 'Tipo de ocultación desconocido.');
  if (chance === 0) return ok({ miss_chance_percent: 0, misses: false, next_rng: structuredClone(rng) });
  const rolled = dice.roll(rng, '1d100');
  if (!rolled.ok || rolled.value.record.rolls[0] === undefined) return ruleError('INVALID_RULE_INPUT', 'DiceEngine no resolvió la ocultación.');
  return ok({
    miss_chance_percent: chance,
    misses: rolled.value.record.rolls[0] <= chance,
    next_rng: rolled.value.next_rng,
    roll_record: rolled.value.record
  });
}

export type HitPointState = 'ACTIVE' | 'DISABLED' | 'DYING' | 'DEAD';
export function classifyHitPoints(hpCurrent: number): Result<HitPointState, DndRuleError> {
  const health = healthStateForHitPoints(hpCurrent);
  if (health === undefined) return ruleError('INVALID_RULE_INPUT', 'Los PG deben ser un entero seguro.');
  const names = { alive: 'ACTIVE', disabled: 'DISABLED', dying: 'DYING', dead: 'DEAD' } as const;
  return ok(names[health]);
}

export function classifyNonlethalDamage(input: {
  readonly hp_current: number;
  readonly nonlethal_damage: number;
}): Result<'BELOW_THRESHOLD' | 'STAGGERED' | 'UNCONSCIOUS', DndRuleError> {
  if (!isSafeInteger(input.hp_current) || !isNonNegativeSafeInteger(input.nonlethal_damage)) {
    return ruleError('INVALID_RULE_INPUT', 'PG y daño no letal deben ser válidos.');
  }
  if (input.nonlethal_damage > input.hp_current) return ok('UNCONSCIOUS');
  if (input.nonlethal_damage === input.hp_current) return ok('STAGGERED');
  return ok('BELOW_THRESHOLD');
}

export function requiresMassiveDamageSave(input: {
  readonly damage: number;
  readonly enabled: boolean;
}): Result<{ readonly required: boolean; readonly fortitude_dc?: 15 }, DndRuleError> {
  if (!isNonNegativeSafeInteger(input.damage) || typeof input.enabled !== 'boolean') {
    return ruleError('INVALID_RULE_INPUT', 'La instancia de daño masivo no es válida.');
  }
  return input.enabled && input.damage >= 50
    ? ok({ required: true, fortitude_dc: 15 })
    : ok({ required: false });
}

export function calculateCriticalDamage(input: {
  readonly weapon_base_damage: number;
  readonly multiplicable_numeric_modifiers: readonly number[];
  readonly extra_dice_damage: readonly number[];
  readonly multiplier: number;
}): Result<number, DndRuleError> {
  if (!isNonNegativeSafeInteger(input.weapon_base_damage)
    || !Array.isArray(input.multiplicable_numeric_modifiers)
    || !Array.isArray(input.extra_dice_damage)
    || !input.multiplicable_numeric_modifiers.every(isSafeInteger)
    || !input.extra_dice_damage.every(isNonNegativeSafeInteger)
    || !isNonNegativeSafeInteger(input.multiplier)
    || input.multiplier < 1) {
    return ruleError('INVALID_RULE_INPUT', 'Los componentes del crítico no son válidos.');
  }
  const multiplicable = safeRuleSum([input.weapon_base_damage, ...input.multiplicable_numeric_modifiers]);
  if (!multiplicable.ok) return multiplicable;
  const multiplied = multiplicable.value * input.multiplier;
  if (!Number.isSafeInteger(multiplied)) return ruleError('ARITHMETIC_OVERFLOW', 'El daño crítico excede el rango seguro.');
  return safeRuleSum([multiplied, ...input.extra_dice_damage]);
}
