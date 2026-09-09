import { validateRuntimeContract } from '@nyx/contracts';
import { err, ok, type Result } from '@nyx/domain';
import type { Dnd35ExoticRace } from '../catalogs/protected-catalog.js';
import {
  validateDnd35AdapterEvent,
  type Dnd35AdapterEvent,
  type ReplayedRaceApplication
} from '../events/adapter-events.js';
import {
  deriveLevelIdentities,
  type LevelIdentities,
  type QualifiedCasterLevel,
  type QualifiedClassLevel,
  type QualifiedManifesterLevel
} from '../math/level-identities.js';

const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;

export type AbilityScores = Readonly<Record<(typeof ABILITY_KEYS)[number], number>>;

export type RaceApplicationSelections = {
  readonly variantId?: string;
  readonly traitChoices?: Readonly<Record<string, string>>;
};

export type RaceCharacterSnapshot = {
  readonly recordId: string;
  readonly abilityScores: AbilityScores;
  readonly classLevels: readonly QualifiedClassLevel[];
  readonly casterLevels: readonly QualifiedCasterLevel[];
  readonly manifesterLevels: readonly QualifiedManifesterLevel[];
  readonly raceApplications: Readonly<Record<string, ReplayedRaceApplication>>;
};

export type RaceApplication = {
  readonly record_id: string;
  readonly race_id: string;
  readonly ability_scores_before: AbilityScores;
  readonly ability_modifiers: Dnd35ExoticRace['ability_mods'];
  readonly ability_scores_after: AbilityScores;
  readonly racial_hit_dice: number;
  readonly racial_hd_package: Dnd35ExoticRace['racial_hd_package'] | null;
  readonly level_adjustment: number;
  readonly minimum_starting_ecl: number;
  readonly identities: LevelIdentities;
  readonly size: Dnd35ExoticRace['size'];
  readonly speed_ft: number;
  readonly traits: readonly string[];
  readonly favored_class: string;
  readonly languages: Dnd35ExoticRace['languages'];
  readonly variant_id: string | null;
  readonly selections: Readonly<Record<string, string>>;
  readonly source_refs: readonly [string, ...string[]];
};

export type RaceApplicationEventContext = {
  readonly eventIdPrefix: string;
  readonly campaignId: string;
  readonly branchId: string;
  readonly baseAdapterVersion: number;
  readonly actorId: string;
  readonly occurredAt: string;
};

export type RaceApplicationError = {
  readonly code:
    | 'UNREGISTERED_RACE_OPTION'
    | 'RACE_ALREADY_APPLIED'
    | 'RACE_OPTION_REQUIRED'
    | 'RACE_OPTION_NOT_ALLOWED'
    | 'RACE_VARIANT_NOT_ALLOWED'
    | 'INVALID_RACIAL_PACKAGE'
    | 'INVALID_LEVEL_IDENTITY'
    | 'INVALID_EVENT'
    | 'INCOMPLETE_RACE_APPLICATION';
  readonly message: string;
  readonly field?: string;
};

