import { ok, type Result } from '@nyx/domain';
import { isNonNegativeSafeInteger, isSafeInteger, ruleError, safeRuleSum, type DndRuleError } from './rule-support.js';

export function diagonalMovementCost(diagonalCount: number): Result<number, DndRuleError> {
  if (!isNonNegativeSafeInteger(diagonalCount)) return ruleError('INVALID_RULE_INPUT', 'El número de diagonales no es válido.');
  const total = Math.floor(diagonalCount / 2) * 15 + (diagonalCount % 2) * 5;
  return Number.isSafeInteger(total) ? ok(total) : ruleError('ARITHMETIC_OVERFLOW', 'El movimiento excede el rango seguro.');
}

export function powerfulBuildSpaceAndReach(input: {
  readonly space_feet: number;
  readonly reach_feet: number;
  readonly powerful_build: boolean;
}): Result<{ readonly space_feet: number; readonly reach_feet: number }, DndRuleError> {
  if (!isNonNegativeSafeInteger(input.space_feet)
    || !isNonNegativeSafeInteger(input.reach_feet)
    || typeof input.powerful_build !== 'boolean') {
    return ruleError('INVALID_RULE_INPUT', 'Espacio, alcance o Powerful Build no válidos.');
  }
  return ok({ space_feet: input.space_feet, reach_feet: input.reach_feet });
}

export function withdrawalProvocation(squaresLeft: number): Result<readonly boolean[], DndRuleError> {
  if (!isNonNegativeSafeInteger(squaresLeft)) return ruleError('INVALID_RULE_INPUT', 'El número de casillas no es válido.');
  return ok(Array.from({ length: squaresLeft }, (_, index) => index > 0));
}

export function validateWithdrawal(input: {
  readonly distance_feet: number;
  readonly speed_feet: number;
}): Result<{ readonly maximum_distance_feet: number }, DndRuleError> {
  if (!isNonNegativeSafeInteger(input.distance_feet) || !isNonNegativeSafeInteger(input.speed_feet)) {
    return ruleError('INVALID_RULE_INPUT', 'La distancia o velocidad de retirada no es válida.');
  }
  const maximum = input.speed_feet * 2;
  if (!Number.isSafeInteger(maximum)) return ruleError('ARITHMETIC_OVERFLOW', 'La retirada excede el rango seguro.');
  if (input.distance_feet > maximum) return ruleError('MOVEMENT_CONFLICT', 'La retirada no puede superar el doble de la velocidad.');
  return ok({ maximum_distance_feet: maximum });
}

export type SizeRuleProfile = {
  readonly size_id: string;
  readonly attack_armor_class_modifier: number;
  readonly hide_modifier: number;
  readonly grapple_modifier: number;
  readonly space_feet: number;
  readonly reach_feet: number;
  readonly carrying_capacity_multiplier: number;
  readonly weapon_size_id: string;
};

export function validateSizeProfile(profile: SizeRuleProfile): Result<SizeRuleProfile, DndRuleError> {
  if (profile.size_id.length === 0
    || profile.weapon_size_id.length === 0
    || !isSafeInteger(profile.attack_armor_class_modifier)
    || !isSafeInteger(profile.hide_modifier)
    || !isSafeInteger(profile.grapple_modifier)
    || !isNonNegativeSafeInteger(profile.space_feet)
    || !isNonNegativeSafeInteger(profile.reach_feet)
    || !isNonNegativeSafeInteger(profile.carrying_capacity_multiplier)
    || profile.carrying_capacity_multiplier < 1) {
    return ruleError('INVALID_RULE_INPUT', 'Todos los canales afectados por tamaño deben ser explícitos y válidos.');
  }
  return ok(structuredClone(profile));
}

export type ManeuverKind = 'GRAPPLE' | 'TRIP' | 'BULL_RUSH' | 'DISARM' | 'SUNDER' | 'OVERRUN';
const MANEUVER_STEPS = {
  GRAPPLE: ['PROVOKE_AOO_UNLESS_PROTECTED', 'MELEE_TOUCH_ATTACK', 'OPPOSED_GRAPPLE_CHECK', 'APPLY_GRAPPLE_STATE'],
  TRIP: ['MELEE_TOUCH_ATTACK', 'OPPOSED_STRENGTH_OR_DEXTERITY', 'APPLY_SIZE_STABILITY', 'COUNTERTRIP_IF_ALLOWED'],
  BULL_RUSH: ['OPPOSED_STRENGTH', 'VALIDATE_MOVEMENT_PATH'],
  DISARM: ['OPPOSED_ATTACK_ROLLS', 'APPLY_WEAPON_MODIFIERS'],
  SUNDER: ['ATTACK_HELD_OBJECT', 'APPLY_HARDNESS_AND_HIT_POINTS'],
  OVERRUN: ['TARGET_AVOIDS_OR_BLOCKS', 'OPPOSED_STRENGTH_OR_DEXTERITY']
} as const satisfies Record<ManeuverKind, readonly string[]>;

export function planCombatManeuver(kind: ManeuverKind): Result<{
  readonly kind: ManeuverKind;
  readonly steps: readonly string[];
  readonly requires_full_srd_resolution: true;
}, DndRuleError> {
  if (!Object.hasOwn(MANEUVER_STEPS, kind)) return ruleError('INVALID_RULE_INPUT', 'Maniobra desconocida.');
  return ok({ kind, steps: MANEUVER_STEPS[kind], requires_full_srd_resolution: true });
}

export function grappleCheck(input: {
  readonly base_attack_bonus: number;
  readonly strength_modifier: number;
  readonly special_size_modifier: number;
  readonly modifiers: readonly number[];
}): Result<number, DndRuleError> {
  if (!isSafeInteger(input.base_attack_bonus)
    || !isSafeInteger(input.strength_modifier)
    || !isSafeInteger(input.special_size_modifier)
    || !Array.isArray(input.modifiers)
    || !input.modifiers.every(isSafeInteger)) {
    return ruleError('INVALID_RULE_INPUT', 'Los términos de grapple no son válidos.');
  }
  return safeRuleSum([input.base_attack_bonus, input.strength_modifier, input.special_size_modifier, ...input.modifiers]);
}
