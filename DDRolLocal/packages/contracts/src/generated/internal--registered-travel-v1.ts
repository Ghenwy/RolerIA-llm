/* GENERATED FILE - DO NOT EDIT. source=internal/registered-travel-v1.schema.json schema_sha256=4d334ca959748e3010c905ff9f136fa654c3c717045cc5e68317546b789a4b8a */

/**
 * This interface was referenced by `RegisteredTravelV1`'s JSON-Schema
 * via the `definition` "id".
 */
export type Id = string;

/**
 * [DESIGN] AMD-005: explicit operator-registered travel, not an LLM proposal. No encounter, inventory or tactical effects in this profile.
 */
export interface RegisteredTravelV1 {
  schema_version: '1.0';
  route_id: Id;
  actor_id: Id;
  from_location_id: Id;
  to_location_id: Id;
  /**
   * @minItems 1
   */
  character_ids: [Id, ...Id[]];
  duration_minutes: number;
  /**
   * @minItems 1
   */
  source_refs: [string, ...string[]];
  destination_scene: {
    location_id: Id;
    summary: string;
    /**
     * @minItems 1
     */
    present_character_ids: [Id, ...Id[]];
    /**
     * @maxItems 0
     */
    immediate_threats: [];
    open_questions: string[];
  };
}
