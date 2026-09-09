import type { SotRpgjobCard } from '@nyx/contracts';

export const WORKER_IDS = [
  'rpg.rules_arbiter',
  'rpg.npc_director',
  'rpg.world_simulator',
  'rpg.encounter_engine',
  'rpg.state_keeper',
  'rpg.memory_keeper',
  'rpg.canon_validator',
  'rpg.lore_curator'
] as const satisfies readonly SotRpgjobCard.RPGJobCard['worker_id'][];

export type WorkerId = (typeof WORKER_IDS)[number];

export interface PromptBinding {
  readonly promptId: string;
  readonly promptAsset: string;
  readonly promptSourceSha256: string;
  readonly promptFileSha256: string;
}

export interface WorkerDefinition extends PromptBinding {
  readonly role: 'worker';
  readonly workerId: WorkerId;
}

export interface OrchestratorDefinition extends PromptBinding {
  readonly role: 'orchestrator';
}

function worker(
  workerId: WorkerId,
  promptId: string,
  promptAsset: string,
  promptSourceSha256: string,
  promptFileSha256: string
): WorkerDefinition {
  return Object.freeze({
    role: 'worker',
    workerId,
    promptId,
    promptAsset,
    promptSourceSha256,
    promptFileSha256
  });
}

export const WORKER_DEFINITIONS: readonly WorkerDefinition[] = Object.freeze([
  worker('rpg.rules_arbiter', 'RPG_RULES_ARBITER', 'nyx/rpg_rules_arbiter.txt', 'f5b9dfea4a8c0cd8a1e2a33f987840f4838788ce90d0c45cb3ce530c3677942e', '251eb551c7c8b9cf65b61294be9c2fdc413fee5f632a946ff140cf9eac67e9b0'),
  worker('rpg.npc_director', 'RPG_NPC_DIRECTOR', 'nyx/rpg_npc_director.txt', '55efe0354e959fe84d9175c1e40df37781f93de8f8aebc5f12874357b9f359d3', '0091e7a85196e3b692a4a5cf535b201b25ce0ec2896ac59587d07fb29effa3ab'),
  worker('rpg.world_simulator', 'RPG_WORLD_SIMULATOR', 'nyx/rpg_world_simulator.txt', '744566f98b75e0b87641642c405a79f29c604ace17c7082954a8522ab4e58a02', '2f0ae1ae6cdab757a9fedf7b9e4b7835bef9cb19b1f15bf56039ccddd927ce4c'),
  worker('rpg.encounter_engine', 'RPG_ENCOUNTER_ENGINE', 'nyx/rpg_encounter_engine.txt', '7be812f9eff4f14a1462ae7d47639dc544ea85472f1a2e68b8c29c7c3616306a', '653216dfa4ccb1a90e37b3a0d814815eb6a96afcf64fb18aea50cc77bb551058'),
  worker('rpg.state_keeper', 'RPG_STATE_KEEPER', 'nyx/rpg_state_keeper.txt', 'ad7a4bafbe1f1d7337c02a838f1162f250935c8ac6da6ef2705c1efbb4a70ab9', 'd80c06a9313b0b485cbce54b3ce99f34063f8785a30ed824dd802f0b0de80664'),
  worker('rpg.memory_keeper', 'RPG_MEMORY_KEEPER', 'nyx/rpg_memory_keeper.txt', '7c06d54b8f02229a382b47e053aa98ff4115f4f9a7c1c3562131eb159c1b9a1e', '7c118d12d4dfaf5233d973ea9b63cfef6efdb5615153d6d0595d8ea0bd8591b1'),
  worker('rpg.canon_validator', 'RPG_CANON_VALIDATOR', 'nyx/rpg_canon_validator.txt', '46b1d91012d60f50cc856050377c8907e10f44ac97a9e3ec7bfa94b2685252cd', '588b16e72682d5747222e0c963bbdee28436dcad8833676a98a88dff2277a71d'),
  worker('rpg.lore_curator', 'RPG_LORE_CURATOR', 'nyx/rpg_lore_curator.txt', '98428a1dab88ab30cdba38b14761821aeb0359667d9ae665e25e7fbc8d9eac88', 'eb1321d5da8616c1bdcb07909a53af3159497bb8395da09aec058c150b9a2b94')
]);

export const NYX_GM_ORCHESTRATOR: OrchestratorDefinition = Object.freeze({
  role: 'orchestrator',
  promptId: 'NYX_GM',
  promptAsset: 'nyx/nyx_gm.txt',
  promptSourceSha256: 'fbf28703f4678717c8dcff97d1f2a3c668cf4a03568c36dc0b82af85485b553b',
  promptFileSha256: '1db6a1f533b7a439586ad4d7dd540ab1cbccaedc65722590e23c8c1912399433'
});

const WORKERS_BY_ID: ReadonlyMap<WorkerId, WorkerDefinition> = new Map(
  WORKER_DEFINITIONS.map(definition => [definition.workerId, definition])
);

const EXPECTED_PROMPT_BY_WORKER: Readonly<Record<WorkerId, string>> = Object.fromEntries(
  WORKER_DEFINITIONS.map(definition => [definition.workerId, definition.promptId])
) as Readonly<Record<WorkerId, string>>;

export type WorkerRegistryValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] };

interface WorkerRegistryCandidate {
  readonly workerId: string;
  readonly promptId: string;
}

interface OrchestratorCandidate {
  readonly role: string;
  readonly promptId: string;
}

export function validateWorkerRegistry(
  workers: readonly WorkerRegistryCandidate[],
  orchestrator: OrchestratorCandidate
): WorkerRegistryValidationResult {
  const errors: string[] = [];
  if (workers.length !== WORKER_IDS.length) errors.push(`registry:worker_count:${workers.length}`);
  const seen = new Set<string>();
  for (const definition of workers) {
    if (seen.has(definition.workerId)) errors.push(`registry:duplicate_worker:${definition.workerId}`);
    seen.add(definition.workerId);
    if (definition.promptId === 'NYX_GM') errors.push('registry:gm_must_not_be_worker');
    if (!WORKER_IDS.includes(definition.workerId as WorkerId)) {
      errors.push(`registry:unknown_worker:${definition.workerId}`);
      continue;
    }
    const expectedPrompt = EXPECTED_PROMPT_BY_WORKER[definition.workerId as WorkerId];
    if (definition.promptId !== expectedPrompt) {
      errors.push(`registry:prompt_mismatch:${definition.workerId}`);
    }
  }
  for (const expected of WORKER_IDS) {
    if (!seen.has(expected)) errors.push(`registry:missing_worker:${expected}`);
  }
  if (orchestrator.role !== 'orchestrator' || orchestrator.promptId !== 'NYX_GM') {
    errors.push('registry:nyx_gm_orchestrator_invalid');
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function getWorkerDefinition(workerId: string): WorkerDefinition | undefined {
  return WORKERS_BY_ID.get(workerId as WorkerId);
}
