import { err, ok, type Result } from '@nyx/domain';
import type { Dnd35PrestigeClass } from '../catalogs/protected-catalog.js';
import { validateDnd35AdapterEvent, type Dnd35AdapterEvent } from '../events/adapter-events.js';
import {
  evaluatePrestigeEligibility,
  type PrestigeEligibilityEvidence,
  type PrestigeEligibilityFailure
} from './eligibility.js';

export type PrestigeAdvancementSelection = {
  readonly arcaneClassId?: string;
  readonly divineClassId?: string;
  readonly spellcastingClassId?: string;
  readonly manifestingClassId?: string;
};

export type PrestigeLevelEventContext = {
  readonly eventId: string;
  readonly recordId: string;
  readonly campaignId: string;
  readonly branchId: string;
  readonly baseAdapterVersion: number;
  readonly actorId: string;
  readonly occurredAt: string;
};

export type PrestigeProgressionError = {
  readonly code:
    | 'ADVANCEMENT_SELECTION_NOT_ALLOWED'
    | 'ADVANCEMENT_SELECTION_REQUIRED'
    | 'INVALID_EVENT'
    | 'NOT_ELIGIBLE';
  readonly message: string;
  readonly field?: keyof PrestigeAdvancementSelection;
  readonly failures?: readonly PrestigeEligibilityFailure[];
};

type SelectionField = keyof PrestigeAdvancementSelection;

function failure(
  code: PrestigeProgressionError['code'],
  message: string,
  details: Pick<PrestigeProgressionError, 'field' | 'failures'> = {}
): Result<never, PrestigeProgressionError> {
  return err({ code, message, ...details });
}

function selected(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 0;
}

function requiredSelections(prestige: Dnd35PrestigeClass, level: number): ReadonlySet<SelectionField> {
  const progression = prestige.progression;
  const fields = new Set<SelectionField>();
  if (progression.arcane_spellcasting_levels?.includes(level)
    || Number(progression.bonus_spells_by_level?.[String(level)] ?? 0) > 0) fields.add('arcaneClassId');
  if (progression.divine_spellcasting_levels?.includes(level)
    || progression.caster_level !== undefined) fields.add('divineClassId');
  if (progression.spellcasting_levels?.includes(level)) fields.add('spellcastingClassId');
  if (progression.manifesting_levels?.includes(level)) fields.add('manifestingClassId');
  return fields;
}

export function buildPrestigeLevelGainedEvent(input: {
  readonly prestige: Dnd35PrestigeClass;
  readonly character: PrestigeEligibilityEvidence;
  readonly nextLevel: number;
  readonly selection: PrestigeAdvancementSelection;
  readonly event: PrestigeLevelEventContext;
}): Result<Dnd35AdapterEvent, PrestigeProgressionError> {
  const eligibility = evaluatePrestigeEligibility(input.prestige, input.character, input.nextLevel);
  if (!eligibility.eligible) {
    return failure('NOT_ELIGIBLE', 'No se puede ganar el nivel de prestigio sin cumplir todos los requisitos.', {
      failures: eligibility.failures
    });
  }

  const required = requiredSelections(input.prestige, input.nextLevel);
  const fields = ['arcaneClassId', 'divineClassId', 'spellcastingClassId', 'manifestingClassId'] as const;
  for (const field of fields) {
    if (required.has(field) && !selected(input.selection[field])) {
      return failure('ADVANCEMENT_SELECTION_REQUIRED', `Debe elegirse ${field} para este nivel.`, { field });
    }
    if (!required.has(field) && input.selection[field] !== undefined) {
      return failure('ADVANCEMENT_SELECTION_NOT_ALLOWED', `${field} no avanza en este nivel.`, { field });
    }
  }

  const progression = input.prestige.progression;
  const ownSpellcasting = progression.own_spellcasting !== undefined;
  const ownManifesting = progression.own_manifesting !== undefined;
  const bonusSpellSlots = Number(progression.bonus_spells_by_level?.[String(input.nextLevel)] ?? 0);
  const advances = {
    spellcasting: required.has('arcaneClassId')
      || required.has('divineClassId')
      || required.has('spellcastingClassId')
      || ownSpellcasting,
    manifesting: required.has('manifestingClassId') || ownManifesting,
    ...(input.selection.arcaneClassId === undefined ? {} : { arcane_class_id: input.selection.arcaneClassId }),
    ...(input.selection.divineClassId === undefined ? {} : { divine_class_id: input.selection.divineClassId }),
    ...(input.selection.spellcastingClassId === undefined ? {} : { spellcasting_class_id: input.selection.spellcastingClassId }),
    ...(input.selection.manifestingClassId === undefined ? {} : { manifesting_class_id: input.selection.manifestingClassId }),
    ...(ownSpellcasting ? { own_spellcasting: true } : {}),
    ...(ownManifesting ? { own_manifesting: true } : {}),
    ...(bonusSpellSlots > 0 ? { bonus_spell_slots: bonusSpellSlots } : {}),
    ...(progression.caster_level === undefined ? {} : { caster_level_only: true })
  };
  const specialSourceRefs = input.character.specialEvidence
    .filter(item => eligibility.evidenceIds.includes(item.evidenceId))
    .flatMap(item => item.sourceRefs);
  const sourceRefs: [string, ...string[]] = [
    input.prestige.source_url,
    ...new Set(specialSourceRefs.filter(ref => ref !== input.prestige.source_url))
  ];
  const event: Dnd35AdapterEvent = {
    schema_version: '1.0',
    event_id: input.event.eventId,
    event_type: 'PRESTIGE_LEVEL_GAINED',
    campaign_id: input.event.campaignId,
    branch_id: input.event.branchId,
    base_adapter_version: input.event.baseAdapterVersion,
    committed_adapter_version: input.event.baseAdapterVersion + 1,
    actor_id: input.event.actorId,
    occurred_at: input.event.occurredAt,
    payload: {
      record_id: input.event.recordId,
      prestige_id: input.prestige.id,
      prestige_level: input.nextLevel,
      eligibility_evidence_ids: eligibility.evidenceIds,
      advances
    },
    source_refs: sourceRefs
  };
  const validated = validateDnd35AdapterEvent(event);
  if (!validated.ok) return failure('INVALID_EVENT', validated.error.message);
  return ok(validated.value);
}
