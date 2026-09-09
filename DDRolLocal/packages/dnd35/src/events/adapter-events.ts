import fs from 'node:fs/promises';
import path from 'node:path';
import { validateRuntimeContract, type InternalDnd35AdapterEvent, type InternalRuleSourceRecord } from '@nyx/contracts';
import { canonicalJson, err, ok, type Result } from '@nyx/domain';
import { captureDnd35Boundary, readBoundFile, sha256 } from '@nyx/persistence-json';


export type Dnd35AdapterEvent = InternalDnd35AdapterEvent.Dnd35AdapterEventV1;
export const DND35_ADAPTER_EVENT_TYPES = [
  'RACE_OPTION_SELECTED',
  'RACIAL_HD_APPLIED',
  'LEVEL_ADJUSTMENT_APPLIED',
  'PRESTIGE_ELIGIBILITY_CHECKED',
  'PRESTIGE_LEVEL_GAINED',
  'SPELLCASTING_PROGRESSION_CHOSEN',
  'MANIFESTING_PROGRESSION_CHOSEN',
  'RACE_VARIANT_CHOSEN',
  'RULE_SOURCE_REGISTERED',
  'RULE_RULING_RECORDED',
  'HOUSE_RULE_ENABLED',
  'HOUSE_RULE_DISABLED'
] as const satisfies readonly Dnd35AdapterEvent['event_type'][];

export type Dnd35AdapterEventError = {
  readonly code:
    | 'BRANCH_MISMATCH'
    | 'CAMPAIGN_MISMATCH'
    | 'CORRUPT_DATA'
    | 'EVENT_ID_CONFLICT'
    | 'INVALID_ADAPTER_EVENT'
    | 'IO_ERROR'
    | 'STALE_ADAPTER_VERSION';
  readonly message: string;
};

export type PersistedRuling = {
  readonly ruling_id: string;
  readonly question: string;
  readonly answer: string;
  readonly source_refs: readonly string[];
  readonly errata_status: string;
  readonly scope: string;
  readonly campaign_id: string;
  readonly created_at: string;
  readonly supersedes: string | null;
};

export type CampaignHouseRule = {
  readonly house_rule_id: string;
  readonly rule: string;
  readonly scope: string;
  readonly enabled: boolean;
  readonly source_refs: readonly string[];
};

export type RaceAdapterEventType = Extract<Dnd35AdapterEvent['event_type'],
  'RACE_OPTION_SELECTED' | 'RACIAL_HD_APPLIED' | 'LEVEL_ADJUSTMENT_APPLIED' | 'RACE_VARIANT_CHOSEN'>;

export type ReplayedRaceApplication = {
  readonly record_id: string;
  readonly race_id: string;
  readonly status: 'PARTIAL' | 'COMPLETE';
  readonly event_types: readonly RaceAdapterEventType[];
  readonly source_refs: readonly string[];
  readonly variant_id?: string | null;
};

export type Dnd35AdapterState = {
  readonly adapter_version: number;
  readonly campaign_id?: string;
  readonly branch_id?: string;
  readonly applied_event_ids: readonly string[];
  readonly rulings: Readonly<Record<string, PersistedRuling>>;
  readonly house_rules: Readonly<Record<string, CampaignHouseRule>>;
  readonly race_applications: Readonly<Record<string, ReplayedRaceApplication>>;
};

