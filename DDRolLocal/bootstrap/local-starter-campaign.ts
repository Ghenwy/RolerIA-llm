// [DESIGN] Local starter shared by beta preparation and the C9 acceptance campaign.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { validateRuntimeContract } from '@nyx/contracts';
import { JsonDnd35AdapterEventStore } from '@nyx/dnd35';
import { createCampaignState, type CampaignState } from '@nyx/domain';
import { JsonCampaignStore, canonicalJson, replaceDurable, writeDurable } from '@nyx/persistence-json';
import difficultTerrain from '../rulesets/dnd35_srd_ogc/local-beta/difficult-terrain.json' with { type: 'json' };

export const C9_SPANISH_BRANCH_ID = 'BRANCH-c9-spanish';
export const C9_SPANISH_CHARACTER_IDS = {
  player: 'PC-c9-viajero',
  vera: 'NPC-c9-vera',
  dario: 'NPC-c9-dario',
  ines: 'NPC-c9-ines'
} as const;

export function createC9SpanishCampaignState(campaignId: string): CampaignState {
  const ids = C9_SPANISH_CHARACTER_IDS;
  const state = createCampaignState({
    campaign_id: campaignId,
    branch_id: C9_SPANISH_BRANCH_ID,
    rng: {
      algorithm: 'sha256-seeded-python-random',
      campaign_seed: 'c9-spanish-fixed-seed',
      roll_index: 0
    },
    characters: {
      [ids.player]: {
        character_id: ids.player,
        kind: 'player',
        detail: 'full',
        sheet: { name: 'Viajero', location_id: 'LOCATION-c9-inn', hit_points: { current: 12, maximum: 12 },
          training_attack_bonus: 4, training_damage: '1d4', training_target_ac: 10,
          training_critical_threshold: 20, training_critical_multiplier: 2 }
      },
      [ids.vera]: {
        character_id: ids.vera,
        kind: 'npc',
        detail: 'lite',
        sheet: { name: 'Vera', role: 'archivera', voice: 'serena y precisa' }
      },
      [ids.dario]: {
        character_id: ids.dario,
        kind: 'npc',
        detail: 'lite',
        sheet: { name: 'Darío', role: 'escéptico', voice: 'seca y desconfiada' }
      },
      [ids.ines]: {
        character_id: ids.ines,
        kind: 'npc',
        detail: 'lite',
        sheet: { name: 'Inés', role: 'guardia', voice: 'militar y concisa' }
      }
    },
    inventories: {
      'INV-c9-party': {
        schema_version: '1.0',
        inventory_id: 'INV-c9-party',
        owner_type: 'party',
        owner_id: 'PARTY-c9',
        version: 1,
        currencies: {},
        containers: [],
        items: [{
          item_instance_id: 'ITEM-c9-silver-key',
          template_id: 'TEMPLATE-silver-key',
          name: 'Llave de plata',
          quantity: 1,
          owner_id: 'PARTY-c9',
          container_id: null,
          equipped_slot: null,
          weight_each: 0.1,
          identified: true,
          charges_current: null,
          charges_max: null,
          condition: 'intact',
          quest_item: true,
          provenance: ['fixture:c9-spanish'],
          effects: [],
          source_ref: 'estrcuttura/05-nyx-despliegue-operacion-validacion.md:395-419'
        }],
        carrying: {
          total_weight: 0.1,
          light_limit: null,
          medium_limit: null,
          heavy_limit: null,
          load_state: 'not_applicable'
        }
      }
    },
    world: { location_id: 'LOCATION-c9-inn', elapsed_minutes: 0,
      locations: { 'LOCATION-c9-inn': 'Posada del pozo', 'LOCATION-c9-bridge': 'Puente viejo' },
      mechanical_targets: { 'OBJECT-training-dummy': { name: 'Maniquí de entrenamiento', critical_immune: true } },
      mechanical_actions: { 'training-attack': {
        schema_version: '1.0', action_id: 'training-attack', kind: 'ATTACK', actor_id: ids.player,
        target_id: 'OBJECT-training-dummy', effect: 'CALCULATE_DAMAGE_ONLY',
        parameter_refs: {
          attack_bonus: ['characters', ids.player, 'sheet', 'training_attack_bonus'],
          armor_class: ['characters', ids.player, 'sheet', 'training_target_ac'],
          damage_expression: ['characters', ids.player, 'sheet', 'training_damage'],
          critical_threshold: ['characters', ids.player, 'sheet', 'training_critical_threshold'],
          critical_multiplier: ['characters', ids.player, 'sheet', 'training_critical_multiplier'],
          critical_immune: ['world', 'mechanical_targets', 'OBJECT-training-dummy', 'critical_immune']
        },
        source_refs: ['design:starter-training-object-v1', 'estrcuttura/06-dnd35-gobernanza-reglas-base.md:235-247']
      } } },
    scene: {
      location_id: 'LOCATION-c9-inn',
      summary: 'El viajero conversa en una posada segura con Vera, Darío e Inés.',
      present_character_ids: [ids.player, ids.vera, ids.dario, ids.ines],
      immediate_threats: [],
      open_questions: ['Qué abre la llave de plata', 'Qué significa la pista del pozo']
    },
    quests: {
      'QUEST-c9-key': { status: 'ACTIVE', stage: 'investigate', promised_return: false }
    }
  });
  state.canon.facts['FACT-c9-key'] = { text: 'El grupo posee una única llave de plata.' };
  state.canon.facts['FACT-c9-well'] = { text: 'Hay una pista no resuelta relacionada con un pozo.' };
  state.canon.facts['FACT-c9-training'] = {
    text: 'Inés ha preparado en la posada un maniquí físico de entrenamiento: CA 10, ataque del viajero 1d20+4, daño 1d4. Se usa una acción estándar real y Dice Engine; no se daña a ningún personaje.'
  };
  state.canon.facts['FACT-c9-travel'] = {
    text: 'Vera, Darío e Inés han acordado acompañar al viajero al puente por el camino seguro; cada trayecto tarda exactamente diez minutos. No hay enemigos ni costes de inventario en ese camino.'
  };
  state.canon.secrets['SECRET-c9-vera'] = {
    value: { text: 'Vera conoce una marca falsa en el sello.' },
    authorized_subject_ids: [ids.player, ids.vera]
  };
  state.knowledge[ids.vera] = {
    'KNOWLEDGE-c9-seal': { text: 'La marca del sello es falsa.', secret_id: 'SECRET-c9-vera' }
  };
  state.beliefs[ids.dario] = {
    'BELIEF-c9-key': { text: 'La llave no abre nada importante.', truth_status: 'unknown' }
  };
  return state;
}

