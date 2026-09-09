import { validateRuntimeContract, type SotDD35CharacterExtension } from '@nyx/contracts';
import { DND35_CONDITIONS } from '../rules/conditions.js';

export type CharacterExtension = SotDD35CharacterExtension.UrnNyxRpgDnd35CharacterExtension10;

type Saves = { readonly fortitude: number; readonly reflex: number; readonly will: number };
type ComputedCharacterFields = {
  readonly class_level_total: number;
  readonly racial_hit_dice: number;
  readonly total_hd: number;
  readonly level_adjustment: number;
  readonly ecl: number;
  readonly bab: number;
  readonly saves: Saves;
  readonly caster_advancement: number;
  readonly manifester_advancement: number;
};
type Correction = { readonly field: string; readonly expected: unknown };
export type CharacterValidationReport = {
  readonly status: 'pass' | 'fail';
  readonly computed?: ComputedCharacterFields;
  readonly discrepancies: readonly string[];
  readonly corrective_proposals: readonly Correction[];
  readonly canonical_state_modified: false;
};

type LevelEntry = {
  readonly class_id: string;
  readonly source_ref: string;
  readonly class_level: number;
  readonly bab: number;
  readonly saves: Saves;
  readonly caster_advancement: number;
  readonly manifester_advancement: number;
  readonly prerequisites_met_before_first_level?: boolean;
};

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseSaves(value: unknown): Saves | undefined {
  if (!plainObject(value)
    || !nonNegativeInteger(value['fortitude'])
    || !nonNegativeInteger(value['reflex'])
    || !nonNegativeInteger(value['will'])) return undefined;
  return { fortitude: value['fortitude'], reflex: value['reflex'], will: value['will'] };
}

function parseLevelEntry(value: unknown): LevelEntry | undefined {
  if (!plainObject(value)
    || Object.hasOwn(value, 'level')
    || typeof value['class_id'] !== 'string'
    || value['class_id'].length === 0
    || typeof value['source_ref'] !== 'string'
    || value['source_ref'].length === 0
    || !nonNegativeInteger(value['class_level'])
    || !nonNegativeInteger(value['bab'])
    || !nonNegativeInteger(value['caster_advancement'])
    || !nonNegativeInteger(value['manifester_advancement'])) return undefined;
  const saves = parseSaves(value['saves']);
  if (saves === undefined) return undefined;
  if (value['prerequisites_met_before_first_level'] !== undefined
    && typeof value['prerequisites_met_before_first_level'] !== 'boolean') return undefined;
  return {
    class_id: value['class_id'],
    source_ref: value['source_ref'],
    class_level: value['class_level'],
    bab: value['bab'],
    saves,
    caster_advancement: value['caster_advancement'],
    manifester_advancement: value['manifester_advancement'],
    ...(typeof value['prerequisites_met_before_first_level'] === 'boolean'
      ? { prerequisites_met_before_first_level: value['prerequisites_met_before_first_level'] }
      : {})
  };
}