function failure(code: Dnd35AdapterEventError['code'], message: string): Result<never, Dnd35AdapterEventError> {
  return err({ code, message });
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function stringField(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string' && value[key].length > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(item => typeof item === 'string' && item.length > 0)
    && new Set(value).size === value.length;
}

const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;

function abilityScores(value: unknown): value is Record<(typeof ABILITY_KEYS)[number], number> {
  return plainObject(value)
    && exactKeys(value, ABILITY_KEYS)
    && ABILITY_KEYS.every(key => nonNegativeSafeInteger(value[key]));
}

function abilityModifiers(value: unknown): value is Partial<Record<(typeof ABILITY_KEYS)[number], number>> {
  return plainObject(value)
    && Object.keys(value).every(key => (ABILITY_KEYS as readonly string[]).includes(key))
    && Object.values(value).every(modifier => typeof modifier === 'number' && Number.isSafeInteger(modifier));
}

function validRaceId(value: unknown): value is string {
  return typeof value === 'string' && /^dnd35\.race\.[a-z0-9_]+$/u.test(value);
}

function validLanguages(value: unknown): boolean {
  return plainObject(value)
    && exactKeys(value, ['automatic', 'bonus'])
    && stringArray(value['automatic'])
    && stringArray(value['bonus']);
}

function validRacialHdPackage(value: unknown, racialHitDice: number): boolean {
  if (racialHitDice === 0) return value === null;
  if (!plainObject(value)
    || !exactKeys(value, ['die', 'bab', 'saves', 'feats'])
    || !['d4', 'd6', 'd8', 'd10', 'd12'].includes(String(value['die']))
    || typeof value['bab'] !== 'number'
    || !Number.isSafeInteger(value['bab'])
    || !nonNegativeSafeInteger(value['feats'])
    || !plainObject(value['saves'])
    || !exactKeys(value['saves'], ['fort', 'ref', 'will'])) return false;
  return ['fort', 'ref', 'will'].every(key =>
    typeof (value['saves'] as Record<string, unknown>)[key] === 'number'
    && Number.isSafeInteger((value['saves'] as Record<string, unknown>)[key]));
}

function validRaceOptionSelectedPayload(payload: Record<string, unknown>): boolean {
  const keys = [
    'record_id', 'race_id', 'ability_scores_before', 'ability_modifiers', 'ability_scores_after',
    'size', 'speed_ft', 'traits', 'favored_class', 'languages', 'variant_id', 'selections'
  ];
  if (!exactKeys(payload, keys)
    || !stringField(payload, 'record_id')
    || !validRaceId(payload['race_id'])
    || !abilityScores(payload['ability_scores_before'])
    || !abilityModifiers(payload['ability_modifiers'])
    || !abilityScores(payload['ability_scores_after'])
    || !['small', 'medium', 'large'].includes(String(payload['size']))
    || !nonNegativeSafeInteger(payload['speed_ft'])
    || !stringArray(payload['traits'])
    || !stringField(payload, 'favored_class')
    || !validLanguages(payload['languages'])
    || (payload['variant_id'] !== null && (typeof payload['variant_id'] !== 'string' || payload['variant_id'].length === 0))
    || !plainObject(payload['selections'])
    || Object.entries(payload['selections']).some(([key, value]) =>
      !key.startsWith('choose_') || typeof value !== 'string' || value.length === 0)) return false;

  const before = payload['ability_scores_before'];
  const modifiers = payload['ability_modifiers'];
  const after = payload['ability_scores_after'];
  if (!abilityScores(before) || !abilityModifiers(modifiers) || !abilityScores(after)) return false;
  if (ABILITY_KEYS.some(key => after[key] !== before[key] + (modifiers[key] ?? 0))) return false;
  const requiredChoices = (payload['traits'] as string[]).filter(trait => trait.startsWith('choose_'));
  return sameStringSet(requiredChoices, Object.keys(payload['selections']));
}

function validRacialHdAppliedPayload(payload: Record<string, unknown>): boolean {
  if (!exactKeys(payload, ['record_id', 'race_id', 'racial_hit_dice', 'racial_hd_package', 'total_hd'])
    || !stringField(payload, 'record_id')
    || !validRaceId(payload['race_id'])
    || !nonNegativeSafeInteger(payload['racial_hit_dice'])
    || !nonNegativeSafeInteger(payload['total_hd'])) return false;
  return payload['total_hd'] >= payload['racial_hit_dice']
    && validRacialHdPackage(payload['racial_hd_package'], payload['racial_hit_dice']);
}

function validLevelAdjustmentAppliedPayload(payload: Record<string, unknown>): boolean {
  return exactKeys(payload, ['record_id', 'race_id', 'level_adjustment', 'ecl', 'minimum_starting_ecl'])
    && stringField(payload, 'record_id')
    && validRaceId(payload['race_id'])
    && nonNegativeSafeInteger(payload['level_adjustment'])
    && nonNegativeSafeInteger(payload['ecl'])
    && nonNegativeSafeInteger(payload['minimum_starting_ecl'])
    && payload['minimum_starting_ecl'] >= 1;
}

function validRaceVariantChosenPayload(payload: Record<string, unknown>): boolean {
  return exactKeys(payload, ['record_id', 'race_id', 'variant_id', 'level_adjustment', 'minimum_starting_ecl'])
    && stringField(payload, 'record_id')
    && validRaceId(payload['race_id'])
    && stringField(payload, 'variant_id')
    && nonNegativeSafeInteger(payload['level_adjustment'])
    && nonNegativeSafeInteger(payload['minimum_starting_ecl'])
    && payload['minimum_starting_ecl'] >= 1;
}

function validPrestigeLevelGainedPayload(payload: Record<string, unknown>): boolean {
  if (!exactKeys(payload, ['record_id', 'prestige_id', 'prestige_level', 'eligibility_evidence_ids', 'advances'])
    || !stringField(payload, 'record_id')
    || typeof payload['prestige_id'] !== 'string'
    || !/^dnd35\.prestige\.[a-z0-9_]+$/u.test(payload['prestige_id'])
    || !Number.isSafeInteger(payload['prestige_level'])
    || Number(payload['prestige_level']) < 1
    || !Array.isArray(payload['eligibility_evidence_ids'])
    || payload['eligibility_evidence_ids'].some(id => typeof id !== 'string' || id.length === 0)
    || new Set(payload['eligibility_evidence_ids']).size !== payload['eligibility_evidence_ids'].length
    || !plainObject(payload['advances'])) return false;

  const advances = payload['advances'];
  const allowed = new Set([
    'spellcasting', 'manifesting', 'arcane_class_id', 'divine_class_id',
    'spellcasting_class_id', 'manifesting_class_id', 'own_spellcasting',
    'own_manifesting', 'bonus_spell_slots', 'caster_level_only'
  ]);
  if (Object.keys(advances).some(key => !allowed.has(key))
    || typeof advances['spellcasting'] !== 'boolean'
    || typeof advances['manifesting'] !== 'boolean') return false;
  for (const field of ['arcane_class_id', 'divine_class_id', 'spellcasting_class_id', 'manifesting_class_id']) {
    if (advances[field] !== undefined && (typeof advances[field] !== 'string' || advances[field].length === 0)) return false;
  }
  for (const field of ['own_spellcasting', 'own_manifesting', 'caster_level_only']) {
    if (advances[field] !== undefined && advances[field] !== true) return false;
  }
  if (advances['bonus_spell_slots'] !== undefined
    && (!Number.isSafeInteger(advances['bonus_spell_slots']) || Number(advances['bonus_spell_slots']) < 1)) return false;

  const hasSpellcastingProgression = [
    advances['arcane_class_id'], advances['divine_class_id'], advances['spellcasting_class_id']
  ].some(value => typeof value === 'string')
    || advances['own_spellcasting'] === true
    || advances['caster_level_only'] === true
    || typeof advances['bonus_spell_slots'] === 'number';
  const hasManifestingProgression = typeof advances['manifesting_class_id'] === 'string'
    || advances['own_manifesting'] === true;
  return advances['spellcasting'] === hasSpellcastingProgression
    && advances['manifesting'] === hasManifestingProgression;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(item => right.includes(item));
}

export function validateDnd35AdapterEvent(value: unknown): Result<Dnd35AdapterEvent, Dnd35AdapterEventError> {
  const schema = validateRuntimeContract('Dnd35AdapterEvent', value);
  if (!schema.ok) return failure('INVALID_ADAPTER_EVENT', schema.errors.join(','));
  const event = value as Dnd35AdapterEvent;
  const payload = event.payload as Record<string, unknown>;
  if (event.committed_adapter_version !== event.base_adapter_version + 1
    || !Number.isSafeInteger(event.committed_adapter_version)) {
    return failure('INVALID_ADAPTER_EVENT', 'La versión confirmada debe suceder exactamente a la versión base.');
  }

  if (event.event_type === 'RACE_OPTION_SELECTED') {
    if (!validRaceOptionSelectedPayload(payload)) {
      return failure('INVALID_ADAPTER_EVENT', 'RACE_OPTION_SELECTED requiere ficha, modifiers y selecciones raciales exactas.');
    }
  } else if (event.event_type === 'RACIAL_HD_APPLIED') {
    if (!validRacialHdAppliedPayload(payload)) {
      return failure('INVALID_ADAPTER_EVENT', 'RACIAL_HD_APPLIED requiere RHD, paquete coherente y total HD.');
    }
  } else if (event.event_type === 'LEVEL_ADJUSTMENT_APPLIED') {
    if (!validLevelAdjustmentAppliedPayload(payload)) {
      return failure('INVALID_ADAPTER_EVENT', 'LEVEL_ADJUSTMENT_APPLIED requiere LA, ECL y minimum starting ECL.');
    }
  } else if (event.event_type === 'RACE_VARIANT_CHOSEN') {
    if (!validRaceVariantChosenPayload(payload)) {
      return failure('INVALID_ADAPTER_EVENT', 'RACE_VARIANT_CHOSEN requiere variante y valores efectivos explícitos.');
    }
  } else if (event.event_type === 'PRESTIGE_LEVEL_GAINED') {
    if (!validPrestigeLevelGainedPayload(payload)) {
      return failure('INVALID_ADAPTER_EVENT', 'PRESTIGE_LEVEL_GAINED requiere prestigio, nivel, evidencia y progresión explícita coherente.');
    }
  } else if (event.event_type === 'RULE_RULING_RECORDED') {
    const keys = ['ruling_id', 'question', 'answer', 'source_refs', 'errata_status', 'scope', 'campaign_id', 'created_at', 'supersedes'];
    if (!exactKeys(payload, keys)
      || !['ruling_id', 'question', 'answer', 'errata_status', 'scope', 'campaign_id', 'created_at']
        .every(key => stringField(payload, key))
      || payload['campaign_id'] !== event.campaign_id
      || !Array.isArray(payload['source_refs'])
      || !payload['source_refs'].every(ref => typeof ref === 'string' && ref.length > 0)
      || !sameStringSet(payload['source_refs'], event.source_refs)
      || (payload['supersedes'] !== null && (typeof payload['supersedes'] !== 'string' || payload['supersedes'].length === 0))
      || Number.isNaN(Date.parse(String(payload['created_at'])))) {
      return failure('INVALID_ADAPTER_EVENT', 'RULE_RULING_RECORDED no conserva toda la procedencia requerida.');
    }
  } else if (event.event_type === 'HOUSE_RULE_ENABLED') {
    if (!exactKeys(payload, ['house_rule_id', 'rule', 'scope'])
      || !['house_rule_id', 'rule', 'scope'].every(key => stringField(payload, key))
      || !event.source_refs.includes(String(payload['house_rule_id']))) {
      return failure('INVALID_ADAPTER_EVENT', 'HOUSE_RULE_ENABLED no identifica regla, contenido, scope y fuente.');
    }
  } else if (event.event_type === 'HOUSE_RULE_DISABLED') {
    if (!exactKeys(payload, ['house_rule_id'])
      || !stringField(payload, 'house_rule_id')
      || !event.source_refs.includes(String(payload['house_rule_id']))) {
      return failure('INVALID_ADAPTER_EVENT', 'HOUSE_RULE_DISABLED no identifica la house rule y su fuente.');
    }
  } else if (!stringField(payload, 'record_id')) {
    return failure('INVALID_ADAPTER_EVENT', `${event.event_type} requiere record_id.`);
  }
  return ok(structuredClone(event));
}

export function replayDnd35AdapterEvents(
  events: readonly Dnd35AdapterEvent[]
): Result<Dnd35AdapterState, Dnd35AdapterEventError> {
  return replayEvents(events, false);
}

/** Mixed branch replay is private to the filesystem store after verified ancestry reads. */
function replayEvents(events: readonly Dnd35AdapterEvent[], verifiedLineage: boolean): Result<Dnd35AdapterState, Dnd35AdapterEventError> {
  let version = 0;
  let campaignId: string | undefined;
  let branchId: string | undefined;
  const applied: string[] = [];
  const ids = new Set<string>();
  const rulings: Record<string, PersistedRuling> = {};
  const houseRules: Record<string, CampaignHouseRule> = {};
  const raceApplications: Record<string, ReplayedRaceApplication> = {};
  const raceMechanics: Record<string, {
    racialHitDice?: number;
    totalHd?: number;
    levelAdjustment?: number;
    minimumStartingEcl?: number;
  }> = {};

  for (const raw of events) {
    const checked = validateDnd35AdapterEvent(raw);
    if (!checked.ok) return checked;
    const event = checked.value;
    if (ids.has(event.event_id)) return failure('EVENT_ID_CONFLICT', `event_id duplicado: ${event.event_id}`);
    if (campaignId !== undefined && event.campaign_id !== campaignId) return failure('CAMPAIGN_MISMATCH', 'El log mezcla campañas.');
    if (!verifiedLineage && branchId !== undefined && event.branch_id !== branchId) return failure('BRANCH_MISMATCH', 'El log mezcla ramas.');
    if (event.base_adapter_version !== version || event.committed_adapter_version !== version + 1) {
      return failure('STALE_ADAPTER_VERSION', `Secuencia inválida en ${event.event_id}.`);
    }
    campaignId = event.campaign_id;
    branchId = event.branch_id;
    version = event.committed_adapter_version;
    ids.add(event.event_id);
    applied.push(event.event_id);

    if (['RACE_OPTION_SELECTED', 'RACIAL_HD_APPLIED', 'LEVEL_ADJUSTMENT_APPLIED', 'RACE_VARIANT_CHOSEN']
      .includes(event.event_type)) {
      const payload = event.payload as Record<string, unknown>;
      const recordId = String(payload['record_id']);
      const raceId = String(payload['race_id']);
      const existing = raceApplications[recordId];
      const eventType = event.event_type as RaceAdapterEventType;
      if (existing === undefined) {
        if (eventType !== 'RACE_OPTION_SELECTED') {
          return failure('INVALID_ADAPTER_EVENT', `La aplicación racial ${recordId} no comienza con RACE_OPTION_SELECTED.`);
        }
        raceApplications[recordId] = {
          record_id: recordId,
          race_id: raceId,
          status: 'PARTIAL',
          event_types: [eventType],
          source_refs: [...event.source_refs],
          variant_id: payload['variant_id'] as string | null
        };
        raceMechanics[recordId] = {};
      } else {
        if (existing.status === 'COMPLETE'
          || existing.race_id !== raceId
          || !sameStringSet(existing.source_refs, event.source_refs)) {
          return failure('INVALID_ADAPTER_EVENT', `La aplicación racial ${recordId} está duplicada o es incoherente.`);
        }
        const expected = [
          'RACE_OPTION_SELECTED', 'RACIAL_HD_APPLIED', 'LEVEL_ADJUSTMENT_APPLIED',
          ...(existing.variant_id === null ? [] : ['RACE_VARIANT_CHOSEN'])
        ] as const;
        if (eventType !== expected[existing.event_types.length]) {
          return failure('INVALID_ADAPTER_EVENT', `Paso racial inesperado ${eventType} para ${recordId}.`);
        }
        const eventTypes = [...existing.event_types, eventType];
        const isComplete = eventTypes.length === expected.length;
        raceApplications[recordId] = {
          ...existing,
          status: isComplete ? 'COMPLETE' : 'PARTIAL',
          event_types: eventTypes
        };

        const mechanics = raceMechanics[recordId]!;
        if (eventType === 'RACIAL_HD_APPLIED') {
          mechanics.racialHitDice = Number(payload['racial_hit_dice']);
          mechanics.totalHd = Number(payload['total_hd']);
        } else if (eventType === 'LEVEL_ADJUSTMENT_APPLIED') {
          if (mechanics.racialHitDice === undefined || mechanics.totalHd === undefined) {
            return failure('INVALID_ADAPTER_EVENT', `Falta RHD para ${recordId}.`);
          }
          const levelAdjustment = Number(payload['level_adjustment']);
          const minimumStartingEcl = Number(payload['minimum_starting_ecl']);
          if (Number(payload['ecl']) !== mechanics.totalHd + levelAdjustment
            || minimumStartingEcl !== Math.max(1, mechanics.racialHitDice) + levelAdjustment) {
            return failure('INVALID_ADAPTER_EVENT', `RHD/LA/ECL incoherentes para ${recordId}.`);
          }
          mechanics.levelAdjustment = levelAdjustment;
          mechanics.minimumStartingEcl = minimumStartingEcl;
        } else if (eventType === 'RACE_VARIANT_CHOSEN') {
          if (mechanics.levelAdjustment === undefined || mechanics.minimumStartingEcl === undefined
            || payload['variant_id'] !== existing.variant_id
            || payload['level_adjustment'] !== mechanics.levelAdjustment
            || payload['minimum_starting_ecl'] !== mechanics.minimumStartingEcl) {
            return failure('INVALID_ADAPTER_EVENT', `La variante de ${recordId} no coincide con la aplicación racial.`);
          }
        }
      }
    }

    if (event.event_type === 'RULE_RULING_RECORDED') {
      const payload = event.payload as Record<string, unknown>;
      const rulingId = String(payload['ruling_id']);
      const supersedes = payload['supersedes'] as string | null;
      if (supersedes !== null && rulings[supersedes] === undefined) {
        return failure('INVALID_ADAPTER_EVENT', `El ruling ${rulingId} supersede un ruling inexistente.`);
      }
      if (rulings[rulingId] !== undefined) return failure('EVENT_ID_CONFLICT', `ruling_id duplicado: ${rulingId}`);
      rulings[rulingId] = {
        ruling_id: rulingId,
        question: String(payload['question']),
        answer: String(payload['answer']),
        source_refs: [...event.source_refs],
        errata_status: String(payload['errata_status']),
        scope: String(payload['scope']),
        campaign_id: String(payload['campaign_id']),
        created_at: String(payload['created_at']),
        supersedes
      };
    } else if (event.event_type === 'HOUSE_RULE_ENABLED') {
      const payload = event.payload as Record<string, unknown>;
      const houseRuleId = String(payload['house_rule_id']);
      houseRules[houseRuleId] = {
        house_rule_id: houseRuleId,
        rule: String(payload['rule']),
        scope: String(payload['scope']),
        enabled: true,
        source_refs: [...event.source_refs]
      };
    } else if (event.event_type === 'HOUSE_RULE_DISABLED') {
      const houseRuleId = String((event.payload as Record<string, unknown>)['house_rule_id']);
      const existing = houseRules[houseRuleId];
      if (existing === undefined) return failure('INVALID_ADAPTER_EVENT', `No existe house rule ${houseRuleId} para desactivar.`);
      houseRules[houseRuleId] = { ...existing, enabled: false, source_refs: [...event.source_refs] };
    }
  }
  return ok({
    adapter_version: version,
    ...(campaignId === undefined ? {} : { campaign_id: campaignId }),
    ...(branchId === undefined ? {} : { branch_id: branchId }),
    applied_event_ids: applied,
    rulings,
    house_rules: houseRules,
    race_applications: raceApplications
  });
}

export function buildCampaignRuleView<T>(baseCatalog: T, state: Dnd35AdapterState): {
  readonly base_catalog: T;
  readonly active_house_rules: readonly { readonly house_rule_id: string; readonly rule: string; readonly scope: string }[];
} {
  return {
    base_catalog: structuredClone(baseCatalog),
    active_house_rules: Object.values(state.house_rules)
      .filter(rule => rule.enabled)
      .sort((left, right) => left.house_rule_id.localeCompare(right.house_rule_id))
      .map(rule => ({ house_rule_id: rule.house_rule_id, rule: rule.rule, scope: rule.scope }))
  };
}

function safeBranch(branchId: string): string {
  if (!/^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(branchId)) throw new Error(`Unsafe branch id: ${branchId}`);
  return branchId;
}

export class JsonDnd35AdapterEventStore {
  readonly #eventsDirectory: string;
  readonly #root: string;

  constructor(campaignRoot: string) {
    this.#root = campaignRoot;
    this.#eventsDirectory = path.join(campaignRoot, 'dnd35-events');
  }

  fileFor(branchId: string): string {
    return path.join(this.#eventsDirectory, `${safeBranch(branchId)}.jsonl`);
  }

  async #initialize(): Promise<void> {
    await fs.mkdir(this.#eventsDirectory, { recursive: true });
  }

  async tail(branchId: string): Promise<Result<Dnd35AdapterEvent[], Dnd35AdapterEventError>> {
    try {
      // Strict reads preserve partial bytes as evidence; recovery must not silently truncate authority.
      const timelineFile = path.join(this.#root, 'timeline', 'entries.jsonl');
      let campaignId: string | undefined;
      try {
        const timelineText = await fs.readFile(timelineFile, 'utf8');
        const first = timelineText.split('\n').find(Boolean);
        if (first) campaignId = (JSON.parse(first) as { campaign_id: string }).campaign_id;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      let text: string;
      try {
        text = await fs.readFile(this.fileFor(branchId), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') text = '';
        else throw error;
      }
      if (text !== '' && !text.endsWith('\n')) return failure('CORRUPT_DATA', 'Tail D&D parcial; no se modifica el histórico.');
      const events: Dnd35AdapterEvent[] = [];
      for (const [index, line] of text.split('\n').entries()) {
        if (line.length === 0) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          return failure('CORRUPT_DATA', `JSON inválido en línea ${index + 1}.`);
        }
        const checked = validateDnd35AdapterEvent(value);
        if (!checked.ok) return failure('CORRUPT_DATA', `Evento inválido en línea ${index + 1}: ${checked.error.message}`);
        if (checked.value.branch_id !== branchId) return failure('BRANCH_MISMATCH', 'El evento no pertenece al archivo de rama.');
        events.push(checked.value);
      }
      campaignId ??= events[0]?.campaign_id;
      if (campaignId === undefined) return ok(events);
      const boundary = await captureDnd35Boundary(this.#root, campaignId, branchId);
      const inheritedEvents = boundary.events;
      const replay = replayEvents(inheritedEvents, true);
      return replay.ok ? ok(inheritedEvents) : replay;
    } catch (error) {
      return failure('IO_ERROR', `No se pudo leer el event log D&D: ${String(error)}`);
    }
  }

  async replay(branchId: string): Promise<Result<Dnd35AdapterState, Dnd35AdapterEventError>> {
    const events = await this.tail(branchId);
    if (!events.ok) return events;
    const replay = replayEvents(events.value, true);
    return replay.ok ? ok({ ...replay.value, branch_id: branchId }) : replay;
  }

  async appendBatch(
    branchId: string,
    events: readonly Dnd35AdapterEvent[]
  ): Promise<Result<void, Dnd35AdapterEventError>> {
    const validated: Dnd35AdapterEvent[] = [];
    for (const event of events) {
      const checked = validateDnd35AdapterEvent(event);
      if (!checked.ok) return checked;
      if (checked.value.branch_id !== branchId) return failure('BRANCH_MISMATCH', 'El evento no pertenece a la rama solicitada.');
      validated.push(checked.value);
    }
    const current = await this.tail(branchId);
    if (!current.ok) return current;
    const byId = new Map(current.value.map(event => [event.event_id, event]));
    const pending: Dnd35AdapterEvent[] = [];
    for (const event of validated) {
      const existing = byId.get(event.event_id);
      if (existing !== undefined) {
        if (canonicalJson(existing) !== canonicalJson(event)) {
          return failure('EVENT_ID_CONFLICT', `event_id ${event.event_id} ya existe con otro contenido.`);
        }
        continue;
      }
      byId.set(event.event_id, event);
      pending.push(event);
    }
    const combined = [...current.value, ...pending];
    const sequence = replayEvents(combined, true);
    if (!sequence.ok) return sequence;
    if (pending.length === 0) return ok(undefined);
    // New source admissions must not create a log that the verified boundary cannot read.
    // Historical envelopes are not rewritten or retroactively upgraded by this check.
    for (const event of pending.filter(candidate => candidate.event_type === 'RULE_SOURCE_REGISTERED')) {
      const payload = event.payload as Record<string, unknown>;
      if (!validateRuntimeContract('RuleSourceRecord', payload['source_record']).ok) return failure('INVALID_ADAPTER_EVENT', 'La fuente nueva requiere su contrato.');
      const source = payload['source_record'] as InternalRuleSourceRecord.RuleSourceRecordV1;
      if (source.source_id !== payload['record_id'] || !event.source_refs.includes(source.source_id)
        || combined.some(candidate => candidate !== event && candidate.event_type === 'RULE_SOURCE_REGISTERED'
          && (candidate.payload as Record<string, unknown>)['record_id'] === source.source_id)) return failure('INVALID_ADAPTER_EVENT', 'Identidad de fuente inválida o duplicada.');
      if (source.local_excerpt_ref !== null || source.content_sha256 !== null) {
        if (source.local_excerpt_ref === null || source.content_sha256 === null || !source.local_excerpt_ref.startsWith('rules/')) return failure('INVALID_ADAPTER_EVENT', 'La fuente requiere bytes y hash locales.');
        try {
          if (sha256(await readBoundFile(this.#root, source.local_excerpt_ref)) !== source.content_sha256) return failure('INVALID_ADAPTER_EVENT', 'Hash de fuente inválido.');
        } catch { return failure('INVALID_ADAPTER_EVENT', 'No se puede verificar el extracto local.'); }
      }
    }
    try {
      await this.#initialize();
      const handle = await fs.open(this.fileFor(branchId), 'a');
      try {
        await handle.writeFile(pending.map(canonicalJson).join(''), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return ok(undefined);
    } catch (error) {
      return failure('IO_ERROR', `No se pudo anexar el lote D&D: ${String(error)}`);
    }
  }
}
