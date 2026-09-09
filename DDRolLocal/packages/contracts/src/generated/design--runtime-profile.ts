/* GENERATED FILE - DO NOT EDIT. source=design/runtime-profile.schema.json schema_sha256=106a3b2ff91219de49489c852d5226a554335c5714d63bbbf17b1757cbf39228 */

export type RuntimeProfileV1 = {
  schema_version: '1.0';
  profile: '96k' | '112k';
  context_per_slot: 98304 | 114688;
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
};
