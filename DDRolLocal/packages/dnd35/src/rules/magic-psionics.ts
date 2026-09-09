import { ok, type Result } from '@nyx/domain';
import { isNonNegativeSafeInteger, ruleError, safeRuleSum, type DndRuleError } from './rule-support.js';

export type ConcentrationInput =
  | { readonly kind: 'DEFENSIVE'; readonly spell_level: number }
  | { readonly kind: 'DAMAGE_WHILE_CASTING'; readonly spell_level: number; readonly damage_taken: number };

export function concentrationDc(input: ConcentrationInput): Result<number, DndRuleError> {
  if (!isNonNegativeSafeInteger(input.spell_level)
    || (input.kind === 'DAMAGE_WHILE_CASTING' && !isNonNegativeSafeInteger(input.damage_taken))) {
    return ruleError('INVALID_RULE_INPUT', 'Los términos de Concentration no son válidos.');
  }
  return input.kind === 'DEFENSIVE'
    ? safeRuleSum([15, input.spell_level])
    : safeRuleSum([10, input.damage_taken, input.spell_level]);
}

export function resolveConcentration(input: {
  readonly check_total: number;
  readonly dc: number;
}): Result<{ readonly succeeds: boolean; readonly spell_lost: boolean }, DndRuleError> {
  if (!isNonNegativeSafeInteger(input.check_total) || !isNonNegativeSafeInteger(input.dc)) {
    return ruleError('INVALID_RULE_INPUT', 'El total y la CD de Concentration no son válidos.');
  }
  const succeeds = input.check_total >= input.dc;
  return ok({ succeeds, spell_lost: !succeeds });
}

export type SpellCastRecord = {
  readonly source_class: string;
  readonly spell_level: number;
  readonly caster_level: number;
  readonly ability: string;
  readonly access: 'PREPARED' | 'KNOWN';
  readonly slot: string;
  readonly components: readonly string[];
  readonly casting_time: string;
  readonly range: string;
  readonly target_or_area: string;
  readonly duration: string;
  readonly saving_throw: string;
  readonly spell_resistance: boolean;
  readonly material_cost_gp: number;
  readonly xp_cost: number;
};

export function validateSpellCast(input: {
  readonly spell: SpellCastRecord;
  readonly accepted: boolean;
}): Result<{ readonly resource_consumed: boolean; readonly spell: SpellCastRecord }, DndRuleError> {
  const spell = input.spell;
  const strings = [spell.source_class, spell.ability, spell.slot, spell.casting_time, spell.range,
    spell.target_or_area, spell.duration, spell.saving_throw];
  if (typeof input.accepted !== 'boolean'
    || !strings.every(value => typeof value === 'string' && value.length > 0)
    || !isNonNegativeSafeInteger(spell.spell_level)
    || !isNonNegativeSafeInteger(spell.caster_level)
    || (spell.access !== 'PREPARED' && spell.access !== 'KNOWN')
    || !Array.isArray(spell.components)
    || !spell.components.every(component => typeof component === 'string' && component.length > 0)
    || typeof spell.spell_resistance !== 'boolean'
    || !isNonNegativeSafeInteger(spell.material_cost_gp)
    || !isNonNegativeSafeInteger(spell.xp_cost)) {
    return ruleError('INVALID_RULE_INPUT', 'El registro de lanzamiento está incompleto o no es válido.');
  }
  return ok({ resource_consumed: input.accepted, spell: structuredClone(spell) });
}

export type PsionicClassReserve = {
  readonly source_id: string;
  readonly class_pp: number;
  readonly bonus_pp: number;
  readonly powers_known: readonly string[];
  readonly manifester_level: number;
};

