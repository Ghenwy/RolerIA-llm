import type {
  LlmCancellation,
  LlmGateway,
  LlmGatewayResult,
  LlmRequestOptions
} from '@nyx/application';
import type { SotRpgjobCard, SotRpgworkerResult } from '@nyx/contracts';

export class GovernedWorkerRunner {
  readonly #gateway: LlmGateway;

  constructor(gateway: LlmGateway) {
    this.#gateway = gateway;
  }

  async execute(
    job: SotRpgjobCard.RPGJobCard,
    context: readonly unknown[],
    options: LlmRequestOptions
  ): Promise<LlmGatewayResult<SotRpgworkerResult.RPGWorkerResult>> {
    const first = await this.#gateway.runWorker(job, context, { ...options, workerAttempt: 0 });
    if (first.ok || first.error.code !== 'INVALID_JSON') return first;
    return this.#gateway.runWorker(job, context, { ...options, workerAttempt: 1 });
  }

  cancel(correlationId: string): Promise<LlmGatewayResult<LlmCancellation>> {
    return this.#gateway.cancel(correlationId);
  }
}
