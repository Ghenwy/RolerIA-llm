import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const productDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(fs.readFileSync(path.join(productDir, 'package.json'), 'utf8'));
const relativeEntry = packageJson.bin?.nyx;
if (relativeEntry !== './dist/apps/tui/src/main.js') throw new Error('package.bin.nyx no apunta al ejecutable compilado.');
const entry = path.join(productDir, relativeEntry);
if (!fs.existsSync(entry)) throw new Error(`Falta el ejecutable compilado: ${entry}`);
const helpOutputs = [];
for (const argument of ['--help', '-h', 'help']) {
  const result = spawnSync(process.execPath, [entry, argument], { cwd: productDir, encoding: 'utf8', windowsHide: true });
  if (
    result.status !== 0
    || !result.stdout.includes('nyx play <campaign-id>')
    || !result.stdout.includes('nyx play --campaign <id> --turn <id> --state-version <n>')
    || result.stderr.length > 0
  ) {
    throw new Error(`CLI smoke falló: argument=${argument} status=${String(result.status)} stdout=${result.stdout} stderr=${result.stderr}`);
  }
  helpOutputs.push(result.stdout);
}
if (new Set(helpOutputs).size !== 1) throw new Error('CLI smoke falló: las variantes de ayuda divergen.');
console.log('CLI_SMOKE_OK commands=--help,-h,help composition=compiled');
