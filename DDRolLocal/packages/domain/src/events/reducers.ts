import { compareCanonicalKeys } from '../canonical-json.js';
import { cloneJson } from '../clone.js';
import { DiceEngine } from '../dice/dice-engine.js';
import { recalculateInventoryWeight, validateCampaignInvariants } from '../campaign/invariants.js';
import { err, ok, type Result } from '../result.js';
import type { CampaignState, CharacterRecord, InventoryItemRecord, InventoryRecord } from '../state/types.js';
import type { AtomicEvent, StateError } from './types.js';
import { validateRuntimeContract, type InternalHealthChangeV1 } from '@nyx/contracts';
import { healthStateForHitPoints } from '../campaign/health.js';

type MutableRecord = Record<string, unknown>;

function eventError(event: AtomicEvent, code: StateError['code'], message: string): Result<never, StateError> {
  return err({ code, message, event_id: event.event_id });
}

function isRecord(value: unknown): value is MutableRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateEnvelope(state: CampaignState, event: AtomicEvent): Result<true, StateError> {
  if (
    event.schema_version !== '1.1' ||
    !/^EV(?:ENT)?-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(event.event_id) ||
    event.actor_id.length === 0 ||
    event.turn_id.length === 0 ||
    event.correlation_id.length === 0 ||
    event.evidence.length === 0 ||
    event.source_refs.length === 0 ||
    event.committed !== true ||
    !isRecord(event.payload)
  ) {
    return eventError(event, 'INVALID_EVENT', 'El evento no contiene todos los metadatos atómicos requeridos.');
  }
  if (event.campaign_id !== state.campaign_id) {
    return eventError(event, 'CAMPAIGN_MISMATCH', 'El evento pertenece a otra campaña.');
  }
  if (event.branch_id !== state.branch_id) {
    return eventError(event, 'BRANCH_MISMATCH', 'El evento pertenece a otra rama.');
  }
  if (state.applied_event_ids.includes(event.event_id)) {
    return eventError(event, 'DUPLICATE_EVENT', 'El event_id ya fue aplicado.');
  }
  if (event.base_state_version !== state.state_version) {
    return eventError(event, 'STALE_STATE_VERSION', 'La versión base del evento no coincide con el estado confirmado.');
  }
  if (event.committed_state_version !== event.base_state_version + 1) {
    return eventError(event, 'VERSION_SEQUENCE_INVALID', 'La versión confirmada debe avanzar exactamente una unidad.');
  }
  return ok(true);
}

function character(state: CampaignState, event: AtomicEvent): Result<CharacterRecord, StateError> {
  const characterId = event.payload['character_id'];
  if (typeof characterId !== 'string' || !state.characters[characterId]) {
    return eventError(event, 'UNRESOLVED_REFERENCE', 'El personaje objetivo no existe.');
  }
  return ok(state.characters[characterId]);
}

function applyHpChanged(state: CampaignState, event: AtomicEvent): Result<true, StateError> {
  const characterId = event.payload['character_id'];
  if (typeof characterId !== 'string' || !Object.hasOwn(state.characters, characterId)) {
    return eventError(event, 'UNRESOLVED_REFERENCE', 'El personaje objetivo no existe.');
  }
  const found = character(state, event);
  if (!found.ok) return found;
  // Explicit sheet authority, never free-form metadata in a historical payload.
  // A present but malformed health field must fail closed, not use a second counter.
  if (Object.hasOwn(found.value.sheet, 'health')) return applyHealthDamage(state, event);
  const delta = event.payload['delta'];
  const hitPoints = found.value.sheet['hit_points'];
  if (typeof delta !== 'number' || !Number.isFinite(delta) || !isRecord(hitPoints)) {
    return eventError(event, 'INVALID_EVENT', 'HP_CHANGED requiere delta y hit_points válidos.');
  }
  const current = hitPoints['current'];
  const maximum = hitPoints['maximum'];
  if (typeof current !== 'number' || typeof maximum !== 'number') {
    return eventError(event, 'INVALID_EVENT', 'hit_points debe contener current y maximum numéricos.');
  }
  const next = current + delta;
  if (!Number.isFinite(next) || next > maximum) {
    return eventError(event, 'INVARIANT_VIOLATION', 'Los puntos de golpe resultantes son inválidos.');
  }
  hitPoints['current'] = next;
  return ok(true);
}

