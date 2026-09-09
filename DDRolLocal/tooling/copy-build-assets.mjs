import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const productDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const copies = [
  ['packages/contracts/schemas', 'dist/packages/contracts/schemas'],
  ['packages/contracts/prompts', 'dist/packages/contracts/prompts'],
  ['packages/contracts/manifests', 'dist/packages/contracts/manifests'],
  ['packages/dnd35/data', 'dist/packages/dnd35/data'],
  ['rulesets', 'dist/rulesets']
];

for (const [source, destination] of copies) {
  const target = path.join(productDir, destination);
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(path.join(productDir, source), target, { recursive: true, force: false });
}
