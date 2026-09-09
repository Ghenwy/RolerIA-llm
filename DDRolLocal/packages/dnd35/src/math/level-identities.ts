import { err, ok, type Result } from '@nyx/domain';

export type QualifiedClassLevel = {
  readonly class_id: string;
  readonly class_kind: 'BASE' | 'PRESTIGE';
  readonly class_level: number;
};

export type QualifiedCasterLevel = {
  readonly source_id: string;
  readonly caster_level: number;
};

export type QualifiedManifesterLevel = {
  readonly source_id: string;
  readonly manifester_level: number;
};

export type LevelIdentityInput = {
  readonly class_levels: readonly QualifiedClassLevel[];
  readonly racial_hit_dice: number;
  readonly level_adjustment: number;
  readonly caster_levels: readonly QualifiedCasterLevel[];
  readonly manifester_levels: readonly QualifiedManifesterLevel[];
};

export type LevelIdentities = LevelIdentityInput & {
  readonly class_level_total: number;
  readonly total_hd: number;
  readonly ecl: number;
};

export type LevelIdentityError = {
  readonly code: 'AMBIGUOUS_LEVEL' | 'DUPLICATE_LEVEL_SOURCE' | 'INVALID_LEVEL_IDENTITY';
  readonly message: string;
};

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function uniqueNonEmptyIds(entries: readonly { readonly source_id: string }[]): boolean {
  return entries.every(entry => entry.source_id.length > 0)
    && new Set(entries.map(entry => entry.source_id)).size === entries.length;
}

function safeSum(values: readonly number[]): number | undefined {
  const sum = values.reduce((total, value) => total + value, 0);
  return Number.isSafeInteger(sum) ? sum : undefined;
}

export function deriveLevelIdentities(
  input: LevelIdentityInput
): Result<LevelIdentities, LevelIdentityError> {
  if (Object.hasOwn(input, 'level')) {
    return err({ code: 'AMBIGUOUS_LEVEL', message: 'Nunca se admite level sin calificar.' });
  }
  if (!Array.isArray(input.class_levels)
    || !Array.isArray(input.caster_levels)
    || !Array.isArray(input.manifester_levels)
    || !nonNegativeSafeInteger(input.racial_hit_dice)
    || !nonNegativeSafeInteger(input.level_adjustment)) {
    return err({ code: 'INVALID_LEVEL_IDENTITY', message: 'RHD, LA y colecciones de niveles deben ser válidos.' });
  }

  const classIds = input.class_levels.map(entry => entry.class_id);
  if (classIds.some(id => id.length === 0)
    || new Set(classIds).size !== classIds.length
    || !uniqueNonEmptyIds(input.caster_levels)
    || !uniqueNonEmptyIds(input.manifester_levels)) {
    return err({ code: 'DUPLICATE_LEVEL_SOURCE', message: 'Cada fuente de nivel debe tener un ID único no vacío.' });
  }
  if (input.class_levels.some(entry => !nonNegativeSafeInteger(entry.class_level)
      || (entry.class_kind !== 'BASE' && entry.class_kind !== 'PRESTIGE'))
    || input.caster_levels.some(entry => !nonNegativeSafeInteger(entry.caster_level))
    || input.manifester_levels.some(entry => !nonNegativeSafeInteger(entry.manifester_level))) {
    return err({ code: 'INVALID_LEVEL_IDENTITY', message: 'Todos los niveles deben ser enteros seguros no negativos.' });
  }

  const classLevelTotal = safeSum(input.class_levels.map(entry => entry.class_level));
  if (classLevelTotal === undefined) {
    return err({ code: 'INVALID_LEVEL_IDENTITY', message: 'La suma de niveles de clase excede el rango seguro.' });
  }
  const totalHd = safeSum([classLevelTotal, input.racial_hit_dice]);
  const ecl = totalHd === undefined ? undefined : safeSum([totalHd, input.level_adjustment]);
  if (totalHd === undefined || ecl === undefined) {
    return err({ code: 'INVALID_LEVEL_IDENTITY', message: 'Total HD o ECL exceden el rango seguro.' });
  }

  return ok({
    class_levels: structuredClone(input.class_levels),
    class_level_total: classLevelTotal,
    racial_hit_dice: input.racial_hit_dice,
    total_hd: totalHd,
    level_adjustment: input.level_adjustment,
    ecl,
    caster_levels: structuredClone(input.caster_levels),
    manifester_levels: structuredClone(input.manifester_levels)
  });
}
