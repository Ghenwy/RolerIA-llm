/* GENERATED FILE - DO NOT EDIT. source=internal/campaign-state.schema.json schema_sha256=b187466f2634d1104a51612aefe8ef8c2a5c78bc28f58b77445426129af9622d */

export interface CampaignStateV1 {
  schema_version: '1.0';
  campaign_id: string;
  branch_id: string;
  state_version: number;
  applied_event_ids: string[];
  world: {
    elapsed_minutes: number;
    [k: string]: any;
  };
  scene: {
    [k: string]: any;
  };
  quests: {
    [k: string]: any;
  };
  factions: {
    [k: string]: any;
  };
  rng: {
    algorithm: 'sha256-seeded-python-random';
    campaign_seed: string;
    roll_index: number;
  };
  characters: {
    [k: string]: Character;
  };
  inventories: {
    [k: string]: {
      [k: string]: any;
    };
  };
  canon: {
    facts: {
      [k: string]: any;
    };
    secrets: {
      [k: string]: Secret;
    };
    rulings: {
      [k: string]: any;
    };
  };
  knowledge: {
    [k: string]: {
      [k: string]: any;
    };
  };
  beliefs: {
    [k: string]: {
      [k: string]: any;
    };
  };
  rumors: {
    [k: string]: {
      [k: string]: any;
    };
  };
}
/**
 * This interface was referenced by `CampaignStateV1`'s JSON-Schema
 * via the `definition` "character".
 */
export interface Character {
  character_id: string;
  kind: 'player' | 'npc';
  detail: 'full' | 'lite';
  sheet: {
    [k: string]: any;
  };
}
/**
 * This interface was referenced by `CampaignStateV1`'s JSON-Schema
 * via the `definition` "secret".
 */
export interface Secret {
  value: any;
  authorized_subject_ids: string[];
}
