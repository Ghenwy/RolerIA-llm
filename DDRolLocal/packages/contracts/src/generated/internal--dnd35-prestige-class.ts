/* GENERATED FILE - DO NOT EDIT. source=internal/dnd35-prestige-class.schema.json schema_sha256=436f2c0811b3937db54a68419e6f851b4d61a98d63dcdb7214ddca132c8c089f */

/**
 * This interface was referenced by `Dnd35PrestigeClassV1`'s JSON-Schema
 * via the `definition` "stringArray".
 */
export type StringArray = string[];
/**
 * This interface was referenced by `Dnd35PrestigeClassV1`'s JSON-Schema
 * via the `definition` "levelArray".
 */
export type LevelArray = number[];
/**
 * This interface was referenced by `Dnd35PrestigeClassV1`'s JSON-Schema
 * via the `definition` "scalarArray".
 */
export type ScalarArray = (string | number | boolean)[];

export interface Dnd35PrestigeClassV1 {
  id: string;
  name_es: string;
  source_family: 'core_srd' | 'psionic_srd';
  levels: number;
  hit_die: 'd4' | 'd6' | 'd8' | 'd10' | 'd12';
  bab: 'half' | 'three_quarters' | 'full';
  good_saves: ('fortitude' | 'reflex' | 'will')[];
  requirements: {
    alignment?: string;
    bab_min?: number;
    feats_all?: StringArray;
    feats_pattern?: StringArray;
    languages_all?: StringArray;
    proficiencies?: StringArray;
    psionics?: StringArray;
    race_exclusions?: StringArray;
    race_tags_all?: StringArray;
    race_tags_any?: StringArray;
    skills?: {
      [k: string]: number;
    };
    skills_pattern?: StringArray;
    special?: StringArray;
    spellcasting?: StringArray;
  };
  progression: {
    arcane_spellcasting_levels?: LevelArray;
    bonus_spell_effect?: string;
    bonus_spells_by_level?: NumberByLevel;
    caster_level?: string;
    divine_spellcasting_levels?: LevelArray;
    manifesting_levels?: LevelArray;
    own_manifesting?: string;
    own_spellcasting?: string;
    power_points_by_class_table?: boolean;
    prior_spellcasting?: ScalarArray;
    spellcasting?: ScalarArray;
    spellcasting_levels?: LevelArray;
    spells_per_day?: ScalarArray;
  };
  milestones: {
    [k: string]: StringArray;
  };
  notes: StringArray;
  source_url: string;
}
/**
 * This interface was referenced by `Dnd35PrestigeClassV1`'s JSON-Schema
 * via the `definition` "numberByLevel".
 */
export interface NumberByLevel {
  [k: string]: number;
}
