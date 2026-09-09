/* GENERATED FILE - DO NOT EDIT. source=internal/transcript-entry.schema.json schema_sha256=984daf04c073106d02d6584d513b4c2d5cfae48451b9642c06915814a6a45c9f */

export interface TranscriptEntryV1 {
  schema_version: '1.0';
  transcript_id: string;
  campaign_id: string;
  branch_id: string;
  turn_id: string;
  speaker: 'player' | 'gm' | 'system';
  content: string;
  occurred_at: string;
  /**
   * @minItems 1
   */
  source_refs: [string, ...string[]];
}
