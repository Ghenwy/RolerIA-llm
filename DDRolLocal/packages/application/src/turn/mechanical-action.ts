import { runtimeContractSchema, validateJsonSchema, validateRuntimeContract,
  type DesignTurnEnvelope, type InternalHealthChangeV1, type InternalMechanicalActionV1,
  type InternalMechanicalActionV11 } from '@nyx/contracts';
import { canonicalJson, healthStateForHitPoints } from '@nyx/domain';
import type { RunTurnInput, TurnPortResult } from './turn-orchestrator.js';

export type MechanicalAction = InternalMechanicalActionV1.MechanicalActionV1 | InternalMechanicalActionV11.MechanicalActionV11;
export interface TurnMechanicalPort {
  prepare(input: RunTurnInput): Promise<TurnPortResult<MechanicalAction | null>>;
  /** Code-only operation. Any staged events remain private to the existing transaction adapter. */
  resolveAssistedMechanic?(input: RunTurnInput): Promise<TurnPortResult<{ narration: string }>>;
}
const fail = (code: string): TurnPortResult<never> => ({ ok: false,
  error: { code, message: `Acción mecánica bloqueada: ${code}. Selecciona una acción registrada con /action <id>.` } });
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function at(value: unknown, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (['__proto__', 'prototype', 'constructor'].includes(key) || !record(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}
function expressionParts(expression: string) {
  const match = /^([1-9]\d*)d([1-9]\d*)([+-]\d+)?$/.exec(expression);
  if (!match) return null;
  const count = Number(match[1]), sides = Number(match[2]), modifier = Number(match[3] ?? 0);
  if (count > 1000 || sides < 2 || sides > 1_000_000 || !Number.isSafeInteger(modifier)) return null;
  return { count, sides, modifier };
}

/** Conservative Alpha scope. The explicit profile opt-in is still required; this rejects
 * contradictory effects already recorded on either sheet instead of silently ignoring them. */
function hasUnsupportedEffects(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUnsupportedEffects);
  if (!record(value)) return false;
  const unsupported = new Set(['damage_reduction', 'resistance', 'resistances', 'energy_resistances',
    'regeneration', 'fast_healing', 'immunities', 'special_abilities', 'special_attacks', 'special_qualities', 'conditions']);
  return Object.entries(value).some(([key, child]) => {
    const nonempty = child !== null && child !== false && child !== 0 && child !== ''
      && !(Array.isArray(child) && child.length === 0) && !(record(child) && Object.keys(child).length === 0);
    return (unsupported.has(key) && nonempty) || hasUnsupportedEffects(child);
  });
}
function supportedHealth(sheet: unknown, actor: boolean): InternalMechanicalActionV11.TargetHealthSnapshot | null {
  if (!record(sheet) || Object.hasOwn(sheet, 'hit_points') || hasUnsupportedEffects(sheet)) return null;
  const raw = sheet['health'];
  if (!validateRuntimeContract('Dnd35Health', raw).ok) return null;
  const health = raw as InternalMechanicalActionV11.TargetHealthSnapshot;
  const status = healthStateForHitPoints(health.hp_current);
  if (!Number.isSafeInteger(health.hp_max) || health.hp_max < 1 || health.hp_current > health.hp_max
    || health.temporary_hp !== 0 || health.nonlethal_damage !== 0 || status === undefined || status === 'dead'
    || health.death_state !== status || (actor && status !== 'alive')) return null;
  return structuredClone(health);
}

/** [DESIGN] No NLP authority: only an explicit selector binds a source-backed canonical profile.
 * Profiles are campaign data, never LLM proposals; paths are object keys, not filesystem paths.
 */
export function prepareMechanicalAction(state: unknown, input: Pick<RunTurnInput,
  'campaignId' | 'turnId' | 'baseStateVersion' | 'playerInput'>): TurnPortResult<MechanicalAction | null> {
  if (!record(state) || state['campaign_id'] !== input.campaignId || state['state_version'] !== input.baseStateVersion) return fail('MECHANICAL_STATE_STALE');
  const selected = /^\/action ([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(?:\s|$)/u.exec(input.playerInput);
  if (!selected) return input.playerInput.startsWith('/action') ? fail('MECHANICAL_ACTION_INVALID') : { ok: true, value: null };
  const rawProfile = at(state, ['world', 'mechanical_actions', selected[1]!]);
  const allSchemas = runtimeContractSchema('MechanicalAction') as { oneOf: Record<string, unknown>[] };
  const schema = allSchemas.oneOf[record(rawProfile) && rawProfile['schema_version'] === '1.1' ? 1 : 0]!;
  const validProfile = validateJsonSchema({ $schema: schema['$schema'], $defs: schema['$defs'],
    $ref: '#/$defs/MechanicalActionProfile' }, rawProfile);
  if (!validProfile.ok) return fail('MECHANICAL_ACTION_UNREGISTERED');
  const profile = structuredClone(rawProfile) as MechanicalAction['profile'];
  if (profile.action_id !== selected[1] || at(state, ['characters', profile.actor_id, 'kind']) !== 'player') return fail('MECHANICAL_ACTOR_INVALID');
  if (!record(at(state, ['world', 'mechanical_targets', profile.target_id]))) return fail('MECHANICAL_TARGET_UNCONFIRMED');
  const parameters = Object.fromEntries(Object.entries(profile.parameter_refs).map(([name, keys]) => [name, at(state, keys)]));
  let targetHealth: InternalMechanicalActionV11.TargetHealthSnapshot | null = null;
  if (profile.schema_version === '1.1') {
    if (input.playerInput !== `/action ${profile.action_id}`) return fail('MECHANICAL_ACTION_INVALID');
    if (profile.actor_id === profile.target_id) return fail('MECHANICAL_TARGET_UNCONFIRMED');
    const actorSheet = at(state, ['characters', profile.actor_id, 'sheet']);
    const targetSheet = at(state, ['characters', profile.target_id, 'sheet']);
    if (!supportedHealth(actorSheet, true)) return fail('MECHANICAL_ACTOR_UNSUPPORTED');
    targetHealth = supportedHealth(targetSheet, false);
    if (targetHealth === null) return fail('MECHANICAL_TARGET_UNSUPPORTED');
    const location = at(state, ['world', 'location_id']);
    const present = at(state, ['scene', 'present_character_ids']);
    if (typeof location !== 'string' || location.length === 0 || at(state, ['scene', 'location_id']) !== location
      || at(actorSheet, ['location_id']) !== location || at(targetSheet, ['location_id']) !== location
      || !Array.isArray(present) || !present.includes(profile.actor_id) || !present.includes(profile.target_id)) {
      return fail('MECHANICAL_PARTICIPANT_NOT_PRESENT');
    }
  }
  const action = { schema_version: profile.schema_version, campaign_id: input.campaignId, branch_id: state['branch_id'],
    turn_id: input.turnId, base_state_version: input.baseStateVersion,
    base_rng_counter: at(state, ['rng', 'roll_index']), profile, parameters,
    rolls: [], next_roll: null, outcome: null, narration: null,
    ...(targetHealth === null ? {} : { target_health_snapshot: targetHealth }) };
  if (!validateRuntimeContract('MechanicalAction', action).ok) return fail('MECHANICAL_PARAMETERS_UNCONFIRMED');
  const confirmed = action as unknown as MechanicalAction; // Validated by the shared runtime schema above.
  const damage = expressionParts(confirmed.parameters.damage_expression);
  if (!damage) return fail('MECHANICAL_PARAMETERS_UNCONFIRMED');
  // SOT-06:450-452 requires an additional save at 50+ damage. Alpha has no such transition;
  // reject the entire profile before RNG if even its maximum critical could enter that branch.
  if (confirmed.schema_version === '1.1' && (damage.count + damage.modifier < 1
    || (damage.count * damage.sides + damage.modifier)
      * (confirmed.parameters.critical_immune ? 1 : confirmed.parameters.critical_multiplier) >= 50)) {
    return fail('MECHANICAL_DAMAGE_UNSUPPORTED');
  }
  return { ok: true, value: confirmed };
}

/** [SOT] 06:235-247,449-466. Only DiceEngine results are accepted; result already includes its modifier.
 * v1 calculates weapon base damage only. It does not claim HP mutation, extra damage or unsupported effects.
 */
export function advanceMechanicalAction(action: MechanicalAction, rolls: readonly DesignTurnEnvelope.RollRef[]): TurnPortResult<MechanicalAction> {
  if (!validateRuntimeContract('MechanicalAction', action).ok) return fail('MECHANICAL_CONTRACT_INVALID');
  const frame = { ...structuredClone(action), rolls: structuredClone(rolls), next_roll: null,
    outcome: null, narration: null } as MechanicalAction;
  if (!validateRuntimeContract('MechanicalAction', frame).ok) return fail('MECHANICAL_ROLL_MISMATCH');
  const p = action.parameters;
  const attackExpression = `1d20${p.attack_bonus === 0 ? '' : p.attack_bonus > 0 ? `+${p.attack_bonus}` : p.attack_bonus}`;
  let index = 0;
  let invalid = false;
  function consume(stage: string, expression: string): number | undefined {
    const expected = { roll_id: `ROLL-${action.turn_id}-${stage}`, expression };
    const rolled = rolls[index];
    if (rolled === undefined) { frame.next_roll = expected; return undefined; }
    const parts = expressionParts(expression);
    if (!parts || rolled.roll_id !== expected.roll_id || rolled.expression !== expression
      || rolled.rng_counter !== action.base_rng_counter + index || !Number.isSafeInteger(rolled.result)
      || rolled.result < parts.count + parts.modifier || rolled.result > parts.count * parts.sides + parts.modifier) {
      invalid = true;
      return undefined;
    }
    index += 1;
    return rolled.result;
  }
  const pending = (): TurnPortResult<MechanicalAction> => invalid ? fail('MECHANICAL_ROLL_MISMATCH') : { ok: true, value: frame };
  const total = consume('attack', attackExpression);
  if (total === undefined) return pending();
  const natural = total - p.attack_bonus;
  const hits = natural === 20 || (natural !== 1 && total >= p.armor_class);
  let critical = false;
  if (hits && natural >= p.critical_threshold && !p.critical_immune) {
    const confirmation = consume('confirm', attackExpression);
    if (confirmation === undefined) return pending();
    const confirmationNatural = confirmation - p.attack_bonus;
    critical = confirmationNatural === 20 || (confirmationNatural !== 1 && confirmation >= p.armor_class);
  }
  let damage = 0;
  if (hits) for (let n = 1; n <= (critical ? p.critical_multiplier : 1); n += 1) {
    const rolled = consume(n === 1 ? 'damage' : `damage-${n}`, p.damage_expression);
    if (rolled === undefined) return pending();
    damage += rolled;
  }
  if (index !== rolls.length) return fail('MECHANICAL_EXTRA_ROLL');
  if (damage < 0 || !Number.isSafeInteger(damage)) return fail('MECHANICAL_DAMAGE_UNSUPPORTED');
  frame.outcome = { attack_total: total, natural_attack: natural, hits, critical_confirmed: critical,
    damage_total: damage, effect: frame.profile.effect };
  frame.narration = `El ataque obtiene ${total} frente a CA ${p.armor_class} y ${hits ? 'acierta' : 'falla'}.`
    + (hits ? ` ${critical ? 'Crítico confirmado; daño' : 'Daño'} calculado: ${damage}.` : '')
    + (frame.schema_version === '1.0' ? ' Esta acción registra el cálculo, sin modificar puntos de golpe.'
      : hits ? ` ${frame.profile.target_id}: PG ${frame.target_health_snapshot.hp_current} → ${frame.target_health_snapshot.hp_current - damage}; estado ${healthStateForHitPoints(frame.target_health_snapshot.hp_current - damage)}.`
        : ' No se modifican puntos de golpe.');
  return { ok: true, value: frame };
}

/** [DESIGN] The transaction adapter alone constructs the HP_CHANGED event metadata.
 * Revalidate source-backed profile, parameters, presence, health snapshot and every receipt;
 * state passed here is the confirmed pre-turn state (DiceEngine pending events are not applied).
 */
export function buildWeaponDamageHealthChange(frame: MechanicalAction, state: unknown):
TurnPortResult<InternalHealthChangeV1.HealthChangeV1 | null> {
  if (!validateRuntimeContract('MechanicalAction', frame).ok) return fail('MECHANICAL_CONTRACT_INVALID');
  if (frame.schema_version === '1.0') return { ok: true, value: null };
  const fresh = prepareMechanicalAction(state, { campaignId: frame.campaign_id, turnId: frame.turn_id,
    baseStateVersion: frame.base_state_version, playerInput: `/action ${frame.profile.action_id}` });
  if (!fresh.ok) return fresh;
  if (fresh.value === null || fresh.value.schema_version !== '1.1') return fail('MECHANICAL_STATE_STALE');
  const recalculated = advanceMechanicalAction(fresh.value, frame.rolls);
  if (!recalculated.ok) return recalculated;
  if (recalculated.value.next_roll !== null || recalculated.value.outcome === null
    || canonicalJson(recalculated.value) !== canonicalJson(frame)) return fail('MECHANICAL_RECEIPT_MISMATCH');
  if (!frame.outcome?.hits) return { ok: true, value: null };
  const before = frame.target_health_snapshot;
  const payload = { schema_version: '1.0', kind: 'WEAPON_DAMAGE', character_id: frame.profile.target_id,
    delta: -frame.outcome.damage_total, before_hp: before.hp_current,
    after_hp: before.hp_current - frame.outcome.damage_total, before_death_state: before.death_state,
    after_death_state: healthStateForHitPoints(before.hp_current - frame.outcome.damage_total) };
  if (!validateRuntimeContract('HealthChange', payload).ok) return fail('MECHANICAL_DAMAGE_UNSUPPORTED');
  return { ok: true, value: payload as InternalHealthChangeV1.HealthChangeV1 };
}

/** Independently enforced after decoding and again at the commit boundary, not just grammar. */
export function validateMechanicalCandidate(frame: MechanicalAction | null, candidate: unknown): TurnPortResult<void> {
  if (!record(candidate)) return fail('MECHANICAL_CANDIDATE_INVALID');
  const proposed = candidate['events_to_commit'];
  if (Array.isArray(proposed) && proposed.some(event => record(event) && event['event_type'] === 'HP_CHANGED'
    && record(event['payload']) && event['payload']['kind'] === 'WEAPON_DAMAGE')) {
    return fail('MECHANICAL_EFFECT_MUST_BE_CODE_GENERATED');
  }
  const status = candidate['resolution_status'];
  if (frame === null) return status === 'AWAITING_ROLL' || (Array.isArray(candidate['required_rolls']) && candidate['required_rolls'].length > 0)
    ? fail('MECHANICAL_ACTION_REQUIRED') : { ok: true, value: undefined };
  if (status === 'BLOCKED' || status === 'AWAITING_WORKER') return { ok: true, value: undefined };
  if (frame.next_roll !== null) {
    const requested = candidate['required_rolls'];
    return status === 'AWAITING_ROLL' && Array.isArray(requested) && requested.length === 1
      && record(requested[0]) && Object.keys(requested[0]).length === 2
      && requested[0]['roll_id'] === frame.next_roll.roll_id && requested[0]['expression'] === frame.next_roll.expression
      ? { ok: true, value: undefined } : fail('MECHANICAL_REQUIRED_ROLL');
  }
  return status === 'READY' && frame.outcome !== null && candidate['player_facing_narration'] === frame.narration
    && ['required_rolls', 'events_to_commit', 'patches_to_commit'].every(key => Array.isArray(candidate[key]) && candidate[key].length === 0)
    ? { ok: true, value: undefined } : fail('MECHANICAL_RECEIPT_MISMATCH');
}
