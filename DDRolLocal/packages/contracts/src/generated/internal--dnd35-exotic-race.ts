/* GENERATED FILE - DO NOT EDIT. source=internal/dnd35-exotic-race.schema.json schema_sha256=44cccb8fb42967215057691ed0550fa691b09a2f0d6de6df52566c09c71fc8c0 */

export interface Dnd35ExoticRaceV1 {
  id: string;
  name_es: string;
  source_family: 'core_srd' | 'psionic_srd';
  type: string;
  size: 'small' | 'medium' | 'large';
  speed_ft: number;
  ability_mods: {
    str?: number;
    dex?: number;
    con?: number;
    int?: number;
    wis?: number;
    cha?: number;
  };
  racial_hd: number;
  racial_hd_package?: {
    die: 'd4' | 'd6' | 'd8' | 'd10' | 'd12';
    bab: number;
    saves: {
      fort: number;
      ref: number;
      will: number;
    };
    feats: number;
  };
  level_adjustment: number;
  minimum_starting_ecl: number;
  traits: string[];
  favored_class: string;
  languages: {
    automatic: string[];
    bonus: string[];
  };
  variants?: {
    id: string;
    level_adjustment: number;
    minimum_starting_ecl: number;
  }[];
  source_url: string;
}
