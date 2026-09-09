import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateRuntimeContract,
  type InternalDnd35ExoticRace,
  type InternalDnd35PrestigeClass
} from '@nyx/contracts';
import { canonicalJson, err, ok, type Result } from '@nyx/domain';

export type Dnd35PrestigeClass = InternalDnd35PrestigeClass.Dnd35PrestigeClassV1;
export type Dnd35ExoticRace = InternalDnd35ExoticRace.Dnd35ExoticRaceV1;

type CatalogKind = 'prestige' | 'race';
type ProtectedManifestEntry = {
  readonly kind: CatalogKind;
  readonly id: string;
  readonly output_file: string;
  readonly output_file_sha256: string;
};

type ProtectedManifest = {
  readonly schema: 'nyx.protected_content_manifest.v1';
  readonly extracted_counts: {
    readonly prestige_classes: 24;
    readonly exotic_races: 27;
  };
  readonly entries: readonly ProtectedManifestEntry[];
};

export type CatalogAssetHash = {
  readonly kind: CatalogKind;
  readonly id: string;
  readonly sha256: string;
};

export type Dnd35CatalogError = {
  readonly code:
    | 'ASSET_HASH_MISMATCH'
    | 'ASSET_JSON_INVALID'
    | 'ASSET_READ_ERROR'
    | 'CATALOG_COUNT_MISMATCH'
    | 'DUPLICATE_ID'
    | 'ENTRY_ID_MISMATCH'
    | 'ENTRY_SCHEMA_INVALID'
    | 'ENTRY_SEMANTICS_INVALID'
    | 'MANIFEST_INVALID'
    | 'UNSAFE_ASSET_PATH';
  readonly message: string;
  readonly entryId?: string;
};

const SHA256 = /^[a-f0-9]{64}$/u;
const PRESTIGE_PREFIX = 'packages/dnd35/data/protected/prestige/';
const RACE_PREFIX = 'packages/dnd35/data/protected/races/';

function failure(
  code: Dnd35CatalogError['code'],
  message: string,
  entryId?: string
): Result<never, Dnd35CatalogError> {
  return err({ code, message, ...(entryId === undefined ? {} : { entryId }) });
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseManifest(value: unknown): Result<ProtectedManifest, Dnd35CatalogError> {
  if (!plainObject(value)
    || value['schema'] !== 'nyx.protected_content_manifest.v1'
    || !plainObject(value['extracted_counts'])
    || value['extracted_counts']['prestige_classes'] !== 24
    || value['extracted_counts']['exotic_races'] !== 27
    || !Array.isArray(value['entries'])) {
    return failure('MANIFEST_INVALID', 'El manifiesto protegido no declara los catálogos 24/27 esperados.');
  }
  const entries: ProtectedManifestEntry[] = [];
  for (const candidate of value['entries']) {
    if (!plainObject(candidate) || !['prestige', 'race'].includes(String(candidate['kind']))) continue;
    if (typeof candidate['id'] !== 'string'
      || typeof candidate['output_file'] !== 'string'
      || typeof candidate['output_file_sha256'] !== 'string'
      || !SHA256.test(candidate['output_file_sha256'])) {
      return failure('MANIFEST_INVALID', 'Una entrada de catálogo del manifiesto es inválida.');
    }
    const kind = candidate['kind'] as CatalogKind;
    const expectedPrefix = kind === 'prestige' ? PRESTIGE_PREFIX : RACE_PREFIX;
    const normalized = candidate['output_file'].replaceAll('\\', '/');
    if (!normalized.startsWith(expectedPrefix) || normalized.includes('../')) {
      return failure('UNSAFE_ASSET_PATH', `Ruta de catálogo no autorizada: ${normalized}`, candidate['id']);
    }
    entries.push({
      kind,
      id: candidate['id'],
      output_file: normalized,
      output_file_sha256: candidate['output_file_sha256']
    });
  }
  const prestigeCount = entries.filter(entry => entry.kind === 'prestige').length;
  const raceCount = entries.filter(entry => entry.kind === 'race').length;
  if (prestigeCount !== 24 || raceCount !== 27) {
    return failure('CATALOG_COUNT_MISMATCH', `Conteos de catálogo inválidos: prestige=${prestigeCount} races=${raceCount}.`);
  }
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) {
    return failure('DUPLICATE_ID', 'El manifiesto contiene IDs de catálogo duplicados.');
  }
  return ok({
    schema: 'nyx.protected_content_manifest.v1',
    extracted_counts: { prestige_classes: 24, exotic_races: 27 },
    entries
  });
}

function safeAssetPath(productRoot: string, relativePath: string): Result<string, Dnd35CatalogError> {
  const resolvedRoot = path.resolve(productRoot);
  const resolvedAsset = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolvedAsset);
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
    return failure('UNSAFE_ASSET_PATH', `La ruta sale del producto: ${relativePath}.`);
  }
  return ok(resolvedAsset);
}

