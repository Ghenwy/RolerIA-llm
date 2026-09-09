/* GENERATED FILE - DO NOT EDIT. source=internal/memory-record.schema.json schema_sha256=d34c150576b4157c86f42769dd9d30e484e0642c494cfb55741cc09e1bc0e27d */

export type MemoryRecordV1 = {
  schema_version: '1.0';
  memory_id: string;
  campaign_id: string;
  branch_id: string;
  retention_class: 'EXACT' | 'DURABLE' | 'EPISODIC' | 'EVICTABLE';
  content: {
    [k: string]: any;
  };
  /**
   * @minItems 1
   */
  source_refs: [string, ...string[]];
  created_state_version: number;
  updated_state_version: number;
  exact_payload_sha256: string | null;
};