/** Fresh Alpha scenario only. The historical C9 fixture and existing campaigns are never migrated. */
export function createAssistedAlphaCampaignState(campaignId: string): CampaignState {
  const state = createC9SpanishCampaignState(campaignId);
  const ids = C9_SPANISH_CHARACTER_IDS;
  const party = Object.values(ids);
  const health = (hp: number) => ({ hp_max: hp, hp_current: hp, temporary_hp: 0,
    nonlethal_damage: 0, hit_dice: ['1d8'], death_state: 'alive' });
  for (const character of Object.values(state.characters)) {
    // This object has just been created, not loaded from history.
    delete character.sheet['hit_points'];
    character.sheet['health'] = health(12);
    character.sheet['location_id'] = 'LOCATION-c9-inn';
  }
  const rival = 'NPC-alpha-rival';
  state.characters[rival] = { character_id: rival, kind: 'npc', detail: 'lite', sheet: {
    name: 'Armand', role: 'duelista', voice: 'directa y respetuosa', location_id: 'LOCATION-c9-bridge', health: health(24)
  } };
  state.canon.facts['FACT-alpha-rival'] = { text: 'Armand espera junto al puente. Ha aceptado un duelo de arma con el viajero y el primer ataque del viajero. Este duelo puede causar heridas reales; sus respuestas tácticas no están automatizadas. Se detiene si alguien ya no puede continuar.' };
  const sourceRefs = ['design:alpha-starter-registered-travel-v1', 'estrcuttura/01-nyx-fundamentos-arquitectura.md:250'];
  state.world['travel_routes'] = {
    'inn-to-bridge': { schema_version: '1.0', route_id: 'inn-to-bridge', actor_id: ids.player,
      from_location_id: 'LOCATION-c9-inn', to_location_id: 'LOCATION-c9-bridge', character_ids: party,
      duration_minutes: 10, source_refs: sourceRefs, destination_scene: {
        location_id: 'LOCATION-c9-bridge', summary: 'El grupo llega al puente, donde espera Armand.',
        present_character_ids: [...party, rival], immediate_threats: [], open_questions: ['Qué abre la llave de plata']
      } },
    'bridge-to-inn': { schema_version: '1.0', route_id: 'bridge-to-inn', actor_id: ids.player,
      from_location_id: 'LOCATION-c9-bridge', to_location_id: 'LOCATION-c9-inn', character_ids: party,
      duration_minutes: 10, source_refs: sourceRefs, destination_scene: {
        location_id: 'LOCATION-c9-inn', summary: 'El viajero, Vera, Darío e Inés regresan a la posada.',
        present_character_ids: party, immediate_threats: [], open_questions: ['Qué abre la llave de plata', 'Qué significa la pista del pozo']
      } }
  };
  const targets = state.world['mechanical_targets'] as Record<string, unknown>;
  targets[rival] = { character_id: rival };
  const actions = state.world['mechanical_actions'] as Record<string, unknown>;
  actions['rival-attack'] = { schema_version: '1.1', action_id: 'rival-attack', kind: 'ATTACK',
    actor_id: ids.player, target_id: rival, effect: 'APPLY_WEAPON_DAMAGE', unsupported_effects: [],
    parameter_refs: {
      attack_bonus: ['characters', ids.player, 'sheet', 'training_attack_bonus'],
      armor_class: ['characters', ids.player, 'sheet', 'training_target_ac'],
      damage_expression: ['characters', ids.player, 'sheet', 'training_damage'],
      critical_threshold: ['characters', ids.player, 'sheet', 'training_critical_threshold'],
      critical_multiplier: ['characters', ids.player, 'sheet', 'training_critical_multiplier'],
      critical_immune: ['world', 'alpha_weapon_critical_immune']
    },
    source_refs: ['design:alpha-starter-normal-weapon-v1', 'estrcuttura/06-dnd35-gobernanza-reglas-base.md:235-247',
      'estrcuttura/06-dnd35-gobernanza-reglas-base.md:433-466']
  };
  state.world['alpha_weapon_critical_immune'] = false;
  return state;
}