function applyHealthDamage(state: CampaignState, event: AtomicEvent): Result<true, StateError> {
  if (!validateRuntimeContract('HealthChange', event.payload).ok) return eventError(event, 'INVALID_EVENT', 'Payload de salud versionado inválido.');
  const payload = event.payload as InternalHealthChangeV1.HealthChangeV1;
  if (!Object.hasOwn(state.characters, payload.character_id)) return eventError(event, 'UNRESOLVED_REFERENCE', 'El objetivo de salud no existe.');
  const sheet = state.characters[payload.character_id]!.sheet;
  const health = sheet['health'];
  if (Object.hasOwn(sheet, 'hit_points') || !isRecord(health) || !validateRuntimeContract('Dnd35Health', health).ok) {
    return eventError(event, 'INVALID_EVENT', 'Se requiere una única autoridad health conforme al SOT.');
  }
  const current = health['hp_current'], maximum = health['hp_max'];
  if (typeof current !== 'number' || typeof maximum !== 'number' || !Number.isSafeInteger(current) || !Number.isSafeInteger(maximum)
    || maximum < 1 || current > maximum || health['temporary_hp'] !== 0 || health['nonlethal_damage'] !== 0
    || health['death_state'] !== healthStateForHitPoints(current) || health['death_state'] === 'dead'
    || payload.before_hp !== current || payload.before_death_state !== health['death_state']
    || !Number.isSafeInteger(current + payload.delta) || payload.after_hp !== current + payload.delta
    || payload.after_death_state !== healthStateForHitPoints(payload.after_hp)
    || event.targets.length !== 1 || event.targets[0] !== payload.character_id) {
    return eventError(event, 'INVALID_EVENT', 'Salud inconsistente, transición no soportada o daño no vinculado al estado.');
  }
  health['hp_current'] = payload.after_hp;
  health['death_state'] = payload.after_death_state;
  return ok(true);
}

function applySpellSlotUsed(state: CampaignState, event: AtomicEvent): Result<true, StateError> {
  const found = character(state, event);
  if (!found.ok) return found;
  const spellLevel = event.payload['spell_level'];
  const delta = event.payload['delta'];
  const spellSlots = found.value.sheet['spell_slots'];
  if (
    !Number.isInteger(spellLevel)
    || typeof spellLevel !== 'number'
    || spellLevel < 0
    || !Number.isInteger(delta)
    || typeof delta !== 'number'
    || !Number.isSafeInteger(delta)
    || (event.event_type === 'SPELL_SLOT_USED' ? delta >= 0 : delta <= 0)
    || !isRecord(spellSlots)
  ) {
    return eventError(event, 'INVALID_EVENT', 'SPELL_SLOT_USED requiere nivel, delta negativo y spell_slots válidos.');
  }
  const slot = spellSlots[String(spellLevel)];
  if (!isRecord(slot)) {
    return eventError(event, 'UNRESOLVED_REFERENCE', 'El nivel de spell slot no existe en la ficha.');
  }
  const current = slot['current'];
  const maximum = slot['maximum'];
  if (!Number.isInteger(current) || !Number.isInteger(maximum)) {
    return eventError(event, 'INVALID_EVENT', 'El spell slot debe contener current y maximum enteros.');
  }
  const next = Number(current) + delta;
  if (next < 0 || next > Number(maximum)) {
    return eventError(event, 'INVARIANT_VIOLATION', 'El consumo excede los spell slots disponibles.');
  }
  slot['current'] = next;
  return ok(true);
}

