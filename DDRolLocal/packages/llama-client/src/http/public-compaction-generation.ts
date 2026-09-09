import { runtimeContractSchema } from '@nyx/contracts';

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Generation-only administrative binding; no historical proposal is repaired or approved here. */
export function publicCompactionGenerationSchema(input: unknown): object | null {
  if (!record(input) || !record(input['source']) || !record(input['turn_range'])) return null;
  const source = input['source'];
  const range = input['turn_range'];
  const maps = ['pc_sheet_fingerprints', 'relevant_npc_sheet_fingerprints', 'party_inventory_fingerprints',
    'character_inventory_fingerprints', 'quest_fingerprints'] as const;
  if (maps.some(key => !record(source[key]) || Object.entries(source[key]).some(([id, hash]) =>
    !id || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)))) return null;
  if (typeof source['campaign_id'] !== 'string' || !source['campaign_id']
    || !Number.isSafeInteger(source['base_state_version']) || Number(source['base_state_version']) < 0
    || !Array.isArray(source['expected_exact_refs']) || source['expected_exact_refs'].some(v => typeof v !== 'string' || !v)
    || !Number.isSafeInteger(range['from_turn']) || !Number.isSafeInteger(range['to_turn'])
    || Number(range['from_turn']) < 1 || Number(range['to_turn']) < Number(range['from_turn'])) return null;
  const ids = (...keys: typeof maps[number][]) => [...new Set(keys.flatMap(key => Object.keys(source[key] as object)))].sort();
  const packet = input['context_packet'];
  if (!record(packet) || !Array.isArray(packet['context_refs']) || !Array.isArray(packet['sections'])) return null;
  const transcriptSection = packet['sections'].filter(record).find(section => section['id'] === 'recent_raw_transcript');
  if (!transcriptSection || !Array.isArray(transcriptSection['value'])) return null;
  const transcript = transcriptSection['value'];
  if (transcript.some(entry => !record(entry) || typeof entry['transcript_id'] !== 'string' || !entry['transcript_id'])
    || packet['context_refs'].some(ref => !record(ref) || typeof ref['id'] !== 'string' || !ref['id']
      || typeof ref['sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(ref['sha256']))) return null;
  const refs = [...packet['context_refs'].filter(record).map(ref => ref['id'] as string),
    ...transcript.filter(record).map(entry => `transcript:${String(entry['transcript_id'])}`)];
  if (refs.length === 0 || new Set(refs).size !== refs.length) return null;
  const threads = source['open_thread_ids'];
  if (!Array.isArray(threads) || threads.some(id => typeof id !== 'string' || !id)) return null;
  const memoryItem = (extra: Record<string, unknown> = {}) => ({ type: 'object', additionalProperties: false,
    required: ['text', 'source_refs', ...Object.keys(extra)], properties: {
      text: { type: 'string', minLength: 1, maxLength: 600 },
      source_refs: { type: 'array', minItems: 1, maxItems: refs.length, uniqueItems: true, items: { type: 'string', enum: refs } },
      ...extra
    } });
  const schema = runtimeContractSchema('CompactionProposal') as { properties: Record<string, Record<string, unknown>> };
  const props = schema.properties;
  for (const key of ['campaign_id', 'base_state_version'] as const) props[key] = { ...props[key], const: source[key] };
  props['source_turn_range'] = { ...props['source_turn_range'], const: { from_turn: range['from_turn'], to_turn: range['to_turn'] } };
  props['preserved_exact_refs'] = { ...props['preserved_exact_refs'], const: source['expected_exact_refs'] };
  props['state_patch_proposals'] = { type: 'array', items: { type: 'object' }, maxItems: 0 };
  // Scope only new public generation; the literal historical contract stays unchanged.
  // Bounds reject oversize proposals; they never truncate source records or force approval.
  props['durable_memories'] = { type: 'array', maxItems: 12, items: memoryItem() };
  const npcIds = ids('relevant_npc_sheet_fingerprints');
  props['npc_memory_patches'] = { type: 'array', maxItems: npcIds.length,
    items: npcIds.length ? memoryItem({ npc_id: { type: 'string', enum: npcIds } }) : { type: 'object' } };
  props['open_threads'] = { type: 'array', maxItems: threads.length,
    items: threads.length ? memoryItem({ thread_id: { type: 'string', enum: threads } }) : { type: 'object' } };
  props['scene_summary'] = { type: 'string', maxLength: 2000,
    pattern: String.raw`^[^"\\\x00-\x1F\x7F]{0,1000}[^"\\\x00-\x1F\x7F]{0,1000}$` };
  const manifest = props['validation_manifest']!['properties'] as Record<string, Record<string, unknown>>;
  for (const [field, values] of Object.entries({
    character_sheets_checked: ids('pc_sheet_fingerprints', 'relevant_npc_sheet_fingerprints'),
    inventories_checked: ids('party_inventory_fingerprints', 'character_inventory_fingerprints'),
    quests_checked: ids('quest_fingerprints')
  })) manifest[field] = { ...manifest[field], const: values };
  // Booleans, discrepancies and safe_to_evict remain free. Coordinator, Canon and PRE hashes still govern activation.
  return schema;
}

export const PUBLIC_COMPACTION_PROMPT = `Produce sólo CompactionProposal JSON para resumir el rango de transcript incluido. Los turnos posteriores permanecen literales, fuera de esta memoria.
scene_summary: secuencia relevante, qué ya ocurrió y qué sigue pendiente. No inventes iniciativa, acciones restantes ni decisiones del jugador. No recalcules mecánica ni interpretes un total como dado natural.
durable_memories: sólo compromisos, pistas y relaciones necesarios para continuar; no recopies fichas, voces ni inventarios que ya permanecen exactos. Doce es un máximo, no una cuota.
En TODO campo, una intervención acredita discurso: escribe X dijo, cree o preguntó; no conviertas lo dicho en conocimiento comprobado. Mantén sujeto, incertidumbre, negación y condición. Una promesa no demuestra cumplimiento.
Usa text/source_refs. Cada referencia del enum debe sustentar su texto: transcript:ID identifica una intervención; state:campaña:rama:versión identifica sólo los datos públicos aportados. Nunca uses una referencia válida para una afirmación distinta.
open_threads: cada thread_id conserva la entidad original y su pendiente. No asignes un duelo al ID de una misión sobre una llave. Un pendiente sin ID propio permanece en resumen o memoria. npc_memory_patches no cambian fichas; state_patch_proposals:[].
El código fija campaña, rango y referencias de PC y NPC, inventarios y quests. No son una tarea de recopiado. No infieras secretos ausentes.
Una misión abierta no es una discrepancia. safe_to_evict evalúa sustituir esos turnos EN EL PROMPT por memoria fiel; los archivos originales nunca se borran. Si todo lo necesario para continuar está conservado en memoria y fuentes exactas, se puede permitir; si falta algo, allowed=false con la pérdida concreta. Comprueba canon y límites de conocimiento antes de marcar sus flags. Canon, cobertura y hashes siguen siendo obligatorios.`;

export const PUBLIC_COMPACTION_CANON_CHECK = `VALIDACIÓN DE PROPUESTA DE MEMORIA PÚBLICA
El objeto que debes juzgar es proposal, no la coherencia del estado por separado. Contrasta cada afirmación de scene_summary, durable_memories, npc_memory_patches y open_threads contra state, events y transcript hasta su final.
Una sola afirmación falsa, no sustentada o contradictoria exige status=blocked, dod.passed=false y unresolved con el campo y la discrepancia concretos. Que otra parte de la propuesta sí sea correcta NO compensa una afirmación falsa. No des por verificada la propuesta porque sus IDs o el estado base coincidan.
Distingue hechos ya ocurridos, acciones pendientes y compromisos vigentes. Contrasta acciones y viajes completados, PG actuales, inventario y consumos; una intención no prueba ejecución, y un asunto abierto no niega pasos ya realizados. Comprueba también omisiones relevantes y límites de conocimiento.
Comprueba cada campo incluso si otro campo dice lo correcto: un transcript acredita que alguien dijo algo, no que sea cierto; cada thread_id debe seguir describiendo su entidad original; no hay iniciativa ni acciones restantes por inferencia. Dado natural, modificador y total son distintos: contrasta los operandos del evento, no sólo el total. Llegar a un lugar no acredita atravesarlo. Rechaza referencias que no existan o no sustenten el texto.
En findings basta una lista breve de discrepancias concretas con campo y fuente exacta; no recites todo el estado. Ante la primera contradicción confirmada, status=blocked, dod.passed=false y unresolved no vacío. Si no hay discrepancias, conserva findings breves y aprueba. Una misión abierta correctamente conservada no exige bloquear. No corrijas la propuesta, no escribas eventos ni parches. Mantén todos los demás controles del encargo. El transcript original permanece íntegro; no es necesario copiar secretos a la memoria pública.`;
