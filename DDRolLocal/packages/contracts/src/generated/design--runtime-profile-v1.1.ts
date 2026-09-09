/* GENERATED FILE - DO NOT EDIT. source=design/runtime-profile-v1.1.schema.json schema_sha256=d1a239693d935e9735bc33253c6995df67218222b134aae568491f3cbefe2632 */

/**
 * [DESIGN] Add the explicitly selected 64K profile and pinned local runtime; 1.0 profiles remain valid without rewriting.
 */
export type RuntimeProfileV11 = {
  schema_version: '1.1';
  profile: '64k' | '96k' | '112k';
  context_per_slot: 65536 | 98304 | 114688;
  parallel: 3;
  cache_type_k: 'Q5_1';
  cache_type_v: 'Q5_1';
  batch: number;
  ubatch: number;
  fit: true;
  fit_target_mib: number;
  host: '127.0.0.1';
  port: number;
  overrides: {
    key: string;
    value: any;
    reason: string;
  }[];
  runtime?: {
    source_revision: string;
    executable: string;
    sha256: string;
    artifacts: {
      [k: string]: string;
    };
    environment: {
      GGML_CUDA_NO_PINNED: '1';
    };
  };
};
