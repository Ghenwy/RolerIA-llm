import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

const toolingDir = path.dirname(fileURLToPath(import.meta.url));
const productDir = path.dirname(toolingDir);
const schemaRoot = path.join(productDir, 'packages', 'contracts', 'schemas');
const outputDir = path.join(productDir, 'packages', 'contracts', 'src', 'generated');
const manifestPath = path.join(productDir, 'packages', 'contracts', 'manifests', 'generated-types.json');
const checkOnly = process.argv.includes('--check');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const normalize = value => `${value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd()}\n`;
const pascal = value => value.split(/[^A-Za-z0-9]+/).filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join('');
function collectSchemas(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectSchemas(full);
    return entry.name.endsWith('.schema.json') ? [full] : [];
  }).sort((left, right) => left.localeCompare(right));
}
function assertOrWrite(file, expected) {
  const bytes = Buffer.from(expected, 'utf8');
  if (checkOnly) {
    if (!fs.existsSync(file) || !fs.readFileSync(file).equals(bytes)) throw new Error(`Generated TypeScript differs: ${path.relative(productDir, file)}`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
}

const records = [];
for (const schemaFile of collectSchemas(schemaRoot)) {
  const schemaText = normalize(fs.readFileSync(schemaFile, 'utf8'));
  const schema = JSON.parse(schemaText);
  const schemaHash = sha256(Buffer.from(schemaText, 'utf8'));
  const relativeSchema = path.relative(schemaRoot, schemaFile).replaceAll('\\', '/');
  const stem = relativeSchema.replaceAll('/', '--').replace(/\.schema\.json$/, '');
  const outputFile = path.join(outputDir, `${stem}.ts`);
  const generated = normalize(await compile(schema, schema.title || pascal(stem), {
    bannerComment: `/* GENERATED FILE - DO NOT EDIT. source=${relativeSchema} schema_sha256=${schemaHash} */`,
    cwd: path.dirname(schemaFile),
    unknownAny: false,
    unreachableDefinitions: true,
    style: { singleQuote: true, semi: true, tabWidth: 2, trailingComma: 'none' }
  }));
  assertOrWrite(outputFile, generated);
  records.push({
    schema_id: schema.$id ?? null,
    schema_file: relativeSchema,
    schema_sha256: schemaHash,
    typescript_file: path.relative(productDir, outputFile).replaceAll('\\', '/'),
    typescript_sha256: sha256(Buffer.from(generated, 'utf8')),
    namespace: pascal(stem)
  });
}

const indexText = normalize(`${records.map(record => `export * as ${record.namespace} from './${path.basename(record.typescript_file, '.ts')}.js';`).join('\n')}\n`);
assertOrWrite(path.join(outputDir, 'index.ts'), indexText);
const manifest = normalize(JSON.stringify({ schema: 'nyx.generated_types_manifest.v1', generator: 'json-schema-to-typescript', records }, null, 2));
assertOrWrite(manifestPath, manifest);

const expectedOutputs = new Set([...records.map(record => path.resolve(productDir, record.typescript_file)), path.resolve(outputDir, 'index.ts')]);
if (fs.existsSync(outputDir)) {
  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts') && !expectedOutputs.has(path.resolve(outputDir, entry.name))) throw new Error(`Unexpected generated TypeScript file: ${entry.name}`);
  }
}
console.log(`TYPESCRIPT_CODEGEN_${checkOnly ? 'CHECK' : 'WRITE'}_OK schemas=${records.length}`);
