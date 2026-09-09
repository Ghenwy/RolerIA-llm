import { ok, type Result } from '@nyx/domain';
import { isNonNegativeSafeInteger, isSafeInteger, ruleError, safeRuleSum, type DndRuleError } from './rule-support.js';

export type TypedModifier = {
  readonly value: number;
  readonly type: string;
  readonly source: string;
  readonly circumstance?: string;
  readonly stacks?: boolean;
};

export type ModifierStack = {
  readonly total: number;
  readonly applied: readonly TypedModifier[];
  readonly suppressed: readonly TypedModifier[];
  readonly applied_count: number;
  readonly suppressed_count: number;
};

export function resolveModifierStack(
  modifiers: readonly TypedModifier[]
): Result<ModifierStack, DndRuleError> {
  if (!Array.isArray(modifiers) || modifiers.some(modifier =>
    !isSafeInteger(modifier.value)
    || typeof modifier.type !== 'string'
    || modifier.type.length === 0
    || typeof modifier.source !== 'string'
    || modifier.source.length === 0
    || (modifier.circumstance !== undefined && modifier.circumstance.length === 0)
    || (modifier.stacks !== undefined && typeof modifier.stacks !== 'boolean'))) {
    return ruleError('INVALID_RULE_INPUT', 'Cada modificador requiere valor, tipo y fuente válidos.');
  }

  const applied: TypedModifier[] = [];
  const suppressed: TypedModifier[] = [];
  const seenSources = new Set<string>();
  const bestTypedBonus = new Map<string, number>();
  const bestCircumstance = new Map<string, number>();

  for (const modifier of modifiers) {
    const sourceKey = `${modifier.type}\u0000${modifier.source}`;
    if (seenSources.has(sourceKey) && modifier.stacks !== true) {
      suppressed.push(modifier);
      continue;
    }
    seenSources.add(sourceKey);

    const isPenalty = modifier.value < 0;
    const alwaysStacks = modifier.stacks === true
      || modifier.type === 'dodge'
      || modifier.type === 'untyped'
      || isPenalty;
    if (alwaysStacks) {
      applied.push(modifier);
      continue;
    }

    const group = modifier.type === 'circumstance'
      ? `circumstance:${modifier.circumstance ?? 'UNSPECIFIED'}`
      : modifier.type;
    const selected = modifier.type === 'circumstance' ? bestCircumstance : bestTypedBonus;
    const previousIndex = selected.get(group);
    if (previousIndex === undefined) {
      selected.set(group, applied.length);
      applied.push(modifier);
      continue;
    }
    if (modifier.value > applied[previousIndex]!.value) {
      suppressed.push(applied[previousIndex]!);
      applied[previousIndex] = modifier;
    } else {
      suppressed.push(modifier);
    }
  }

  const total = safeRuleSum(applied.map(modifier => modifier.value));
  if (!total.ok) return total;
  return ok({
    total: total.value,
    applied,
    suppressed,
    applied_count: applied.length,
    suppressed_count: suppressed.length
  });
}

export type ActionType = 'standard' | 'move' | 'full_round' | 'free' | 'swift' | 'immediate' | 'not_an_action';

export function validateActionEconomy(input: {
  readonly actions: readonly ActionType[];
  readonly previous_turn_immediate_used?: boolean;
}): Result<{ readonly next_turn_swift_available: boolean }, DndRuleError> {
  const allowed = new Set<ActionType>(['standard', 'move', 'full_round', 'free', 'swift', 'immediate', 'not_an_action']);
  if (!Array.isArray(input.actions)
    || input.actions.some(action => !allowed.has(action))
    || (input.previous_turn_immediate_used !== undefined && typeof input.previous_turn_immediate_used !== 'boolean')) {
    return ruleError('INVALID_RULE_INPUT', 'La lista de acciones no es válida.');
  }
  const count = (type: ActionType): number => input.actions.filter(action => action === type).length;
  const hasFullRound = count('full_round') > 0;
  const exceeds = count('standard') > 1
    || count('move') > 1
    || count('full_round') > 1
    || count('swift') > 1
    || count('immediate') > 1
    || (hasFullRound && (count('standard') > 0 || count('move') > 0))
    || (input.previous_turn_immediate_used === true && count('swift') > 0);
  if (exceeds) return ruleError('ACTION_BUDGET_EXCEEDED', 'La economía de acciones del turno ha sido excedida.');
  return ok({ next_turn_swift_available: count('immediate') === 0 });
}

export function validateFiveFootStep(input: {
  readonly other_movement_feet: number;
}): Result<{ readonly provokes_for_displacement: false }, DndRuleError> {
  if (!isNonNegativeSafeInteger(input.other_movement_feet)) {
    return ruleError('INVALID_RULE_INPUT', 'La distancia de movimiento debe ser válida.');
  }
  if (input.other_movement_feet !== 0) {
    return ruleError('MOVEMENT_CONFLICT', 'El paso de 5 pies no admite otro movimiento real.');
  }
  return ok({ provokes_for_displacement: false });
}

export function validateCharge(input: {
  readonly action: ActionType;
  readonly distance_feet: number;
  readonly speed_feet: number;
  readonly path_clear: boolean;
  readonly terrain_valid: boolean;
}): Result<{ readonly attack_bonus: 2; readonly armor_class_penalty: -2 }, DndRuleError> {
  if (!isNonNegativeSafeInteger(input.distance_feet)
    || !isNonNegativeSafeInteger(input.speed_feet)
    || typeof input.path_clear !== 'boolean'
    || typeof input.terrain_valid !== 'boolean') {
    return ruleError('INVALID_RULE_INPUT', 'Los datos de carga no son válidos.');
  }
  const maximum = input.speed_feet * 2;
  if (!Number.isSafeInteger(maximum)
    || input.action !== 'full_round'
    || input.distance_feet < 10
    || input.distance_feet > maximum
    || !input.path_clear
    || !input.terrain_valid) {
    return ruleError('INVALID_CHARGE', 'La carga no satisface acción, distancia, trayectoria o terreno.');
  }
  return ok({ attack_bonus: 2, armor_class_penalty: -2 });
}
