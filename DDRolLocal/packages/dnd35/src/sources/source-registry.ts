import {
  type InternalRuleSourceRecord,
  validateRuntimeContract,
} from '@nyx/contracts';
import { err, ok, type Result } from '@nyx/domain';

type RuleSourceRecordV1 = InternalRuleSourceRecord.RuleSourceRecordV1;

export type RuleMaterialKind = 'OPEN' | 'CLOSED';

export type RuleSourceCandidate<T> = {
  readonly sourceId: string;
  readonly value: T;
  readonly claimFingerprint: string;
  readonly compatibleWithHigherPrecedence: boolean;
};

export type RuleSourceQuery<T> = {
  readonly ruleId: string;
  readonly material: RuleMaterialKind;
  readonly candidates: readonly RuleSourceCandidate<T>[];
};

export type SourceRegistryError = {
  readonly code: 'DUPLICATE_SOURCE_ID' | 'INVALID_SOURCE_RECORD';
  readonly message: string;
};

export type RuleSourceResolution<T> =
  | {
    readonly status: 'RESOLVED';
    readonly precedence: RuleSourceRecordV1['source_kind'];
    readonly sourceRefs: readonly string[];
    readonly value: T;
  }
  | {
    readonly status: 'CONFLICT';
    readonly code: 'SAME_PRECEDENCE_CONFLICT';
    readonly precedence: RuleSourceRecordV1['source_kind'];
    readonly sourceRefs: readonly string[];
  }
  | {
    readonly status: 'BLOCKED';
    readonly code:
      | 'CLOSED_MATERIAL_UNREGISTERED'
      | 'INCOMPATIBLE_PERSISTED_RULING'
      | 'INVALID_CANDIDATE'
      | 'SOURCE_SCOPE_VIOLATION'
      | 'UNREGISTERED_SOURCE'
      | 'UNRESOLVED';
    readonly sourceRefs: readonly string[];
  };

const SOURCE_PRECEDENCE: Readonly<Record<RuleSourceRecordV1['source_kind'], number>> = {
  HOUSE_RULE: 1,
  OFFICIAL_ERRATA: 2,
  SRD_OGC: 3,
  PERSISTED_RULING: 4,
  USER_OWNED_EXCERPT: 5
};

const SHA256 = /^[a-f0-9]{64}$/;

type RegisteredCandidate<T> = {
  readonly candidate: RuleSourceCandidate<T>;
  readonly source: RuleSourceRecordV1;
};

export class SourceRegistry {
  readonly #sources: ReadonlyMap<string, RuleSourceRecordV1>;

  private constructor(sources: ReadonlyMap<string, RuleSourceRecordV1>) {
    this.#sources = sources;
  }

  static create(records: readonly unknown[]): Result<SourceRegistry, SourceRegistryError> {
    const sources = new Map<string, RuleSourceRecordV1>();
    for (const value of records) {
      const validation = validateRuntimeContract('RuleSourceRecord', value);
      if (!validation.ok) {
        return err({
          code: 'INVALID_SOURCE_RECORD',
          message: `RuleSourceRecord inválido: ${validation.errors.join(',')}`
        });
      }
      const record = structuredClone(value) as RuleSourceRecordV1;
      if (sources.has(record.source_id)) {
        return err({
          code: 'DUPLICATE_SOURCE_ID',
          message: `Source ID duplicado: ${record.source_id}`
        });
      }
      sources.set(record.source_id, record);
    }
    return ok(new SourceRegistry(sources));
  }

  resolve<T>(query: RuleSourceQuery<T>): RuleSourceResolution<T> {
    if (query.ruleId.trim().length === 0) {
      return { status: 'BLOCKED', code: 'INVALID_CANDIDATE', sourceRefs: [] };
    }

    if (query.material === 'CLOSED') {
      const hasRegisteredExcerpt = query.candidates.some(candidate => {
        const source = this.#sources.get(candidate.sourceId);
        return source?.enabled === true
          && source.source_kind === 'USER_OWNED_EXCERPT'
          && source.allowed_scope.includes(query.ruleId);
      });
      if (!hasRegisteredExcerpt) {
        return { status: 'BLOCKED', code: 'CLOSED_MATERIAL_UNREGISTERED', sourceRefs: [] };
      }
    }

    const registered: RegisteredCandidate<T>[] = [];
    for (const candidate of query.candidates) {
      if (!SHA256.test(candidate.claimFingerprint)) {
        return { status: 'BLOCKED', code: 'INVALID_CANDIDATE', sourceRefs: [candidate.sourceId] };
      }
      const source = this.#sources.get(candidate.sourceId);
      if (source === undefined) {
        return { status: 'BLOCKED', code: 'UNREGISTERED_SOURCE', sourceRefs: [candidate.sourceId] };
      }
      if (!source.enabled) continue;
      if (!source.allowed_scope.includes(query.ruleId)) {
        return { status: 'BLOCKED', code: 'SOURCE_SCOPE_VIOLATION', sourceRefs: [source.source_id] };
      }
      registered.push({ candidate, source });
    }

    if (registered.length === 0) {
      return { status: 'BLOCKED', code: 'UNRESOLVED', sourceRefs: [] };
    }

    const selectedRank = Math.min(...registered.map(({ source }) => SOURCE_PRECEDENCE[source.source_kind]!));
    const selected = registered
      .filter(({ source }) => SOURCE_PRECEDENCE[source.source_kind] === selectedRank)
      .sort((left, right) => left.source.source_id.localeCompare(right.source.source_id));
    const selectedKind = selected[0]?.source.source_kind;
    if (selectedKind === undefined) {
      return { status: 'BLOCKED', code: 'UNRESOLVED', sourceRefs: [] };
    }
    const sourceRefs = selected.map(({ source }) => source.source_id);

    if (selectedKind === 'PERSISTED_RULING'
      && selected.some(({ candidate }) => !candidate.compatibleWithHigherPrecedence)) {
      return { status: 'BLOCKED', code: 'INCOMPATIBLE_PERSISTED_RULING', sourceRefs };
    }

    if (new Set(selected.map(({ candidate }) => candidate.claimFingerprint)).size !== 1) {
      return {
        status: 'CONFLICT',
        code: 'SAME_PRECEDENCE_CONFLICT',
        precedence: selectedKind,
        sourceRefs
      };
    }

    return {
      status: 'RESOLVED',
      precedence: selectedKind,
      sourceRefs,
      value: selected[0]!.candidate.value
    };
  }
}

export function createSourceRegistry(
  records: readonly unknown[]
): Result<SourceRegistry, SourceRegistryError> {
  return SourceRegistry.create(records);
}