export function calculatePowerPointReserve(input: {
  readonly classes: readonly PsionicClassReserve[];
  readonly racial_pp: number;
  readonly other_sources: number;
}): Result<{
  readonly total_pp: number;
  readonly progressions: readonly Pick<PsionicClassReserve, 'source_id' | 'powers_known' | 'manifester_level'>[];
}, DndRuleError> {
  if (!Array.isArray(input.classes)
    || !isNonNegativeSafeInteger(input.racial_pp)
    || !isNonNegativeSafeInteger(input.other_sources)
    || input.classes.some(entry => entry.source_id.length === 0
      || !isNonNegativeSafeInteger(entry.class_pp)
      || !isNonNegativeSafeInteger(entry.bonus_pp)
      || !isNonNegativeSafeInteger(entry.manifester_level)
      || !Array.isArray(entry.powers_known)
      || !entry.powers_known.every((power: unknown) => typeof power === 'string' && power.length > 0))
    || new Set(input.classes.map(entry => entry.source_id)).size !== input.classes.length) {
    return ruleError('INVALID_RULE_INPUT', 'Las reservas psiónicas no son válidas.');
  }
  const total = safeRuleSum([
    ...input.classes.flatMap(entry => [entry.class_pp, entry.bonus_pp]),
    input.racial_pp,
    input.other_sources
  ]);
  if (!total.ok) return total;
  return ok({
    total_pp: total.value,
    progressions: input.classes.map(entry => ({
      source_id: entry.source_id,
      manifester_level: entry.manifester_level,
      powers_known: [...entry.powers_known]
    }))
  });
}

export function validatePowerPointSpend(input: {
  readonly pp_spent: number;
  readonly manifester_level: number;
  readonly explicit_exception: boolean;
}): Result<{ readonly allowed: true }, DndRuleError> {
  if (!isNonNegativeSafeInteger(input.pp_spent)
    || !isNonNegativeSafeInteger(input.manifester_level)
    || typeof input.explicit_exception !== 'boolean') {
    return ruleError('INVALID_RULE_INPUT', 'El gasto de PP no es válido.');
  }
  if (input.pp_spent > input.manifester_level && !input.explicit_exception) {
    return ruleError('POWER_POINT_LIMIT', 'PP_spent no puede superar manifester_level sin excepción explícita.');
  }
  return ok({ allowed: true });
}

export function validatePowerAugmentation(input: {
  readonly base_cost: number;
  readonly augmentation_cost: number;
  readonly manifester_level: number;
  readonly base_save_dc: number;
  readonly save_dc_increase: number;
  readonly rule_explicitly_increases_dc: boolean;
}): Result<{ readonly total_cost: number; readonly save_dc: number }, DndRuleError> {
  if (![input.base_cost, input.augmentation_cost, input.manifester_level,
    input.base_save_dc, input.save_dc_increase].every(isNonNegativeSafeInteger)
    || typeof input.rule_explicitly_increases_dc !== 'boolean') {
    return ruleError('INVALID_RULE_INPUT', 'Los términos de augmentación no son válidos.');
  }
  if (input.save_dc_increase > 0 && !input.rule_explicitly_increases_dc) {
    return ruleError('INVALID_RULE_INPUT', 'La CD sólo aumenta cuando la regla del poder lo indica.');
  }
  const cost = safeRuleSum([input.base_cost, input.augmentation_cost]);
  if (!cost.ok) return cost;
  const allowed = validatePowerPointSpend({
    pp_spent: cost.value,
    manifester_level: input.manifester_level,
    explicit_exception: false
  });
  if (!allowed.ok) return allowed;
  const saveDc = safeRuleSum([input.base_save_dc, input.save_dc_increase]);
  if (!saveDc.ok) return saveDc;
  return ok({ total_cost: cost.value, save_dc: saveDc.value });
}

export function psionicTransparency(explicitHouseRuleDisables: boolean): {
  readonly spell_resistance_as_power_resistance: boolean;
  readonly dispel_interacts: boolean;
  readonly detection_interacts: boolean;
} {
  const enabled = !explicitHouseRuleDisables;
  return {
    spell_resistance_as_power_resistance: enabled,
    dispel_interacts: enabled,
    detection_interacts: enabled
  };
}