function applyTimeAdvanced(state: CampaignState, event: AtomicEvent): Result<true, StateError> {
  const minutes = event.payload['minutes'];
  if (!Number.isInteger(minutes) || typeof minutes !== 'number' || minutes <= 0) {
    return eventError(event, 'INVALID_EVENT', 'TIME_ADVANCED requiere minutos enteros positivos.');
  }
  state.world.elapsed_minutes += minutes;
  return ok(true);
}

function applyLocationChanged(state: CampaignState, event: AtomicEvent): Result<true, StateError> {
  const { from_location_id: from, to_location_id: to, character_ids: travelers, scene } = event.payload;
  if (typeof from !== 'string' || from.length === 0 || typeof to !== 'string' || to.length === 0 || to === from
    || state.world['location_id'] !== from || state.scene['location_id'] !== from
    || !Array.isArray(travelers) || travelers.length === 0 || new Set(travelers).size !== travelers.length
    || !isRecord(scene) || scene['location_id'] !== to || typeof scene['summary'] !== 'string'
    || scene['summary'].length === 0 || !Array.isArray(scene['present_character_ids'])
    || !Array.isArray(scene['immediate_threats']) || !Array.isArray(scene['open_questions'])) {
    return eventError(event, 'INVALID_EVENT', 'LOCATION_CHANGED requiere origen actual, destino y escena explícita completos.');
  }
  const present = scene['present_character_ids'];
  if (new Set(present).size !== present.length || present.some(id => typeof id !== 'string' || !Object.hasOwn(state.characters, id))
    || travelers.some(id => typeof id !== 'string' || !Object.hasOwn(state.characters, id) || !present.includes(id)
      || (state.characters[id]!.sheet['location_id'] !== undefined && state.characters[id]!.sheet['location_id'] !== from))) {
    return eventError(event, 'UNRESOLVED_REFERENCE', 'Los participantes del viaje no coinciden con sus ubicaciones y la escena destino.');
  }
  for (const id of travelers as string[]) state.characters[id]!.sheet['location_id'] = to;
  state.world['location_id'] = to;
  state.scene = cloneJson(scene);
  return ok(true);
}

function canonicalComparable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalComparable).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareCanonicalKeys(left, right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalComparable(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function applyDiceRolled(state: CampaignState, event: AtomicEvent): Result<true, StateError> {
  const expression = event.payload['expression'];
  if (typeof expression !== 'string') {
    return eventError(event, 'INVALID_EVENT', 'DICE_ROLLED requiere una expresión determinista.');
  }
  const evaluated = new DiceEngine().roll(state.rng, expression);
  if (!evaluated.ok) {
    return eventError(event, 'INVALID_EVENT', `DICE_ROLLED inválido: ${evaluated.error.code}.`);
  }
  if (canonicalComparable(event.payload) !== canonicalComparable(evaluated.value.record)) {
    return eventError(event, 'INVARIANT_VIOLATION', 'DICE_ROLLED no coincide con el RNG, contador o expresión canónicos.');
  }
  state.rng = evaluated.value.next_rng;
  return ok(true);
}

function applyCanonFactAdded(state: CampaignState, event: AtomicEvent): Result<true, StateError> {
  const factId = event.payload['fact_id'];
  if (typeof factId !== 'string' || factId.length === 0 || !('value' in event.payload)) {
    return eventError(event, 'INVALID_EVENT', 'CANON_FACT_ADDED requiere fact_id y value.');
  }
  if (factId in state.canon.facts) {
    return eventError(event, 'INVARIANT_VIOLATION', 'El fact_id ya existe.');
  }
  state.canon.facts[factId] = cloneJson(event.payload['value']);
  return ok(true);
}

function applyQuestUpdated(state: CampaignState, event: AtomicEvent): Result<true, StateError> {
  const questId = event.payload['quest_id'];
  if (typeof questId !== 'string' || !(questId in state.quests)) {
    return eventError(event, 'UNRESOLVED_REFERENCE', 'QUEST_UPDATED requiere una quest existente.');
  }
  if (!isRecord(event.payload['value'])) {
    return eventError(event, 'INVALID_EVENT', 'QUEST_UPDATED requiere un valor objeto.');
  }
  state.quests[questId] = cloneJson(event.payload['value']);
  return ok(true);
}

function inventory(state: CampaignState, event: AtomicEvent, field: string): Result<InventoryRecord, StateError> {
  const inventoryId = event.payload[field];
  if (typeof inventoryId !== 'string' || !state.inventories[inventoryId]) {
    return eventError(event, 'UNRESOLVED_REFERENCE', `El inventario de ${field} no existe.`);
  }
  return ok(state.inventories[inventoryId]);
}

function isInventoryItem(value: unknown): value is InventoryItemRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value['item_instance_id'] === 'string' &&
    typeof value['template_id'] === 'string' &&
    typeof value['name'] === 'string' &&
    Number.isInteger(value['quantity']) &&
    typeof value['owner_id'] === 'string' &&
    typeof value['weight_each'] === 'number' &&
    Array.isArray(value['provenance']) &&
    Array.isArray(value['effects'])
  );
}

