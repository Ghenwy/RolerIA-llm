/* GENERATED FILE - DO NOT EDIT. source=sot/rpgworker-result.schema.json schema_sha256=9813563934457426e0619efcb4d5eed2290692b99fee3a7614efbb3f8b3f7e69 */

export interface RPGWorkerResult {
  schema_version: '1.0';
  job_id: string;
  turn_id: string;
  worker_id: string;
  base_state_version: number;
  status: 'completed' | 'partial' | 'blocked' | 'failed' | 'stale';
  summary: string;
  findings: {
    claim: string;
    evidence: string[];
    certainty: 'certain' | 'high' | 'medium' | 'low';
  }[];
  proposed_events: {
    [k: string]: any;
  }[];
  proposed_patches: {
    [k: string]: any;
  }[];
  narrative_material: {
    [k: string]: any;
  };
  memory_candidates: {
    [k: string]: any;
  }[];
  unresolved: string[];
  confidence: number;
  dod: {
    passed: boolean;
    missing: string[];
  };
}
