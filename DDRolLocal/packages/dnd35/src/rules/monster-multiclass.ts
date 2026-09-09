import { ok, type Result } from '@nyx/domain';
import { deriveLevelIdentities, type QualifiedClassLevel } from '../math/level-identities.js';
import { isNonNegativeSafeInteger, ruleError, safeRuleSum, type DndRuleError } from './rule-support.js';

export function deriveMonstrousCharacter(input: {
  readonly racial_entry_hd: number;
  readonly racial_hd_policy: 'REPLACE_WITH_FIRST_CLASS_LEVEL' | 'RETAIN';
  readonly class_levels: readonly QualifiedClassLevel[];
  readonly level_adjustment: number;
  readonly racial_class_skills: readonly string[];
}): Result<{
  readonly racial_hit_dice: number;
  readonly class_level_total: number;
  readonly total_hd: number;
  readonly ecl: number;
  readonly feat_and_ability_progression_basis: number;
  readonly xp_and_starting_wealth_basis: number;
  readonly racial_class_skills: readonly string[];
  readonly level_adjustment_benefits: {
    readonly hit_points: 0; readonly base_attack_bonus: 0; readonly saves: 0; readonly skill_points: 0; readonly feats: 0;
  };
  readonly level_adjustment_buyoff_enabled: false;
}, DndRuleError> {
  if (!isNonNegativeSafeInteger(input.racial_entry_hd)
    || !isNonNegativeSafeInteger(input.level_adjustment)
    || !Array.isArray(input.class_levels)
    || !Array.isArray(input.racial_class_skills)
    || !input.racial_class_skills.every(skill => typeof skill === 'string' && skill.length > 0)
    || (input.racial_hd_policy !== 'REPLACE_WITH_FIRST_CLASS_LEVEL' && input.racial_hd_policy !== 'RETAIN')
    || (input.racial_hd_policy === 'REPLACE_WITH_FIRST_CLASS_LEVEL' && input.racial_entry_hd > 1)) {
    return ruleError('INVALID_RULE_INPUT', 'Los datos de personaje monstruoso no son válidos.');
  }
  const classTotal = input.class_levels.reduce((total, entry) => total + entry.class_level, 0);
  if (!Number.isSafeInteger(classTotal)) return ruleError('ARITHMETIC_OVERFLOW', 'La suma de niveles de clase excede el rango seguro.');
  const racialHitDice = input.racial_hd_policy === 'REPLACE_WITH_FIRST_CLASS_LEVEL' && classTotal > 0
    ? 0
    : input.racial_entry_hd;
  const identities = deriveLevelIdentities({
    class_levels: input.class_levels,
    racial_hit_dice: racialHitDice,
    level_adjustment: input.level_adjustment,
    caster_levels: [],
    manifester_levels: []
  });
  if (!identities.ok) return ruleError('INVALID_RULE_INPUT', identities.error.message);
  return ok({
    racial_hit_dice: identities.value.racial_hit_dice,
    class_level_total: identities.value.class_level_total,
    total_hd: identities.value.total_hd,
    ecl: identities.value.ecl,
    feat_and_ability_progression_basis: identities.value.total_hd,
    xp_and_starting_wealth_basis: identities.value.ecl,
    racial_class_skills: [...input.racial_class_skills],
    level_adjustment_benefits: { hit_points: 0, base_attack_bonus: 0, saves: 0, skill_points: 0, feats: 0 },
    level_adjustment_buyoff_enabled: false
  });
}

export type ClassProgression = {
  readonly source_id: string;
  readonly kind: 'BASE' | 'PRESTIGE';
  readonly levels: number;
  readonly bab: number;
  readonly fortitude: number;
  readonly reflex: number;
  readonly will: number;
  readonly caster_advancement: number;
  readonly manifester_advancement: number;
  readonly skill_points?: number;
  readonly features?: readonly string[];
  readonly prerequisites_met_before_first_level?: boolean;
};

export function combineClassProgressions(
  progressions: readonly ClassProgression[]
): Result<{
  readonly progressions: readonly ClassProgression[];
  readonly class_level_total: number;
  readonly class_hit_dice: number;
  readonly base_attack_bonus: number;
  readonly saves: { readonly fortitude: number; readonly reflex: number; readonly will: number };
  readonly caster_advancement: number;
  readonly manifester_advancement: number;
  readonly skill_points: number;
  readonly features_by_source: Readonly<Record<string, readonly string[]>>;
  readonly prestige_multiclass_xp_penalty: false;
  readonly lose_features_when_requirements_later_fail: false;
}, DndRuleError> {
  if (!Array.isArray(progressions)
    || new Set(progressions.map(entry => entry.source_id)).size !== progressions.length
    || progressions.some(entry => entry.source_id.length === 0
      || (entry.kind !== 'BASE' && entry.kind !== 'PRESTIGE')
      || ![entry.levels, entry.bab, entry.fortitude, entry.reflex, entry.will,
        entry.caster_advancement, entry.manifester_advancement, entry.skill_points ?? 0]
        .every(isNonNegativeSafeInteger)
      || (entry.features !== undefined && (!Array.isArray(entry.features)
        || !entry.features.every((feature: unknown) => typeof feature === 'string' && feature.length > 0))))) {
    return ruleError('INVALID_RULE_INPUT', 'Las progresiones de clase no son válidas.');
  }
  if (progressions.some(entry => entry.kind === 'PRESTIGE'
    && entry.levels > 0
    && entry.prerequisites_met_before_first_level === false)) {
    return ruleError('PRESTIGE_PREREQUISITES_NOT_MET', 'Los requisitos deben cumplirse antes del primer nivel de prestigio.');
  }
  const totals = [
    progressions.map(entry => entry.levels),
    progressions.map(entry => entry.bab),
    progressions.map(entry => entry.fortitude),
    progressions.map(entry => entry.reflex),
    progressions.map(entry => entry.will),
    progressions.map(entry => entry.caster_advancement),
    progressions.map(entry => entry.manifester_advancement),
    progressions.map(entry => entry.skill_points ?? 0)
  ].map(safeRuleSum);
  const failed = totals.find(result => !result.ok);
  if (failed && !failed.ok) return failed;
  const values = totals.map(result => result.ok ? result.value : 0);
  return ok({
    progressions: structuredClone(progressions),
    class_level_total: values[0]!,
    class_hit_dice: values[0]!,
    base_attack_bonus: values[1]!,
    saves: { fortitude: values[2]!, reflex: values[3]!, will: values[4]! },
    caster_advancement: values[5]!,
    manifester_advancement: values[6]!,
    skill_points: values[7]!,
    features_by_source: Object.fromEntries(progressions.map(entry => [entry.source_id, [...(entry.features ?? [])]])),
    prestige_multiclass_xp_penalty: false,
    lose_features_when_requirements_later_fail: false
  });
}
