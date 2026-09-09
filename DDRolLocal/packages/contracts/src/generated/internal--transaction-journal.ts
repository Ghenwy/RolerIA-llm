/* GENERATED FILE - DO NOT EDIT. source=internal/transaction-journal.schema.json schema_sha256=c1b55283610e6abe4864395a035757d143767c0c52d17791d706c034c8c085ea */

/**
 * This interface was referenced by `TransactionJournalV1`'s JSON-Schema
 * via the `definition` "relative_path".
 */
export type RelativePath = string;
/**
 * This interface was referenced by `TransactionJournalV1`'s JSON-Schema
 * via the `definition` "sha256".
 */
export type Sha256 = string;

export interface TransactionJournalV1 {
  schema_version: '1.0';
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
