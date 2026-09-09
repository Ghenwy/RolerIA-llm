import { validateJsonSchema, validateRuntimeContract } from '@nyx/contracts';
import { err, ok, type Result, type DiceState } from '@nyx/domain';
import type { Dnd35ProtectedCatalog } from './catalogs/protected-catalog.js';
import { validateCharacterExtension, type CharacterExtension } from './contracts/character-extension.js';
import { validateRuleQuery } from './contracts/rule-contracts.js';
import sourceIndex from '../../../rulesets/dnd35_srd_ogc/sources.json' with { type: 'json' };
import type { Dnd35AdapterState } from './events/adapter-events.js';
import { abilityModifier } from './math/fundamental-formulas.js';
import { deriveLevelIdentities, type LevelIdentityInput } from './math/level-identities.js';
import { evaluatePrestigeEligibility, type PrestigeEligibilityEvidence } from './prestige/eligibility.js';
import { buildRaceApplicationEvents, evaluateRaceApplication, type RaceApplicationSelections, type RaceCharacterSnapshot, type RaceApplicationEventContext } from './races/application.js';
import { buildPrestigeLevelGainedEvent, type PrestigeAdvancementSelection, type PrestigeLevelEventContext } from './prestige/progression.js';
import { DND35_RULESET_ID } from './sources/ruleset-manifest.js';
import { resolveApplicationSources, type LoadedRuleSource } from './sources/application-sources.js';
import { runApplicationCalculation } from './rules/application-calculations.js';

type AdapterResult = Result<unknown, { readonly code: string; readonly message: string }>;
const text = { type: 'string', minLength: 1 };
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const strings = { type: 'array', items: text, uniqueItems: true };
const occurredAt = { type: 'string', format: 'date-time' };
function object(properties: Record<string, object>, required = Object.keys(properties)): object {
  return { type: 'object', additionalProperties: false, required, properties };
}
const classes = { type: 'array', items: object({ class_id: text, class_kind: { enum: ['BASE', 'PRESTIGE'] }, class_level: integer }) };
const casters = { type: 'array', items: object({ source_id: text, caster_level: integer }) };
const manifesters = { type: 'array', items: object({ source_id: text, manifester_level: integer }) };
const identitySchema = object({ class_levels: classes, racial_hit_dice: integer, level_adjustment: integer, caster_levels: casters, manifester_levels: manifesters });
const raceSchema = object({
  raceId: text,
  character: object({ recordId: text, abilityScores: object(Object.fromEntries(['str', 'dex', 'con', 'int', 'wis', 'cha'].map(key => [key, integer]))),
    classLevels: classes, casterLevels: casters, manifesterLevels: manifesters }),
  selections: object({ variantId: text, traitChoices: { type: 'object', propertyNames: text, additionalProperties: text } }, []),
  event: object({ eventIdPrefix: text, actorId: text, occurredAt })
}, ['raceId', 'character', 'selections']);
const prestigeSchema = object({
  prestigeId: text, nextLevel: { ...integer, minimum: 1 },
  character: object({
    alignment: { enum: ['lawful_good', 'neutral_good', 'chaotic_good', 'lawful_neutral', 'true_neutral', 'chaotic_neutral', 'lawful_evil', 'neutral_evil', 'chaotic_evil'] },
    raceTags: strings, bab: integer, skills: { type: 'object', propertyNames: text, additionalProperties: integer },
    skillPatterns: strings, feats: strings, featPatterns: strings, languages: strings, proficiencies: strings,
    spellcastingEvidence: strings, psionicsEvidence: strings,
    prestigeLevels: { type: 'object', propertyNames: text, additionalProperties: integer },
    specialEvidence: { type: 'array', items: object({ requirement: text, evidenceId: text, sourceRefs: { ...strings, minItems: 1 } }) }
  }),
  selection: object({ arcaneClassId: text, divineClassId: text, spellcastingClassId: text, manifestingClassId: text }, []),
  event: object({ eventId: text, recordId: text, actorId: text, occurredAt })
}, ['prestigeId', 'nextLevel', 'character']);
const resolveSchema = object({ query: { type: 'object' }, calculation: object({ kind: text, input: {} }) });
const lookupSchema = object({ query: { type: 'object' }, ruleId: text, material: { enum: ['OPEN', 'CLOSED'] } });
const fail = (code = 'SCHEMA_INVALID', message = 'Entrada de reglas inválida.'): AdapterResult => err({ code, message });

