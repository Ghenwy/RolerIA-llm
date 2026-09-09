import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const productDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(productDir, 'dist');
const packageNames = ['application', 'contracts', 'dnd35', 'domain', 'llama-client', 'observability', 'persistence-json'];

async function filesUnder(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(target));
    else if (entry.name.endsWith('.js')) files.push(target);
  }
  return files;
}

for (const file of await filesUnder(distDir)) {
  let source = await fs.readFile(file, 'utf8');
  for (const packageName of packageNames) {
    const target = path.join(distDir, 'packages', packageName, 'src', 'index.js');
    let relative = path.relative(path.dirname(file), target).replaceAll('\\', '/');
    if (!relative.startsWith('.')) relative = `./${relative}`;
    source = source
      .replaceAll(`'@nyx/${packageName}'`, `'${relative}'`)
      .replaceAll(`"@nyx/${packageName}"`, `"${relative}"`);
  }
  await fs.writeFile(file, source, 'utf8');
}