function sha256(value: Uint8Array | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function prestigeLevelsAreBounded(entry: Dnd35PrestigeClass): boolean {
  const milestoneLevels = Object.keys(entry.milestones).map(Number);
  if (milestoneLevels.some(level => !Number.isSafeInteger(level) || level < 1 || level > entry.levels)) return false;
  for (const [key, value] of Object.entries(entry.progression)) {
    if (key.endsWith('_levels') && Array.isArray(value)
      && value.some(level => typeof level !== 'number' || level < 1 || level > entry.levels)) return false;
    if (key === 'bonus_spells_by_level' && plainObject(value)
      && Object.keys(value).some(level => Number(level) < 1 || Number(level) > entry.levels)) return false;
  }
  return true;
}

function defaultProductRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
}

export class Dnd35ProtectedCatalog {
  readonly #prestigeClasses: readonly Dnd35PrestigeClass[];
  readonly #exoticRaces: readonly Dnd35ExoticRace[];
  readonly #assetHashes: readonly CatalogAssetHash[];
  readonly #prestigeById: ReadonlyMap<string, Dnd35PrestigeClass>;
  readonly #raceById: ReadonlyMap<string, Dnd35ExoticRace>;
  readonly fingerprintSha256: string;

  constructor(
    prestigeClasses: readonly Dnd35PrestigeClass[],
    exoticRaces: readonly Dnd35ExoticRace[],
    assetHashes: readonly CatalogAssetHash[]
  ) {
    this.#prestigeClasses = structuredClone(prestigeClasses);
    this.#exoticRaces = structuredClone(exoticRaces);
    this.#assetHashes = structuredClone(assetHashes);
    this.#prestigeById = new Map(this.#prestigeClasses.map(entry => [entry.id, entry]));
    this.#raceById = new Map(this.#exoticRaces.map(entry => [entry.id, entry]));
    this.fingerprintSha256 = sha256(canonicalJson({
      prestige_classes: this.#assetHashes.filter(entry => entry.kind === 'prestige'),
      exotic_races: this.#assetHashes.filter(entry => entry.kind === 'race')
    }));
  }

  get prestigeClasses(): readonly Dnd35PrestigeClass[] {
    return structuredClone(this.#prestigeClasses);
  }

  get exoticRaces(): readonly Dnd35ExoticRace[] {
    return structuredClone(this.#exoticRaces);
  }

  get assetHashes(): readonly CatalogAssetHash[] {
    return structuredClone(this.#assetHashes);
  }

  findPrestigeClass(id: string): Dnd35PrestigeClass | undefined {
    const entry = this.#prestigeById.get(id);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  findExoticRace(id: string): Dnd35ExoticRace | undefined {
    const entry = this.#raceById.get(id);
    return entry === undefined ? undefined : structuredClone(entry);
  }
}

export async function loadProtectedDnd35Catalog(
  options: { readonly productRoot?: string } = {}
): Promise<Result<Dnd35ProtectedCatalog, Dnd35CatalogError>> {
  const productRoot = path.resolve(options.productRoot ?? defaultProductRoot());
  const manifestPath = path.join(productRoot, 'packages/contracts/manifests/protected-content.json');
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (error) {
    return failure('MANIFEST_INVALID', `No se pudo leer el manifiesto protegido: ${String(error)}`);
  }
  const manifest = parseManifest(manifestValue);
  if (!manifest.ok) return manifest;

  const prestigeClasses: Dnd35PrestigeClass[] = [];
  const exoticRaces: Dnd35ExoticRace[] = [];
  const assetHashes: CatalogAssetHash[] = [];
  for (const record of [...manifest.value.entries].sort((left, right) => left.id.localeCompare(right.id))) {
    const safePath = safeAssetPath(productRoot, record.output_file);
    if (!safePath.ok) return safePath;
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(safePath.value);
    } catch (error) {
      return failure('ASSET_READ_ERROR', `No se pudo leer ${record.output_file}: ${String(error)}`, record.id);
    }
    const actualHash = sha256(bytes);
    if (actualHash !== record.output_file_sha256) {
      return failure('ASSET_HASH_MISMATCH', `Hash protegido distinto para ${record.id}.`, record.id);
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      return failure('ASSET_JSON_INVALID', `JSON inválido para ${record.id}.`, record.id);
    }
    const contractName = record.kind === 'prestige' ? 'Dnd35PrestigeClass' : 'Dnd35ExoticRace';
    const validation = validateRuntimeContract(contractName, value);
    if (!validation.ok) {
      return failure('ENTRY_SCHEMA_INVALID', `${record.id}: ${validation.errors.join(',')}`, record.id);
    }
    if (!plainObject(value) || value['id'] !== record.id) {
      return failure('ENTRY_ID_MISMATCH', `El payload no coincide con el ID ${record.id}.`, record.id);
    }
    assetHashes.push({ kind: record.kind, id: record.id, sha256: actualHash });
    if (record.kind === 'prestige') {
      const entry = structuredClone(value) as unknown as Dnd35PrestigeClass;
      if (!prestigeLevelsAreBounded(entry)) {
        return failure('ENTRY_SEMANTICS_INVALID', `La progresión de ${record.id} excede sus niveles declarados.`, record.id);
      }
      prestigeClasses.push(entry);
    } else {
      exoticRaces.push(structuredClone(value) as unknown as Dnd35ExoticRace);
    }
  }

  return ok(new Dnd35ProtectedCatalog(prestigeClasses, exoticRaces, assetHashes));
}