function applyItemAcquired(state: CampaignState, event: AtomicEvent): Result<true, StateError> {
  const destination = inventory(state, event, 'inventory_id');
  if (!destination.ok) return destination;
  const item = event.payload['item'];
  if (!isInventoryItem(item) || item.quantity <= 0 || item.owner_id !== destination.value.owner_id) {
    return eventError(event, 'INVALID_EVENT', 'ITEM_ACQUIRED requiere un item completo, positivo y con owner consistente.');
  }
  if (Object.values(state.inventories).some(existing => existing.items.some(candidate => candidate.item_instance_id === item.item_instance_id))) {
    return eventError(event, 'INVARIANT_VIOLATION', 'item_instance_id ya existe.');
  }
  destination.value.items.push(cloneJson(item));
  destination.value.version += 1;
  recalculateInventoryWeight(destination.value);
  return ok(true);
}

function applyItemTransferred(state: CampaignState, event: AtomicEvent): Result<true, StateError> {
  const origin = inventory(state, event, 'from_inventory_id');
  if (!origin.ok) return origin;
  const destination = inventory(state, event, 'to_inventory_id');
  if (!destination.ok) return destination;
  const itemId = event.payload['item_instance_id'];
  const quantity = event.payload['quantity'];
  if (typeof itemId !== 'string' || !Number.isInteger(quantity) || typeof quantity !== 'number' || quantity <= 0) {
    return eventError(event, 'INVALID_EVENT', 'ITEM_TRANSFERRED requiere item_instance_id y quantity positiva.');
  }
  const itemIndex = origin.value.items.findIndex(item => item.item_instance_id === itemId);
  const item = origin.value.items[itemIndex];
  if (!item) return eventError(event, 'UNRESOLVED_REFERENCE', 'El item no existe en el inventario origen.');
  if (quantity > item.quantity) return eventError(event, 'INVARIANT_VIOLATION', 'La transferencia excede la cantidad disponible.');
  if (quantity < item.quantity && typeof event.payload['new_item_instance_id'] !== 'string') {
    return eventError(event, 'INVALID_EVENT', 'Una transferencia parcial requiere new_item_instance_id.');
  }
  const fullTransfer = quantity === item.quantity;
  if (fullTransfer) origin.value.items.splice(itemIndex, 1);
  else item.quantity -= quantity;
  const moved = cloneJson(item);
  moved.item_instance_id = fullTransfer ? moved.item_instance_id : String(event.payload['new_item_instance_id']);
  moved.quantity = quantity;
  moved.owner_id = destination.value.owner_id;
  moved.container_id = null;
  moved.equipped_slot = null;
  destination.value.items.push(moved);
  origin.value.version += 1;
  destination.value.version += 1;
  recalculateInventoryWeight(origin.value);
  recalculateInventoryWeight(destination.value);
  return ok(true);
}

