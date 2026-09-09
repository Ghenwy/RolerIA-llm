import { cloneJson } from '../clone.js';
import type { InternalCampaignState, SotInventory } from '@nyx/contracts';

export type DiceState = InternalCampaignState.CampaignStateV1['rng'];
export type CharacterRecord = InternalCampaignState.Character;
export type InventoryRecord = SotInventory.Inventory;
export type InventoryItemRecord = InventoryRecord['items'][number];
export type CanonState = InternalCampaignState.CampaignStateV1['canon'];
export type CampaignState = Omit<InternalCampaignState.CampaignStateV1, 'inventories'> & {
  inventories: Record<string, InventoryRecord>;
};

export interface CreateCampaignStateInput {
  campaign_id: string;
  branch_id: string;
  rng: DiceState;
  characters?: Record<string, CharacterRecord>;
  inventories?: Record<string, InventoryRecord>;
  world?: Record<string, unknown>;
  scene?: Record<string, unknown>;
  quests?: Record<string, unknown>;
  factions?: Record<string, unknown>;
}

export function createCampaignState(input: CreateCampaignStateInput): CampaignState {
  return {
    schema_version: '1.0',
    campaign_id: input.campaign_id,
    branch_id: input.branch_id,
    state_version: 0,
    applied_event_ids: [],
    world: { ...input.world, elapsed_minutes: 0 },
    scene: { ...input.scene },
    quests: { ...input.quests },
    factions: { ...input.factions },
    rng: cloneJson(input.rng),
    characters: cloneJson(input.characters ?? {}),
    inventories: cloneJson(input.inventories ?? {}),
    canon: { facts: {}, secrets: {}, rulings: {} },
    knowledge: {},
    beliefs: {},
    rumors: {}
  };
}
