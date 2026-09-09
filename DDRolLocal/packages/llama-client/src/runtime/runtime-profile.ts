import type { RuntimeProfile, RuntimeProfileName } from '@nyx/contracts';

export interface RuntimeProfilesFile {
  schema_version: '1.0' | '1.1';
  production_profile: RuntimeProfileName;
  experimental_profiles: readonly RuntimeProfileName[];
  model: {
    repository: string;
    revision: string;
    file: string;
    /** Single directory under models; omission preserves legacy Nyx installations. */
    directory?: string;
    alias: string;
    sha256: string;
  };
  profiles: readonly RuntimeProfile[];
}

export function buildLlamaServerArgs(
  profile: RuntimeProfile,
  modelPath: string,
  alias: string
): string[] {
  return [
    '-m', modelPath,
    '--alias', alias,
    '--parallel', String(profile.parallel),
    '--cont-batching',
    '--kv-unified',
    '--kv-unified-per-slot', String(profile.context_per_slot),
    '--cache-type-k', profile.cache_type_k.toLowerCase(),
    '--cache-type-v', profile.cache_type_v.toLowerCase(),
    '--flash-attn', 'on',
    '--batch-size', String(profile.batch),
    '--ubatch-size', String(profile.ubatch),
    '--fit', profile.fit ? 'on' : 'off',
    '--fit-target', String(profile.fit_target_mib),
    '--load-mode', 'mmap',
    '--jinja',
    '--cors-origins', 'localhost',
    '--no-webui',
    '--host', profile.host,
    '--port', String(profile.port)
  ];
}