function applyItemConsumed(state: CampaignState, event: AtomicEvent): Result<true, StateError> {
  const source = inventory(state, event, 'inventory_id');
  if (!source.ok) return source;
  const itemId = event.payload['item_instance_id'];
  const quantity = event.payload['quantity'];
  if (typeof itemId !== 'string' || !Number.isInteger(quantity) || typeof quantity !== 'number' || quantity <= 0) {
    return eventError(event, 'INVALID_EVENT', 'ITEM_CONSUMED requiere item_instance_id y quantity positiva.');
  }
  const index = source.value.items.findIndex(item => item.item_instance_id === itemId);
  const item = source.value.items[index];
  if (!item) return eventError(event, 'UNRESOLVED_REFERENCE', 'El item consumido no existe.');
  if (quantity > item.quantity) return eventError(event, 'INVARIANT_VIOLATION', 'El consumo excede la cantidad disponible.');
  if (quantity === item.quantity && item.quest_item && event.payload['authorized_quest_item_removal'] !== true) {
    return eventError(event, 'INVARIANT_VIOLATION', 'Un quest item exige autorización explícita para desaparecer.');
  }
  item.quantity -= quantity;
  if (item.quantity === 0) source.value.items.splice(index, 1);
  source.value.version += 1;
  recalculateInventoryWeight(source.value);
  return ok(true);
}

function applyNpcPromotion(state: CampaignState, event: AtomicEvent): Result<true, StateError> {
  const found = character(state, event);
  if (!found.ok) return found;
  const fullSheet = event.payload['full_sheet'];
  if (found.value.kind !== 'npc' || found.value.detail !== 'lite' || !isRecord(fullSheet) || Object.keys(fullSheet).length === 0) {
    return eventError(event, 'INVALID_EVENT', 'NPC_PROMOTED requiere un NPC lite y una ficha full no vacía.');
  }
  found.value.detail = 'full';
  found.value.sheet = cloneJson(fullSheet);
  return ok(true);
}

function applySubjectRecord(
  state: CampaignState,
  event: AtomicEvent,
  namespace: 'knowledge' | 'beliefs' | 'rumors',
  idField: string
): Result<true, StateError> {
  const subjectId = event.payload['subject_id'];
  const recordId = event.payload[idField];
  if (typeof subjectId !== 'string' || !state.characters[subjectId] || typeof recordId !== 'string' || !('value' in event.payload)) {
    return eventError(event, 'UNRESOLVED_REFERENCE', `${event.event_type} requiere sujeto e ID válidos.`);
  }
  const records = state[namespace][subjectId] ?? {};
  if (event.event_type === 'NPC_KNOWLEDGE_ADDED' && Object.hasOwn(records, recordId)) {
    return eventError(event, 'INVARIANT_VIOLATION', 'El conocimiento existente no se sobrescribe mediante ADDED.');
  }
  const value = event.payload['value'];
  if (isRecord(value) && 'secret_id' in value
    && (typeof value['secret_id'] !== 'string' || !Object.hasOwn(state.canon.secrets, value['secret_id']))) {
    return eventError(event, 'UNRESOLVED_REFERENCE', 'El secreto referenciado no existe en canon.');
  }
  records[recordId] = cloneJson(event.payload['value']);
  state[namespace][subjectId] = records;
  return ok(true);
}

// Explicit reducers for the remaining SOT events; no arbitrary state path or patch execution.
function changeCounter(event: AtomicEvent, record: unknown, field: string, maximum: unknown = Number.MAX_SAFE_INTEGER): Result<true, StateError> {
  const delta = event.payload['delta'];
  if (!isRecord(record) || !Number.isSafeInteger(record[field]) || !Number.isSafeInteger(delta) || delta === 0
    || !Number.isSafeInteger(maximum) || Number(maximum) < 0) return eventError(event, 'INVALID_EVENT', 'Contador o delta inválido.');
  const next = Number(record[field]) + Number(delta);
  if (!Number.isSafeInteger(next) || next < 0 || next > Number(maximum)) return eventError(event, 'INVARIANT_VIOLATION', 'Contador fuera de límites.');
  record[field] = next;
  return ok(true);
}