function safeSum(values: readonly number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

function validQualifiedItems(value: unknown, allowedSources: ReadonlySet<string>): boolean {
  return Array.isArray(value) && value.every(item => plainObject(item)
    && typeof item['source_ref'] === 'string'
    && item['source_ref'].length > 0
    && allowedSources.has(item['source_ref']));
}

function progressionTotal(value: unknown, key: 'caster_level' | 'manifester_level'): number | undefined {
  if (!Array.isArray(value) || value.some(item => !plainObject(item)
    || typeof item['source_id'] !== 'string'
    || item['source_id'].length === 0
    || !nonNegativeInteger(item[key]))) return undefined;
  return safeSum(value.map(item => (item as Record<typeof key, number>)[key]));
}

export function validateCharacterExtension(
  value: unknown,
  context: {
    readonly racial_bab: number;
    readonly racial_saves: Saves;
    readonly registered_source_refs: readonly string[];
  }
): CharacterValidationReport {
  const discrepancies = new Set<string>();
  const corrections: Correction[] = [];
  const schema = validateRuntimeContract('Dnd35CharacterExtension', value);
  if (!schema.ok || !plainObject(value)) {
    return {
      status: 'fail',
      discrepancies: ['schema'],
      corrective_proposals: [],
      canonical_state_modified: false
    };
  }
  const extension = value as unknown as CharacterExtension;
  const racialSaves = parseSaves(context.racial_saves);
  const registeredSources = Array.isArray(context.registered_source_refs)
    ? new Set(context.registered_source_refs.filter(ref => typeof ref === 'string' && ref.length > 0))
    : new Set<string>();
  if (!nonNegativeInteger(context.racial_bab) || racialSaves === undefined) discrepancies.add('racial_progression');

  const baseEntries = extension.class_levels.map(parseLevelEntry);
  const prestigeEntries = extension.prestige_levels.map(parseLevelEntry);
  if (baseEntries.some(entry => entry === undefined)) discrepancies.add('class_levels');
  if (new Set(baseEntries.filter((entry): entry is LevelEntry => entry !== undefined)
    .map(entry => entry.class_id)).size !== baseEntries.length) discrepancies.add('class_levels');
  if (prestigeEntries.some(entry => entry === undefined
    || (entry.class_level > 0 && entry.prerequisites_met_before_first_level === false))) {
    discrepancies.add('prestige_levels');
  }
  if (new Set(prestigeEntries.filter((entry): entry is LevelEntry => entry !== undefined)
    .map(entry => entry.class_id)).size !== prestigeEntries.length) discrepancies.add('prestige_levels');
  const entries = [...baseEntries, ...prestigeEntries].filter((entry): entry is LevelEntry => entry !== undefined);

  const classLevelTotal = safeSum(entries.map(entry => entry.class_level));
  const totalHd = classLevelTotal === undefined ? undefined : safeSum([extension.racial_hit_dice, classLevelTotal]);
  const ecl = totalHd === undefined ? undefined : safeSum([totalHd, extension.level_adjustment]);
  const bab = safeSum([context.racial_bab, ...entries.map(entry => entry.bab)]);
  const fortitude = racialSaves === undefined ? undefined : safeSum([racialSaves.fortitude, ...entries.map(entry => entry.saves.fortitude)]);
  const reflex = racialSaves === undefined ? undefined : safeSum([racialSaves.reflex, ...entries.map(entry => entry.saves.reflex)]);
  const will = racialSaves === undefined ? undefined : safeSum([racialSaves.will, ...entries.map(entry => entry.saves.will)]);
  const casterAdvancement = safeSum(entries.map(entry => entry.caster_advancement));
  const manifesterAdvancement = safeSum(entries.map(entry => entry.manifester_advancement));

  const compare = (field: string, actual: unknown, expected: unknown): void => {
    if (expected === undefined || actual !== expected) {
      discrepancies.add(field);
      if (expected !== undefined) corrections.push({ field, expected });
    }
  };
  compare('class_level_total', extension.class_level_total, classLevelTotal);
  compare('total_hd', extension.total_hd, totalHd);
  compare('ecl', extension.ecl, ecl);
  compare('bab', extension.bab, bab);
  if (fortitude === undefined || reflex === undefined || will === undefined
    || !plainObject(extension.saves)
    || extension.saves['fortitude'] !== fortitude
    || extension.saves['reflex'] !== reflex
    || extension.saves['will'] !== will) {
    discrepancies.add('saves');
    if (fortitude !== undefined && reflex !== undefined && will !== undefined) {
      corrections.push({ field: 'saves', expected: { fortitude, reflex, will } });
    }
  }

  if (entries.some(entry => entry.caster_advancement > entry.class_level)
    || progressionTotal(extension.spellcasting, 'caster_level') !== casterAdvancement) {
    discrepancies.add('spellcasting');
  }
  if (entries.some(entry => entry.manifester_advancement > entry.class_level)
    || progressionTotal(extension.manifesting, 'manifester_level') !== manifesterAdvancement) {
    discrepancies.add('manifesting');
  }
  const declaredSources = new Set(extension.source_refs);
  if (!validQualifiedItems(extension.feats, declaredSources)) discrepancies.add('feats');
  if (!validQualifiedItems(extension.skills, declaredSources)) discrepancies.add('skills');
  if (!Array.isArray(extension.conditions)
    || extension.conditions.some(condition => !plainObject(condition)
      || typeof condition['condition_id'] !== 'string'
      || !Object.hasOwn(DND35_CONDITIONS, condition['condition_id'])
      || typeof condition['source_ref'] !== 'string'
      || condition['source_ref'].length === 0
      || !declaredSources.has(condition['source_ref']))) discrepancies.add('conditions');
  if (!Array.isArray(extension.source_refs)
    || extension.source_refs.length === 0
    || extension.source_refs.some(ref => typeof ref !== 'string' || ref.length === 0)
    || new Set(extension.source_refs).size !== extension.source_refs.length
    || extension.source_refs.some(ref => !registeredSources.has(ref))
    || entries.some(entry => !declaredSources.has(entry.source_ref))) discrepancies.add('source_refs');
  if (extension.race_option_id.length === 0
    || extension.race_tags.some(tag => tag.length === 0)
    || new Set(extension.race_tags).size !== extension.race_tags.length) discrepancies.add('race');
  if (!plainObject(extension.armor_class)
    || !['normal', 'touch', 'flat_footed'].every(key => typeof extension.armor_class[key] === 'number'
      && Number.isSafeInteger(extension.armor_class[key]))) discrepancies.add('armor_class');
  if (!plainObject(extension.speed)
    || !nonNegativeInteger(extension.speed['land_feet'])) discrepancies.add('speed');
  if (!Number.isSafeInteger(extension.grapple)) discrepancies.add('grapple');
  if (!Number.isSafeInteger(extension.initiative)) discrepancies.add('initiative');

  const computed = classLevelTotal !== undefined && totalHd !== undefined && ecl !== undefined && bab !== undefined
    && fortitude !== undefined && reflex !== undefined && will !== undefined
    && casterAdvancement !== undefined && manifesterAdvancement !== undefined
    ? {
        class_level_total: classLevelTotal,
        racial_hit_dice: extension.racial_hit_dice,
        total_hd: totalHd,
        level_adjustment: extension.level_adjustment,
        ecl,
        bab,
        saves: { fortitude, reflex, will },
        caster_advancement: casterAdvancement,
        manifester_advancement: manifesterAdvancement
      }
    : undefined;
  return {
    status: discrepancies.size === 0 ? 'pass' : 'fail',
    ...(computed === undefined ? {} : { computed }),
    discrepancies: [...discrepancies].sort(),
    corrective_proposals: corrections,
    canonical_state_modified: false
  };
}
