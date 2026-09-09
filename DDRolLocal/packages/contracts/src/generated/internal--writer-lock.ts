/* GENERATED FILE - DO NOT EDIT. source=internal/writer-lock.schema.json schema_sha256=3a3b1a6486746f3d7d59270e8045022a3e124a03486a6acea5c6a01df444f9f1 */

export interface WriterLockV1 {
  schema_version: '1.0';
  lock_token: string;
  campaign_id: string;
  branch_id: string;
  owner_runtime: 'typescript' | 'python';
  pid: number;
  checkpoint_id: string;
  state_sha256: string;
  acquired_at: string;
}
