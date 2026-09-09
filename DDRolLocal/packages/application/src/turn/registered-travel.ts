import { validateRuntimeContract, type InternalRegisteredTravelV1 } from '@nyx/contracts';
import { healthStateForHitPoints } from '@nyx/domain';
import { parseGuidedTurnIntent } from './guided-intent.js';
import type { RunTurnInput, TurnPortResult } from './turn-orchestrator.js';

export type RegisteredTravel = InternalRegisteredTravelV1.RegisteredTravelV1;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const fail = (code: string): TurnPortResult<never> => ({ ok: false,
  error: { code, message: code === 'TRAVEL_HEALTH_UNSUPPORTED'
    ? 'Viaje bloqueado: todos los viajeros requieren salud canónica válida y estado activo. El transporte asistido o de participantes incapacitados no está implementado.'
    : `Viaje bloqueado: ${code}. Selecciona una ruta registrada desde la ubicación actual.` } });

function supportedTravelHealth(sheet: Record<string, unknown>): boolean {
  const health = sheet['health'];
  if (Object.hasOwn(sheet, 'hit_points') || !record(health) || !validateRuntimeContract('Dnd35Health', health).ok) return false;
  const hp = health['hp_current'], maximum = health['hp_max'];
  return typeof hp === 'number' && typeof maximum === 'number' && Number.isSafeInteger(maximum)
    && maximum > 0 && hp <= maximum && healthStateForHitPoints(hp) === 'alive'
    && health['death_state'] === 'alive' && health['nonlethal_damage'] === 0;
}

/** A registered route is explicit consent/data, never an inference from prose or an LLM response. */
export function prepareRegisteredTravel(state: unknown, input: Pick<RunTurnInput,
  'campaignId' | 'baseStateVersion' | 'playerInput'>): TurnPortResult<RegisteredTravel | null> {
  if (!input.playerInput.trim().startsWith('/travel')) return { ok: true, value: null };
  const intent = parseGuidedTurnIntent(input.playerInput);
  if (!intent.ok) return intent;
  if (intent.value.kind !== 'travel') return { ok: true, value: null };
  if (!record(state) || state['campaign_id'] !== input.campaignId || state['state_version'] !== input.baseStateVersion
    || !record(state['world']) || !record(state['scene']) || !record(state['characters'])) return fail('TRAVEL_STATE_STALE');
  const { world, scene, characters } = state;
  const routes = world['travel_routes'];
  const locations = world['locations'];
  const raw = record(routes) && Object.hasOwn(routes, intent.value.route_id) ? routes[intent.value.route_id] : undefined;
  if (!validateRuntimeContract('RegisteredTravel', raw).ok) return fail('TRAVEL_ROUTE_UNREGISTERED');
  const route = structuredClone(raw) as RegisteredTravel;
  if (route.route_id !== intent.value.route_id || route.from_location_id === route.to_location_id
    || world['location_id'] !== route.from_location_id || scene['location_id'] !== route.from_location_id
    || !record(locations) || !Object.hasOwn(locations, route.from_location_id) || !Object.hasOwn(locations, route.to_location_id)
    || route.destination_scene.location_id !== route.to_location_id) return fail('TRAVEL_LOCATION_UNCONFIRMED');
  const actor = characters[route.actor_id];
  const present = scene['present_character_ids'];
  if (!record(actor) || actor['kind'] !== 'player' || !route.character_ids.includes(route.actor_id)
    || !Array.isArray(present) || route.character_ids.some(id => !present.includes(id)
      || !Object.hasOwn(characters, id) || !record(characters[id]) || !record(characters[id]['sheet'])
      || characters[id]['sheet']['location_id'] !== route.from_location_id)
    || route.character_ids.some(id => !route.destination_scene.present_character_ids.includes(id))
    || route.destination_scene.present_character_ids.some(id => !route.character_ids.includes(id)
      && (!Object.hasOwn(characters, id) || !record(characters[id]) || !record(characters[id]['sheet'])
        || characters[id]['sheet']['location_id'] !== route.to_location_id))) return fail('TRAVEL_PARTICIPANTS_UNCONFIRMED');
  // Registered travel is an Alpha capability, not a migration of health-less historical campaigns.
  // Destination residents are not transported. Incapacitated companions need a separate, explicit capability.
  if (route.character_ids.some(id => !supportedTravelHealth((characters[id] as Record<string, unknown>)['sheet'] as Record<string, unknown>))) {
    return fail('TRAVEL_HEALTH_UNSUPPORTED');
  }
  if (!Number.isSafeInteger(world['elapsed_minutes']) || typeof world['elapsed_minutes'] !== 'number'
    || !Number.isSafeInteger(world['elapsed_minutes'] + route.duration_minutes)) return fail('TRAVEL_TIME_INVALID');
  return { ok: true, value: route };
}

export function registeredTravelReceipt(route: RegisteredTravel): string {
  return `Viaje ${route.route_id}: de ${route.from_location_id} a ${route.to_location_id}. `
    + `Transcurren ${route.duration_minutes} minutos. ${route.destination_scene.summary}`;
}
