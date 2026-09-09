/* GENERATED FILE - DO NOT EDIT. source=internal/health-change-v1.schema.json schema_sha256=1ed27975b4a33863996bbd3935ceffd0b061a78abfa556b5564fe390cf49eee2 */

/**
 * [DESIGN DEC-081] Explicit HP_CHANGED payload for canonical D&D health. Built by code from confirmed weapon damage; legacy delta/hit_points payloads are never reinterpreted.
 */
export interface HealthChangeV1 {
  schema_version: '1.0';
  kind: 'WEAPON_DAMAGE';
  character_id: string;
  delta: number;
  before_hp: number;
  after_hp: number;
  before_death_state: 'alive' | 'disabled' | 'dying';
  after_death_state: 'alive' | 'disabled' | 'dying' | 'dead';
}
