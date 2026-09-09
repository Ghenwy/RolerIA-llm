/* GENERATED FILE - DO NOT EDIT. source=internal/transaction-journal-v1.1.schema.json schema_sha256=1f57bef43d67fbe06242857c35d61de1d22da8cac3132f5bf95663e936cf19c3 */

/**
 * This interface was referenced by `TransactionJournalV11`'s JSON-Schema
 * via the `definition` "relative_path".
 */
export type RelativePath = string;
/**
 * This interface was referenced by `TransactionJournalV11`'s JSON-Schema
 * via the `definition` "sha256".
 */
export type Sha256 = string;

export interface TransactionJournalV11 {
  schema_version: '1.1';
  transaction_id: string;
  campaign_id: string;
  branch_id: string;
  base_state_version: number;
  target_state_version: number;
  stage: 'PREPARED' | 'STATE_RENAMED' | 'EVENTS_APPENDED' | 'COMMITTED';
  state_temp_path: RelativePath;
  state_final_path: RelativePath;
  state_sha256: Sha256;
  /**
   * @minItems 1
   */
  event_ids: [string, ...string[]];
  event_batch_sha256: Sha256;
  created_at: string;
  updated_at: string;
}
