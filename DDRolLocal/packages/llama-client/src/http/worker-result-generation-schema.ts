import { runtimeContractSchema, type SotRpgjobCard } from '@nyx/contracts';

type JsonObject = Record<string, unknown>;

function objectAt(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`Invalid protected WorkerResult schema at ${path}.`);
  }
  return value as JsonObject;
}

function withoutSchemaIdentifiers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSchemaIdentifiers);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== '$schema' && key !== '$id')
      .map(([key, nested]) => [key, withoutSchemaIdentifiers(nested)])
  );
}

/** [DESIGN] Generation-only identity overlay; protected WorkerResult remains unchanged. */
export function workerResultGenerationSchema(job: SotRpgjobCard.RPGJobCard): object {
  const schema = objectAt(withoutSchemaIdentifiers(runtimeContractSchema('RPGWorkerResult')), '/');
  const properties = objectAt(schema['properties'], '/properties');
  properties['job_id'] = { ...objectAt(properties['job_id'], '/job_id'), const: job.job_id };
  properties['turn_id'] = { ...objectAt(properties['turn_id'], '/turn_id'), const: job.turn_id };
  properties['worker_id'] = { ...objectAt(properties['worker_id'], '/worker_id'), const: job.worker_id };
  properties['base_state_version'] = {
    ...objectAt(properties['base_state_version'], '/base_state_version'),
    const: job.base_state_version
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'RPGWorkerResultGenerationOverlay',
    allOf: [schema]
  };
}
