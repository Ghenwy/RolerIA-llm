import fs from 'node:fs/promises';
import path from 'node:path';

export type DurableFileFaultPoint =
  | 'BEFORE_FLUSH'
  | 'AFTER_FLUSH'
  | 'BEFORE_FSYNC'
  | 'AFTER_FSYNC'
  | 'BEFORE_RENAME'
  | 'AFTER_RENAME';

export class InjectedDurableFileFault extends Error {
  constructor(readonly point: DurableFileFaultPoint) {
    super(`Injected durable file fault at ${point}`);
    this.name = 'InjectedDurableFileFault';
  }
}

export type DurableFileFaultInjector = (point: DurableFileFaultPoint) => void;

export async function ensureDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
}

export async function writeDurable(
  file: string,
  contents: string | Uint8Array,
  faultInjector?: DurableFileFaultInjector
): Promise<void> {
  await ensureDirectory(path.dirname(file));
  const handle = await fs.open(file, 'wx');
  try {
    faultInjector?.('BEFORE_FLUSH');
    await handle.writeFile(contents, 'utf8');
    faultInjector?.('AFTER_FLUSH');
    faultInjector?.('BEFORE_FSYNC');
    await handle.sync();
    faultInjector?.('AFTER_FSYNC');
  } finally {
    await handle.close();
  }
}

export async function replaceDurable(
  tempFile: string,
  finalFile: string,
  contents: string,
  faultInjector?: DurableFileFaultInjector
): Promise<void> {
  await writeDurable(tempFile, contents, faultInjector);
  faultInjector?.('BEFORE_RENAME');
  await fs.rename(tempFile, finalFile);
  faultInjector?.('AFTER_RENAME');
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