function applyInventoryResource(state: CampaignState, event: AtomicEvent): Result<true, StateError> {
  const found = inventory(state, event, 'inventory_id');
  if (!found.ok) return found;
  let result: Result<true, StateError>;
  if (event.event_type === 'ITEM_CHARGES_CHANGED') {
    const item = found.value.items.find(value => value.item_instance_id === event.payload['item_instance_id']);
    if (!item || item.charges_current === null || item.charges_max === null) return eventError(event, 'UNRESOLVED_REFERENCE', 'Objeto con cargas no registrado.');
    result = changeCounter(event, item, 'charges_current', item.charges_max);
  } else {
    const currency = event.payload['currency'];
    const delta = event.payload['delta'];
    if (typeof currency !== 'string' || !Object.hasOwn(found.value.currencies, currency)) return eventError(event, 'UNRESOLVED_REFERENCE', 'Moneda no registrada.');
    const current = found.value.currencies[currency];
    if (typeof current !== 'number' || typeof delta !== 'number' || !Number.isFinite(delta) || delta === 0) return eventError(event, 'INVALID_EVENT', 'Moneda o delta inválido.');
    const next = current + delta;
    if (!Number.isFinite(next) || next < 0 || next > Number.MAX_SAFE_INTEGER) return eventError(event, 'INVARIANT_VIOLATION', 'Saldo inválido.');
    found.value.currencies[currency] = next;
    result = ok(true);
  }
  if (result.ok) found.value.version += 1;
  return result;
}

