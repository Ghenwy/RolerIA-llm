import { parseArgs } from 'node:util';
import type { ApplicationCommand, ApplicationCommandHandler } from '@nyx/application';

export interface CliIo {
  writeOut(value: string): void;
  writeError(value: string): void;
}

export const CLI_USAGE = `Uso:
  nyx doctor
  nyx runtime <status|start|stop> [--profile 64k|96k|112k]
  nyx campaign <create|open> <campaign-id>
  nyx --experimental campaign create <campaign-id>
  nyx play <campaign-id>
  nyx play --campaign <id> --turn <id> --state-version <n> [--language es] <acción>
  nyx verify <campaign-id>
  nyx save <campaign-id>
  nyx load <checkpoint-id>
  nyx rollback <checkpoint-id>
  nyx branch <checkpoint-id> <branch-id>
  nyx operator <campaign-id>
  nyx fallback status
  nyx fallback play <campaign-id>`;

function required(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) throw new Error(`Falta ${label}.`);
  return value;
}

function oneOf<T extends string>(value: string | undefined, choices: readonly T[], label: string): T {
  if (value !== undefined && choices.includes(value as T)) return value as T;
  throw new Error(`${label} debe ser ${choices.join('|')}.`);
}

function exactPositionals(positionals: readonly string[], expected: number, command: string): void {
  if (positionals.length !== expected) {
    throw new Error(`${command} requiere exactamente ${expected} argumento${expected === 1 ? '' : 's'} posicional${expected === 1 ? '' : 'es'}.`);
  }
}

function onlyOptions(values: Record<string, string | boolean | undefined>, allowed: readonly string[], command: string): void {
  const unexpected = Object.entries(values)
    .filter(([name, value]) => value !== undefined && !allowed.includes(name))
    .map(([name]) => `--${name}`);
  if (unexpected.length > 0) throw new Error(`${command} no admite ${unexpected.join(', ')}.`);
}

function commandFrom(argv: readonly string[]): ApplicationCommand {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      campaign: { type: 'string' },
      turn: { type: 'string' },
      'state-version': { type: 'string' },
      language: { type: 'string' },
      profile: { type: 'string' }
    }
  });
  const [kind, ...positionals] = parsed.positionals;
  switch (kind) {
    case 'doctor':
      exactPositionals(positionals, 0, 'doctor');
      onlyOptions(parsed.values, [], 'doctor');
      return { kind };
    case 'runtime': {
      exactPositionals(positionals, 1, 'runtime');
      onlyOptions(parsed.values, ['profile'], 'runtime');
      const action = oneOf(positionals[0], ['status', 'start', 'stop'], 'runtime action');
      if (action !== 'start' && parsed.values.profile !== undefined) throw new Error('--profile sólo es válido con runtime start.');
      return {
        kind,
        action,
        ...(action === 'start' && parsed.values.profile !== undefined
          ? { profile: oneOf(parsed.values.profile, ['64k', '96k', '112k'], 'profile') }
          : {})
      };
    }
    case 'campaign':
      exactPositionals(positionals, 2, 'campaign');
      onlyOptions(parsed.values, [], 'campaign');
      return {
        kind,
        action: oneOf(positionals[0], ['create', 'open'], 'campaign action'),
        campaignId: required(positionals[1], 'campaign-id')
      };
    case 'play': {
      onlyOptions(parsed.values, ['campaign', 'turn', 'state-version', 'language'], 'play');
      const versionText = required(parsed.values['state-version'], 'state-version');
      const baseStateVersion = Number(versionText);
      if (!Number.isSafeInteger(baseStateVersion) || baseStateVersion < 0) throw new Error('state-version debe ser un entero no negativo.');
      return {
        kind,
        input: {
          campaignId: required(parsed.values.campaign, 'campaign'),
          turnId: required(parsed.values.turn, 'turn'),
          baseStateVersion,
          playerInput: required(positionals.join(' ').trim(), 'acción del jugador'),
          contextRefs: [],
          language: parsed.values.language ?? 'es'
        }
      };
    }
    case 'verify':
      exactPositionals(positionals, 1, 'verify');
      onlyOptions(parsed.values, [], 'verify');
      return { kind, campaignId: required(positionals[0], 'campaign-id') };
    case 'save':
      exactPositionals(positionals, 1, 'save');
      onlyOptions(parsed.values, [], 'save');
      return { kind, campaignId: required(positionals[0], 'campaign-id') };
    case 'load':
      exactPositionals(positionals, 1, 'load');
      onlyOptions(parsed.values, [], 'load');
      return { kind, checkpointId: required(positionals[0], 'checkpoint-id') };
    case 'rollback':
      exactPositionals(positionals, 1, 'rollback');
      onlyOptions(parsed.values, [], 'rollback');
      return { kind, checkpointId: required(positionals[0], 'checkpoint-id') };
    case 'branch':
      exactPositionals(positionals, 2, 'branch');
      onlyOptions(parsed.values, [], 'branch');
      return {
        kind,
        checkpointId: required(positionals[0], 'checkpoint-id'),
        branchId: required(positionals[1], 'branch-id')
      };
    case 'operator':
      exactPositionals(positionals, 1, 'operator');
      onlyOptions(parsed.values, [], 'operator');
      return { kind, campaignId: required(positionals[0], 'campaign-id') };
    case 'fallback': {
      onlyOptions(parsed.values, [], 'fallback');
      const action = oneOf(positionals[0], ['status', 'play'], 'fallback action');
      if (action === 'status') {
        exactPositionals(positionals, 1, 'fallback status');
        return { kind, action };
      }
      exactPositionals(positionals, 2, 'fallback play');
      return { kind, action, campaignId: required(positionals[1], 'campaign-id') };
    }
    default:
      throw new Error(`Comando desconocido: ${kind ?? '(vacío)'}.`);
  }
}

export async function runCli(
  argv: readonly string[],
  application: ApplicationCommandHandler,
  io: CliIo
): Promise<number> {
  let command: ApplicationCommand;
  try {
    command = commandFrom(argv);
  } catch (error) {
    io.writeError(`${error instanceof Error ? error.message : String(error)}\n${CLI_USAGE}`);
    return 2;
  }
  const response = await application.execute(command);
  const serialized = JSON.stringify(response);
  if (response.ok) io.writeOut(serialized);
  else io.writeError(serialized);
  return response.ok ? 0 : 1;
}
