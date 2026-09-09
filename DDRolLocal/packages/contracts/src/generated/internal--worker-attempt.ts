/* GENERATED FILE - DO NOT EDIT. source=internal/worker-attempt.schema.json schema_sha256=200a0ad54a1da51058973719933de37add4bb5d4675d38118d763a338e53fe83 */

export interface WorkerAttemptV1 {
  schema_version: '1.0';
  attempt_id: string;
  campaign_id: string;
  turn_id: string;
  job_id: string;
  ordinal: number;
  status: 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'BLOCKED' | 'FAILED' | 'STALE' | 'CANCELLED';
  reason_code: string;
  retry_authorized: boolean;
}
