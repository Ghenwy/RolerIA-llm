/* GENERATED FILE - DO NOT EDIT. source=internal/worker-queue-batch.schema.json schema_sha256=27b562f74c9b6ad1174076ea6071f5fa0d90f3b63f053ae2cc0e9b8551f01670 */

export interface WorkerQueueBatchV1 {
  schema_version: '1.0';
  batch_id: string;
  campaign_id: string;
  turn_id: string;
  base_state_version: number;
  /**
   * @minItems 1
   */
  job_ids: [string, ...string[]];
  status: 'PREPARED' | 'COMMITTED';
}