function failure(
  code: RaceApplicationError['code'],
  message: string,
  field?: string
): Result<never, RaceApplicationError> {
  return err({ code, message, ...(field === undefined ? {} : { field }) });
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validAbilityScores(value: unknown): value is AbilityScores {
  return plainObject(value)
    && Object.keys(value).length === ABILITY_KEYS.length
    && ABILITY_KEYS.every(key => safeNonNegativeInteger(value[key]));
}

function validateRacialPackage(race: Dnd35ExoticRace): boolean {
  if (race.racial_hd > 0 && race.racial_hd_package === undefined) return false;
  if (race.racial_hd === 0 && race.racial_hd_package !== undefined) return false;
  if (race.minimum_starting_ecl !== Math.max(1, race.racial_hd) + race.level_adjustment) return false;
  return (race.variants ?? []).every(variant =>
    variant.minimum_starting_ecl === Math.max(1, race.racial_hd) + variant.level_adjustment);
}

function applyAbilityModifiers(
  scores: AbilityScores,
  modifiers: Dnd35ExoticRace['ability_mods']
): AbilityScores | undefined {
  const entries = ABILITY_KEYS.map(key => {
    const result = scores[key] + (modifiers[key] ?? 0);
    return [key, result] as const;
  });
  if (entries.some(([, value]) => !safeNonNegativeInteger(value))) return undefined;
  return Object.fromEntries(entries) as AbilityScores;
}

export function evaluateRaceApplication(
  race: Dnd35ExoticRace | string,
  characterSnapshot: RaceCharacterSnapshot,
  selections: RaceApplicationSelections
): Result<RaceApplication, RaceApplicationError> {
  if (typeof race === 'string') {
    return failure('UNREGISTERED_RACE_OPTION', `La raza ${race} no está mecanizada en el catálogo v1.`);
  }
  const schema = validateRuntimeContract('Dnd35ExoticRace', race);
  if (!schema.ok || !validateRacialPackage(race)) {
    return failure('INVALID_RACIAL_PACKAGE', 'La ficha racial no cumple el schema o las invariantes RHD/LA/ECL.');
  }
  if (characterSnapshot.recordId.length === 0 || !validAbilityScores(characterSnapshot.abilityScores)) {
    return failure('INVALID_LEVEL_IDENTITY', 'El snapshot del personaje no contiene identidad y ability scores válidos.');
  }
  const existing = characterSnapshot.raceApplications[characterSnapshot.recordId];
  if (existing !== undefined) {
    return existing.status === 'COMPLETE'
      ? failure('RACE_ALREADY_APPLIED', `El registro ${characterSnapshot.recordId} ya tiene una raza aplicada.`)
      : failure('INCOMPLETE_RACE_APPLICATION', `El registro ${characterSnapshot.recordId} contiene una aplicación racial parcial.`);
  }

  const requiredChoices = race.traits.filter(trait => trait.startsWith('choose_'));
  const choices = selections.traitChoices ?? {};
  if (!plainObject(choices) || Object.values(choices).some(choice => typeof choice !== 'string' || choice.length === 0)) {
    return failure('RACE_OPTION_REQUIRED', 'Las selecciones raciales deben ser strings no vacíos.');
  }
  for (const required of requiredChoices) {
    if (choices[required] === undefined) {
      return failure('RACE_OPTION_REQUIRED', `Debe resolverse la opción racial ${required}.`, required);
    }
  }
  const unexpectedChoice = Object.keys(choices).find(key => !requiredChoices.includes(key));
  if (unexpectedChoice !== undefined) {
    return failure('RACE_OPTION_NOT_ALLOWED', `La opción ${unexpectedChoice} no está declarada por la raza.`, unexpectedChoice);
  }

  const variant = selections.variantId === undefined
    ? undefined
    : race.variants?.find(candidate => candidate.id === selections.variantId);
  if (selections.variantId !== undefined && variant === undefined) {
    return failure('RACE_VARIANT_NOT_ALLOWED', `La variante ${selections.variantId} no pertenece a ${race.id}.`, 'variantId');
  }
  const levelAdjustment = variant?.level_adjustment ?? race.level_adjustment;
  const minimumStartingEcl = variant?.minimum_starting_ecl ?? race.minimum_starting_ecl;
  const identities = deriveLevelIdentities({
    class_levels: characterSnapshot.classLevels,
    racial_hit_dice: race.racial_hd,
    level_adjustment: levelAdjustment,
    caster_levels: characterSnapshot.casterLevels,
    manifester_levels: characterSnapshot.manifesterLevels
  });
  if (!identities.ok) return failure('INVALID_LEVEL_IDENTITY', identities.error.message);
  const abilityScoresAfter = applyAbilityModifiers(characterSnapshot.abilityScores, race.ability_mods);
  if (abilityScoresAfter === undefined) {
    return failure('INVALID_RACIAL_PACKAGE', 'Los modificadores raciales producen ability scores inválidos.');
  }

  return ok({
    record_id: characterSnapshot.recordId,
    race_id: race.id,
    ability_scores_before: structuredClone(characterSnapshot.abilityScores),
    ability_modifiers: structuredClone(race.ability_mods),
    ability_scores_after: abilityScoresAfter,
    racial_hit_dice: race.racial_hd,
    racial_hd_package: race.racial_hd_package === undefined ? null : structuredClone(race.racial_hd_package),
    level_adjustment: levelAdjustment,
    minimum_starting_ecl: minimumStartingEcl,
    identities: identities.value,
    size: race.size,
    speed_ft: race.speed_ft,
    traits: [...race.traits],
    favored_class: race.favored_class,
    languages: structuredClone(race.languages),
    variant_id: variant?.id ?? null,
    selections: structuredClone(choices),
    source_refs: [race.source_url]
  });
}

function completeApplication(application: RaceApplication): boolean {
  return application.record_id.length > 0
    && /^dnd35\.race\.[a-z0-9_]+$/u.test(application.race_id)
    && application.source_refs.length > 0
    && application.source_refs.every(ref => ref.length > 0)
    && validAbilityScores(application.ability_scores_before)
    && validAbilityScores(application.ability_scores_after)
    && application.identities.racial_hit_dice === application.racial_hit_dice
    && application.identities.level_adjustment === application.level_adjustment
    && application.identities.total_hd === application.identities.class_level_total + application.racial_hit_dice
    && application.identities.ecl === application.identities.total_hd + application.level_adjustment
    && application.minimum_starting_ecl === Math.max(1, application.racial_hit_dice) + application.level_adjustment
    && (application.racial_hit_dice === 0
      ? application.racial_hd_package === null
      : application.racial_hd_package !== null);
}

export function buildRaceApplicationEvents(
  application: RaceApplication,
  eventContext: RaceApplicationEventContext
): Result<readonly Dnd35AdapterEvent[], RaceApplicationError> {
  if (!completeApplication(application)) {
    return failure('INCOMPLETE_RACE_APPLICATION', 'La aplicación racial no contiene un resultado autoconsistente.');
  }
  const payloads: readonly {
    readonly suffix: string;
    readonly eventType: Dnd35AdapterEvent['event_type'];
    readonly payload: Record<string, unknown>;
  }[] = [
    {
      suffix: 'OPTION',
      eventType: 'RACE_OPTION_SELECTED',
      payload: {
        record_id: application.record_id,
        race_id: application.race_id,
        ability_scores_before: application.ability_scores_before,
        ability_modifiers: application.ability_modifiers,
        ability_scores_after: application.ability_scores_after,
        size: application.size,
        speed_ft: application.speed_ft,
        traits: application.traits,
        favored_class: application.favored_class,
        languages: application.languages,
        variant_id: application.variant_id,
        selections: application.selections
      }
    },
    {
      suffix: 'RHD',
      eventType: 'RACIAL_HD_APPLIED',
      payload: {
        record_id: application.record_id,
        race_id: application.race_id,
        racial_hit_dice: application.racial_hit_dice,
        racial_hd_package: application.racial_hd_package,
        total_hd: application.identities.total_hd
      }
    },
    {
      suffix: 'LA',
      eventType: 'LEVEL_ADJUSTMENT_APPLIED',
      payload: {
        record_id: application.record_id,
        race_id: application.race_id,
        level_adjustment: application.level_adjustment,
        ecl: application.identities.ecl,
        minimum_starting_ecl: application.minimum_starting_ecl
      }
    },
    ...(application.variant_id === null ? [] : [{
      suffix: 'VARIANT',
      eventType: 'RACE_VARIANT_CHOSEN' as const,
      payload: {
        record_id: application.record_id,
        race_id: application.race_id,
        variant_id: application.variant_id,
        level_adjustment: application.level_adjustment,
        minimum_starting_ecl: application.minimum_starting_ecl
      }
    }])
  ];

  const events: Dnd35AdapterEvent[] = [];
  for (const [index, item] of payloads.entries()) {
    const event: Dnd35AdapterEvent = {
      schema_version: '1.0',
      event_id: `${eventContext.eventIdPrefix}-${item.suffix}`,
      event_type: item.eventType,
      campaign_id: eventContext.campaignId,
      branch_id: eventContext.branchId,
      base_adapter_version: eventContext.baseAdapterVersion + index,
      committed_adapter_version: eventContext.baseAdapterVersion + index + 1,
      actor_id: eventContext.actorId,
      occurred_at: eventContext.occurredAt,
      payload: structuredClone(item.payload),
      source_refs: [...application.source_refs]
    };
    const checked = validateDnd35AdapterEvent(event);
    if (!checked.ok) return failure('INVALID_EVENT', checked.error.message);
    events.push(checked.value);
  }
  return ok(events);
}