function applyCharacterResource(state: CampaignState, event: AtomicEvent): Result<true, StateError> {
  const found = character(state, event);
  if (!found.ok) return found;
  const sheet = found.value.sheet;
  const p = event.payload;
  switch (event.event_type) {
    case 'NONLETHAL_CHANGED': return changeCounter(event, sheet['health'], 'nonlethal_damage');
    case 'XP_CHANGED': return changeCounter(event, sheet['advancement'], 'xp');
    case 'DAILY_USE_CHANGED': {
      const uses = sheet['daily_uses'];
      const useId = p['use_id'];
      const use = isRecord(uses) && typeof useId === 'string' && Object.hasOwn(uses, useId) ? uses[useId] : undefined;
      if (!isRecord(use)) return eventError(event, 'UNRESOLVED_REFERENCE', 'Uso diario no registrado.');
      return changeCounter(event, use, 'current', use['maximum']);
    }
    case 'CONDITION_ADDED':
    case 'CONDITION_REMOVED': {
      const conditions = sheet['conditions'];
      const value = p['condition'];
      const id = event.event_type === 'CONDITION_ADDED' && isRecord(value) ? value['condition_id'] : p['condition_id'];
      if (!Array.isArray(conditions) || !conditions.every(isRecord) || typeof id !== 'string' || !id) return eventError(event, 'INVALID_EVENT', 'Condición inválida.');
      const index = conditions.findIndex(condition => condition['condition_id'] === id);
      if (event.event_type === 'CONDITION_ADDED') {
        if (!isRecord(value) || typeof value['name'] !== 'string' || !value['name'] || index >= 0) return eventError(event, 'INVALID_EVENT', 'Condición incompleta o duplicada.');
        conditions.push(cloneJson(value));
      } else {
        if (index < 0) return eventError(event, 'UNRESOLVED_REFERENCE', 'Condición no aplicada.');
        conditions.splice(index, 1);
      }
      return ok(true);
    }
    case 'LEVEL_CHANGED': {
      const advancement = sheet['advancement'];
      const name = p['class_name'];
      const delta = p['delta'];
      if (!isRecord(advancement) || !Array.isArray(advancement['classes']) || typeof name !== 'string' || !name
        || (delta !== 1 && delta !== -1)) return eventError(event, 'INVALID_EVENT', 'Nivel requiere clase y cambio unitario.');
      const classes = advancement['classes'];
      if (!classes.every(value => isRecord(value) && typeof value['name'] === 'string' && Number.isSafeInteger(value['level']) && Number(value['level']) > 0)
        || new Set(classes.map(value => (value as MutableRecord)['name'])).size !== classes.length
        || classes.reduce((sum, value: MutableRecord) => sum + Number(value['level']), 0) !== advancement['level']) return eventError(event, 'INVALID_EVENT', 'Progresión de clases incoherente.');
      const index = classes.findIndex((value: MutableRecord) => value['name'] === name);
      if (index < 0 && delta < 0) return eventError(event, 'UNRESOLVED_REFERENCE', 'Clase no registrada.');
      const changed = changeCounter(event, advancement, 'level');
      if (!changed.ok) return changed;
      if (index < 0) classes.push({ name, level: 1, source_ref: event.source_refs[0] });
      else {
        const value = classes[index] as MutableRecord;
        value['level'] = Number(value['level']) + delta;
        if (value['level'] === 0) classes.splice(index, 1);
      }
      return ok(true); // RHD/LA, caster/manifester level and other features are never inferred here.
    }
    case 'RELATIONSHIP_CHANGED': {
      const relationships = sheet['relationships'];
      const targetId = p['target_id'];
      if (!Array.isArray(relationships) || !relationships.every(isRecord) || typeof targetId !== 'string'
        || !Object.hasOwn(state.characters, targetId) || !isRecord(p['value']) || Object.keys(p['value']).length === 0) return eventError(event, 'INVALID_EVENT', 'Relación o personaje inválido.');
      const value = { ...cloneJson(p['value']), target_id: targetId };
      const index = relationships.findIndex(relationship => relationship['target_id'] === targetId);
      if (index < 0) relationships.push(value); else relationships[index] = value;
      return ok(true);
    }
    case 'CHARACTER_DIED': {
      const health = sheet['health'];
      if (!isRecord(health) || !['alive','disabled','dying','stable'].includes(String(health['death_state']))
        || !['dead','destroyed'].includes(String(p['death_state'])) || typeof p['reason'] !== 'string' || !p['reason']) return eventError(event, 'INVALID_EVENT', 'Estado de muerte inválido.');
      health['death_state'] = p['death_state'];
      return ok(true);
    }
    default: return eventError(event, 'UNSUPPORTED_EVENT', 'Recurso desconocido.');
  }
}

function applyFactionClock(state: CampaignState, event: AtomicEvent): Result<true, StateError> {
  const factionId = event.payload['faction_id'];
  const clockId = event.payload['clock_id'];
  const faction = typeof factionId === 'string' && Object.hasOwn(state.factions, factionId) ? state.factions[factionId] : undefined;
  const clocks = isRecord(faction) ? faction['clocks'] : undefined;
  const clock = isRecord(clocks) && typeof clockId === 'string' && Object.hasOwn(clocks, clockId) ? clocks[clockId] : undefined;
  if (!isRecord(clock)) return eventError(event, 'UNRESOLVED_REFERENCE', 'Reloj de facción no registrado.');
  return changeCounter(event, clock, 'current', clock['maximum']);
}