export async function installC9SpanishCampaignFixture(campaignRoot: string, campaignId: string): Promise<CampaignState> {
  // This is the open source pinned by the SOT, not synthetic fixture text or model knowledge.
  // Its campaign copy is private and immutable; no HTTP is required when preparing or playing.
  if (createHash('sha256').update(difficultTerrain.content).digest('hex') !== difficultTerrain.excerpt_sha256) {
    throw new Error('STARTER_SOURCE_HASH_MISMATCH');
  }
  const sourceRecord = {
    schema_version: '1.0', source_id: difficultTerrain.source_id, source_kind: 'SRD_OGC',
    title: difficultTerrain.title, edition: difficultTerrain.edition, version_or_date: difficultTerrain.upstream_commit,
    ownership_assertion: null, local_excerpt_ref: 'rules/srd35-difficult-terrain.md',
    allowed_scope: [difficultTerrain.scope], content_sha256: difficultTerrain.excerpt_sha256,
    public_distribution_allowed: false, enabled: true
  };
  if (!validateRuntimeContract('RuleSourceRecord', sourceRecord).ok) throw new Error('STARTER_SOURCE_INVALID');
  const manifestFile = resolve(campaignRoot, 'campaign.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
  if (!validateRuntimeContract('CampaignManifest', manifest).ok) throw new Error('STARTER_MANIFEST_INVALID');
  const state = ['1.1', '1.2'].includes(String(manifest['schema_version'])) && manifest['turn_profile'] === 'ASSISTED_ALPHA'
    ? createAssistedAlphaCampaignState(campaignId) : createC9SpanishCampaignState(campaignId);
  const initialized = await new JsonCampaignStore(campaignRoot).initialize(state);
  if (!initialized.ok) throw new Error(`No se pudo inicializar la rama C9: ${initialized.error.code}`);
  manifest['active_branch_id'] = C9_SPANISH_BRANCH_ID;
  manifest['state_version'] = 0;
  await replaceDurable(`${manifestFile}.tmp`, manifestFile, canonicalJson(manifest));
  // Exclusive creation: an interrupted/previous installation remains evidence, never overwritten.
  await writeDurable(resolve(campaignRoot, sourceRecord.local_excerpt_ref), difficultTerrain.content);
  const registered = await new JsonDnd35AdapterEventStore(campaignRoot).appendBatch(C9_SPANISH_BRANCH_ID, [{
    schema_version: '1.0', event_id: 'DND35-EVENT-starter-difficult-terrain', event_type: 'RULE_SOURCE_REGISTERED',
    campaign_id: campaignId, branch_id: C9_SPANISH_BRANCH_ID, base_adapter_version: 0, committed_adapter_version: 1,
    actor_id: 'operator:beta-preparation', occurred_at: new Date().toISOString(),
    payload: { record_id: sourceRecord.source_id, source_record: sourceRecord, source_url: difficultTerrain.source_url,
      legal_url: difficultTerrain.legal_url, upstream_git_blob: difficultTerrain.upstream_git_blob,
      upstream_file_sha256: difficultTerrain.upstream_file_sha256, extraction: difficultTerrain.extraction,
      authority_ref: difficultTerrain.authority_ref },
    source_refs: [sourceRecord.source_id]
  }]);
  if (!registered.ok) throw new Error(`STARTER_SOURCE_REGISTRATION_FAILED:${registered.error.code}`);
  return state;
}
