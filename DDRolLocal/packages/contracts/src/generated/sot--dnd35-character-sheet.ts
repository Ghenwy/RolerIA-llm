/* GENERATED FILE - DO NOT EDIT. source=sot/dnd35-character-sheet.schema.json schema_sha256=2ceb0ede44982b338a29913b176fdcfe8077fbfeac7cbef570b389b7e2be8c72 */

export interface DND35CharacterSheet {
  schema_version: '1.0';
  character_id: string;
  entity_type: 'player_character' | 'npc_full' | 'npc_lite' | 'creature';
  name: string;
  ruleset: 'dnd35';
  version: number;
  identity: {
    player_name: string | null;
    race: string;
    alignment: string;
    deity: string | null;
    size: string;
    age: number | null;
    gender: string | null;
    languages: string[];
    public_description: string;
  };
  advancement: {
    level: number;
    xp: number;
    classes: {
      name: string;
      level: number;
      source_ref?: string | null;
    }[];
  };
  abilities: {
    str: {
      score: number;
      temporary_score: number | null;
      modifier: number;
    };
    dex: {
      score: number;
      temporary_score: number | null;
      modifier: number;
    };
    con: {
      score: number;
      temporary_score: number | null;
      modifier: number;
    };
    int: {
      score: number;
      temporary_score: number | null;
      modifier: number;
    };
    wis: {
      score: number;
      temporary_score: number | null;
      modifier: number;
    };
    cha: {
      score: number;
      temporary_score: number | null;
      modifier: number;
    };
  };
  health: {
    hp_max: number;
    hp_current: number;
    temporary_hp: number;
    nonlethal_damage: number;
    hit_dice: string[];
    death_state: 'alive' | 'disabled' | 'dying' | 'stable' | 'dead' | 'destroyed';
  };
  defense: {
    ac: number;
    touch_ac: number;
    flat_footed_ac: number;
    [k: string]: any;
  };
  combat: {
    initiative: number;
    base_attack_bonus: number;
    grapple: number;
    speed: {
      [k: string]: any;
    };
    attacks: {
      [k: string]: any;
    }[];
    [k: string]: any;
  };
  saves: {
    fortitude: number;
    reflex: number;
    will: number;
  };
  skills: {
    [k: string]: any;
  }[];
  features: {
    feats: {
      [k: string]: any;
    }[];
    class_features: {
      [k: string]: any;
    }[];
    racial_traits: {
      [k: string]: any;
    }[];
    special_abilities: {
      [k: string]: any;
    }[];
  };
  magic: {
    caster_profiles: {
      [k: string]: any;
    }[];
    active_effects: {
      [k: string]: any;
    }[];
    [k: string]: any;
  };
  conditions: {
    [k: string]: any;
  }[];
  inventory_ref: string;
  location_id: string;
  knowledge: {
    [k: string]: any;
  }[];
  beliefs: {
    [k: string]: any;
  }[];
  secrets: {
    [k: string]: any;
  }[];
  relationships: {
    [k: string]: any;
  }[];
  status: {
    active: boolean;
    present_in_scene: boolean;
    last_seen_at: string | null;
  };
}