function applyRuling(state: CampaignState, event: AtomicEvent): Result<true, StateError> {
  const p = event.payload;
  const keys = ['ruling_id','question','answer','source_refs','errata_status','scope','campaign_id','created_at','supersedes'];
  if (Object.keys(p).length !== keys.length || !keys.every(key => Object.hasOwn(p, key))
    || !['ruling_id','question','answer','errata_status','scope','campaign_id','created_at'].every(key => typeof p[key] === 'string' && p[key])
    || p['campaign_id'] !== state.campaign_id || !Array.isArray(p['source_refs'])
    || p['source_refs'].length !== event.source_refs.length || new Set(p['source_refs']).size !== p['source_refs'].length
    || !p['source_refs'].every(ref => typeof ref === 'string' && event.source_refs.includes(ref))
    || Number.isNaN(Date.parse(String(p['created_at']))) || Object.hasOwn(state.canon.rulings, String(p['ruling_id']))
    || (p['supersedes'] !== null && (typeof p['supersedes'] !== 'string' || !Object.hasOwn(state.canon.rulings, p['supersedes'])))) return eventError(event, 'INVALID_EVENT', 'Ruling incompleto o sin procedencia.');
  state.canon.rulings[String(p['ruling_id'])] = cloneJson(p);
  return ok(true);
}

function reduce(state: CampaignState, event: AtomicEvent): Result<true, StateError> {
  switch (event.event_type) {
    case 'HP_CHANGED':
      return applyHpChanged(state, event);
    case 'SPELL_SLOT_USED':
    case 'SPELL_SLOT_RESTORED':
      return applySpellSlotUsed(state, event);
    case 'ITEM_CHARGES_CHANGED':
    case 'CURRENCY_CHANGED': return applyInventoryResource(state, event);
    case 'NONLETHAL_CHANGED':
    case 'CONDITION_ADDED':
    case 'CONDITION_REMOVED':
    case 'DAILY_USE_CHANGED':
    case 'XP_CHANGED':
    case 'LEVEL_CHANGED':
    case 'RELATIONSHIP_CHANGED':
    case 'CHARACTER_DIED': return applyCharacterResource(state, event);
    case 'FACTION_CLOCK_CHANGED': return applyFactionClock(state, event);
    case 'RULE_RULING_RECORDED': return applyRuling(state, event);
    case 'TIME_ADVANCED':
      return applyTimeAdvanced(state, event);
    case 'LOCATION_CHANGED':
      return applyLocationChanged(state, event);
    case 'DICE_ROLLED':
      return applyDiceRolled(state, event);
    case 'CANON_FACT_ADDED':
      return applyCanonFactAdded(state, event);
    case 'QUEST_UPDATED':
      return applyQuestUpdated(state, event);
    case 'ITEM_ACQUIRED':
      return applyItemAcquired(state, event);
    case 'ITEM_TRANSFERRED':
      return applyItemTransferred(state, event);
    case 'ITEM_CONSUMED':
      return applyItemConsumed(state, event);
    case 'NPC_PROMOTED':
      return applyNpcPromotion(state, event);
    case 'NPC_KNOWLEDGE_ADDED':
      return applySubjectRecord(state, event, 'knowledge', 'knowledge_id');
    case 'NPC_BELIEF_CHANGED':
      return applySubjectRecord(state, event, 'beliefs', 'belief_id');
    default:
      return eventError(event, 'UNSUPPORTED_EVENT', `No existe reducer para ${event.event_type}.`);
  }
}

export function applyEvent(state: CampaignState, event: AtomicEvent): Result<CampaignState, StateError> {
  const envelope = validateEnvelope(state, event);
  if (!envelope.ok) return envelope;
  const candidate = cloneJson(state);
  const reduced = reduce(candidate, event);
  if (!reduced.ok) return reduced;
  const invariantErrors = validateCampaignInvariants(candidate);
  if (invariantErrors.length > 0) {
    return eventError(event, 'INVARIANT_VIOLATION', invariantErrors.map(error => `${error.path}: ${error.message}`).join('; '));
  }
  candidate.applied_event_ids.push(event.event_id);
  candidate.state_version = event.committed_state_version;
  return ok(candidate);
}

export function replayEvents(state: CampaignState, events: readonly AtomicEvent[]): Result<CampaignState, StateError> {
  let current = cloneJson(state);
  for (const [eventIndex, event] of events.entries()) {
    const applied = applyEvent(current, event);
    if (!applied.ok) return err({ ...applied.error, event_index: eventIndex });
    current = applied.value;
  }
  return ok(current);
}
