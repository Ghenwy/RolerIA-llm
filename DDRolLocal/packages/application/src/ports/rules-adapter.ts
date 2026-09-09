import type { ApplicationPortResult } from '../service/application-service.js';

/** Rules are proposals/read models; the State Engine alone can commit them. */
export interface RulesAdapter {
  readonly rulesetId: string;
  resolveRule(input: unknown): ApplicationPortResult<unknown>;
  validateCharacter(input: unknown): ApplicationPortResult<unknown>;
  validatePrestige(input: unknown): ApplicationPortResult<unknown>;
  validateRace(input: unknown): ApplicationPortResult<unknown>;
}

export interface CampaignRulesPort {
  /** Optional for legacy adapters; an absent capability blocks, never falls back to the LLM. */
  resolveRegistered?(campaignId: string, intent: unknown, expectedStateVersion: number): Promise<ApplicationPortResult<{
    readonly rulesetId: string;
    readonly stateVersion: number;
    readonly ruling: string;
    readonly sourceRefs: readonly string[];
  }>>;
  open(campaignId: string): Promise<ApplicationPortResult<{
    readonly manifest: unknown;
    readonly adapter: RulesAdapter;
  }>>;
}