/** [DESIGN] Read-only previews. No generic natural-language adjudication or implicit source fallback. */
export class Dnd35RulesAdapter {
  readonly rulesetId = DND35_RULESET_ID;
  readonly #catalog: Dnd35ProtectedCatalog;
  readonly #state: Dnd35AdapterState;
  readonly #stateVersion: number;
  readonly #sources: readonly LoadedRuleSource[];
  readonly #rng: DiceState | undefined;
  readonly #identity: { campaignId: string; branchId: string } | undefined;

  constructor(catalog: Dnd35ProtectedCatalog, state: Dnd35AdapterState, stateVersion: number, sources: readonly LoadedRuleSource[] = [], rng?: DiceState, identity?: { campaignId: string; branchId: string }) {
    this.#catalog = catalog;
    this.#state = structuredClone(state);
    this.#stateVersion = stateVersion;
    this.#sources = structuredClone(sources);
    this.#rng = rng === undefined ? undefined : structuredClone(rng);
    this.#identity = identity === undefined ? undefined : structuredClone(identity);
  }

  validateRace(input: unknown): AdapterResult {
    if (!validateJsonSchema(raceSchema, input).ok) return fail();
    const request = input as { raceId: string; character: Omit<RaceCharacterSnapshot, 'raceApplications'>; selections: RaceApplicationSelections;
      event?: Pick<RaceApplicationEventContext, 'eventIdPrefix' | 'actorId' | 'occurredAt'> };
    const application = evaluateRaceApplication(this.#catalog.findExoticRace(request.raceId) ?? request.raceId,
      { ...request.character, raceApplications: this.#state.race_applications }, request.selections);
    if (!application.ok) return application;
    let events;
    if (request.event !== undefined) {
      if (this.#identity === undefined) return fail('RULES_CONTEXT_UNAVAILABLE');
      const built = buildRaceApplicationEvents(application.value, { ...request.event, ...this.#identity, baseAdapterVersion: this.#state.adapter_version });
      if (!built.ok) return built;
      events = built.value;
    }
    return ok({ application: application.value, proposals_only: true, hypothetical: true, state_version: this.#stateVersion, ...(events === undefined ? {} : { events }) });
  }

  validatePrestige(input: unknown): AdapterResult {
    if (!validateJsonSchema(prestigeSchema, input).ok) return fail();
    const request = input as { prestigeId: string; character: PrestigeEligibilityEvidence; nextLevel: number;
      selection?: PrestigeAdvancementSelection; event?: Pick<PrestigeLevelEventContext, 'eventId' | 'recordId' | 'actorId' | 'occurredAt'> };
    const prestige = this.#catalog.findPrestigeClass(request.prestigeId);
    if (prestige === undefined) return fail('UNREGISTERED_PRESTIGE_OPTION', 'La clase no pertenece al catálogo protegido.');
    if (request.character.specialEvidence.some(item => item.sourceRefs.some(ref => ref !== prestige.source_url))) {
      return fail('SOURCE_BLOCKED', 'La evidencia hipotética no está referenciada a la clase protegida.');
    }
    if ((request.selection === undefined) !== (request.event === undefined)) return fail();
    let events;
    if (request.selection !== undefined && request.event !== undefined) {
      if (this.#identity === undefined) return fail('RULES_CONTEXT_UNAVAILABLE');
      const built = buildPrestigeLevelGainedEvent({ prestige, character: request.character, nextLevel: request.nextLevel, selection: request.selection,
        event: { ...request.event, ...this.#identity, baseAdapterVersion: this.#state.adapter_version } });
      if (!built.ok) return built;
      events = [built.value];
    }
    return ok({ eligibility: evaluatePrestigeEligibility(prestige, request.character, request.nextLevel),
      proposals_only: true, hypothetical: true, source_refs: [prestige.source_url], state_version: this.#stateVersion, ...(events === undefined ? {} : { events }) });
  }

  validateCharacter(input: unknown): AdapterResult {
    if (!validateRuntimeContract('Dnd35CharacterExtension', input).ok) return fail();
    const extension = input as CharacterExtension;
    const race = this.#catalog.findExoticRace(extension.race_option_id);
    if (race === undefined) return fail('UNREGISTERED_RACE_OPTION', 'La raza no pertenece al catálogo protegido.');
    const sourceRefs = ['SOURCE-SRD-CORE', race.source_url, ...this.#catalog.prestigeClasses.map(entry => entry.source_url)];
    if (extension.source_refs.some(ref => !sourceRefs.includes(ref))) return fail('SOURCE_BLOCKED', 'La ficha contiene una fuente no registrada.');
    const racial = race.racial_hd_package;
    const report = validateCharacterExtension(input, { racial_bab: racial?.bab ?? 0,
      racial_saves: { fortitude: racial?.saves.fort ?? 0, reflex: racial?.saves.ref ?? 0, will: racial?.saves.will ?? 0 }, registered_source_refs: sourceRefs });
    // Internal arithmetic alone cannot certify a caller-supplied RHD/LA against the protected race.
    const raceMismatch = extension.racial_hit_dice !== race.racial_hd || extension.level_adjustment !== race.level_adjustment;
    return ok({ validation: raceMismatch ? { ...report, status: 'fail', discrepancies: [...report.discrepancies, 'racial_catalog'],
      corrective_proposals: [...report.corrective_proposals, { field: 'racial_hit_dice', expected: race.racial_hd }, { field: 'level_adjustment', expected: race.level_adjustment }] } : report,
    proposals_only: true, hypothetical: true, state_version: this.#stateVersion });
  }

  resolveRule(input: unknown): AdapterResult {
    if (validateJsonSchema(lookupSchema, input).ok) {
      const request = input as { query: unknown; ruleId: string; material: 'OPEN' | 'CLOSED' };
      const query = validateRuleQuery(request.query);
      if (!query.ok) return fail();
      if (query.value.state_version !== this.#stateVersion) return fail('STALE_STATE');
      if (query.value.requested_resolution === 'source_lookup') {
        const source = sourceIndex.sources.find(source => source.source_id === request.ruleId);
        if (source === undefined || !query.value.source_scope.allowed_source_ids.includes(source.source_id)) return fail('SOURCE_BLOCKED');
        return ok({ query_id: query.value.query_id, source: structuredClone(source), metadata_only: true,
          proposals_only: true, state_version: this.#stateVersion });
      }
      return resolveApplicationSources(query.value, request.ruleId, request.material, this.#sources, this.#state);
    }
    if (!validateJsonSchema(resolveSchema, input).ok) return fail();
    const request = input as { query: unknown; calculation: { kind: string; input: unknown } };
    const parsed = validateRuleQuery(request.query);
    if (!parsed.ok) return fail();
    const query = parsed.value;
    if (query.state_version !== this.#stateVersion) return fail('STALE_STATE', 'La consulta no corresponde al snapshot confirmado.');
    if (query.requested_resolution !== 'roll_formula') return fail('SOURCE_BLOCKED', 'El calculador no arbitra preguntas de texto libre.');
    let result: AdapterResult;
    if (request.calculation.kind === 'ability_modifier') {
      if (!validateJsonSchema(integer, request.calculation.input).ok) return fail();
      result = abilityModifier(request.calculation.input as number);
    } else if (request.calculation.kind === 'level_identities') {
      if (!validateJsonSchema(identitySchema, request.calculation.input).ok) return fail();
      result = deriveLevelIdentities(request.calculation.input as LevelIdentityInput);
    } else {
      if (this.#rng === undefined) return fail('RULES_CONTEXT_UNAVAILABLE');
      result = runApplicationCalculation(request.calculation.kind, request.calculation.input, this.#rng);
    }
    if (!result.ok) return result;
    const validated = resolveApplicationSources(query, request.calculation.kind, 'OPEN', this.#sources, this.#state,
      `Cálculo determinista ${request.calculation.kind}: ${JSON.stringify(result.value)}`);
    if (!validated.ok) return validated;
    // A textual override cannot silently become an executable replacement formula.
    if (!validated.value.compiled_selected) return fail('SOURCE_BLOCKED', 'La regla superior requiere arbitraje explícito; no se ejecuta la fórmula SRD desplazada.');
    return ok({ ...validated.value, value: result.value, calculation: request.calculation.kind, hypothetical: true, state_version: this.#stateVersion });
  }
}
