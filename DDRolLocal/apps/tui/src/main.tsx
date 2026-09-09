#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from 'ink';
import { createLocalNyxRuntime, locateProductRoot } from '../../../bootstrap/local-application.js';
import { CLI_USAGE, runCli, type CliIo } from './cli/run-cli.js';
import { InteractiveNyxTui, NyxTui, parseOperatorViewModel } from './ui/nyx-tui.js';

const defaultIo: CliIo = {
  writeOut(value) { process.stdout.write(`${value}\n`); },
  writeError(value) { process.stderr.write(`${value}\n`); }
};

export async function main(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help')) {
    io.writeOut(CLI_USAGE);
    return 0;
  }
  const experimental = argv[0] === '--experimental';
  if (experimental) {
    if (argv.length !== 4 || argv[1] !== 'campaign' || argv[2] !== 'create') {
      io.writeError('--experimental sólo crea campañas nuevas: nyx --experimental campaign create <id>. No convierte campañas existentes.');
      return 2;
    }
    argv = argv.slice(1);
  }
  const productRoot = await locateProductRoot(import.meta.url);
  const runtime = await createLocalNyxRuntime({ productRoot,
    newCampaignTurnProfile: experimental ? 'AUTOMATIC_EXPERIMENTAL' : 'ASSISTED_ALPHA' });
  if (argv[0] === 'operator' && argv.length === 2 && argv[1] !== undefined && !argv[1].startsWith('-')) {
    const response = await runtime.application.execute({ kind: 'operator', campaignId: argv[1] });
    if (!response.ok) {
      io.writeError(JSON.stringify(response));
      return 1;
    }
    const operator = parseOperatorViewModel(response.data);
    if (operator === undefined) {
      io.writeError('El estado operativo no cumple el read model esperado.');
      return 1;
    }
    render(<NyxTui mode="operator" operator={operator} />);
    return 0;
  }
  if (argv[0] === 'play' && argv.length === 2 && argv[1] !== undefined && !argv[1].startsWith('-')) {
    const session = await runtime.openSession(argv[1]);
    if (!session.ok) {
      io.writeError(JSON.stringify(session));
      return 1;
    }
    const app = render(<InteractiveNyxTui
      application={runtime.application}
      campaignId={session.value.campaignId}
      turnId={`TURN-${Date.now()}`}
      baseStateVersion={session.value.stateVersion}
      language={session.value.language}
      onExit={() => app.unmount()}
    />);
    return 0;
  }
  return runCli(argv, runtime.application, io);
}

const invokedFile = process.argv[1];
if (invokedFile !== undefined && path.resolve(invokedFile) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    code => { process.exitCode = code; },
    () => {
      defaultIo.writeError('Nyx no pudo arrancar de forma segura.');
      process.exitCode = 1;
    }
  );
}
