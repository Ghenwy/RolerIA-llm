import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApplicationResponse } from '@nyx/application';
import { createLocalNyxRuntime, locateProductRoot, type LocalNyxRuntimeOptions } from './local-application.js';
import { installC9SpanishCampaignFixture } from './local-starter-campaign.js';

/** [DESIGN] Prepare the shared local demo once; never repair/overwrite an existing campaign. */
export async function prepareBetaCampaign(options: LocalNyxRuntimeOptions, campaignId: string): Promise<ApplicationResponse> {
  const runtime = await createLocalNyxRuntime(options);
  const created = await runtime.application.execute({ kind: 'campaign', action: 'create', campaignId });
  if (!created.ok) return created;
  try {
    const campaignsRoot = options.campaignsRoot ?? path.join(options.productRoot, 'campaigns');
    await installC9SpanishCampaignFixture(path.join(campaignsRoot, campaignId), campaignId);
    const verified = await runtime.application.execute({ kind: 'verify', campaignId });
    if (!verified.ok) return verified;
    const saved = await runtime.application.execute({ kind: 'save', campaignId });
    if (!saved.ok) return saved;
    const assisted = options.newCampaignTurnProfile === 'ASSISTED_ALPHA';
    return { ok: true, code: assisted ? 'ALPHA_CAMPAIGN_PREPARED' : 'BETA_CAMPAIGN_PREPARED',
      message: assisted
        ? 'Campaña Alpha asistida preparada: diálogo, regla registrada, inn-to-bridge/bridge-to-inn y rival-attack con daño real. La aceptación física sigue siendo independiente.'
        : 'Campaña local preparada con personaje, tres NPCs, inventario y checkpoint verificado.',
      data: { campaignId, checkpoint: saved.data } };
  } catch {
    return { ok: false, code: 'BETA_PREPARATION_FAILED',
      message: 'Preparación interrumpida. Se conserva la campaña para diagnóstico; no se sobrescribe ni se publica como lista.' };
  }
}

const invoked = process.argv[1];
if (invoked !== undefined && path.resolve(invoked) === path.resolve(fileURLToPath(import.meta.url))) {
  let args = process.argv.slice(2);
  const experimental = args[0] === '--experimental';
  if (experimental) args = args.slice(1);
  if (args.length !== 1) {
    process.stderr.write('Uso: node dist/bootstrap/prepare-beta.js [--experimental] CAMPAIGN-alpha-01\n');
    process.exitCode = 2;
  } else {
    try {
      const productRoot = await locateProductRoot(import.meta.url);
      const result = await prepareBetaCampaign({ productRoot,
        newCampaignTurnProfile: experimental ? 'AUTOMATIC_EXPERIMENTAL' : 'ASSISTED_ALPHA' }, args[0]!);
      (result.ok ? process.stdout : process.stderr).write(`${JSON.stringify(result)}\n`);
      process.exitCode = result.ok ? 0 : 1;
    } catch {
      process.stderr.write('No se pudo preparar el runtime local; ejecuta doctor y conserva los datos.\n');
      process.exitCode = 1;
    }
  }
}
