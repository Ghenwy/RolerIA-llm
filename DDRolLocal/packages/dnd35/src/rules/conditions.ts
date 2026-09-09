export type Dnd35Condition = {
  readonly summary: string;
  readonly can_act?: boolean;
  readonly armor_class_mode?: 'NORMAL';
  readonly loses_dexterity_to_ac?: boolean;
  readonly armor_class_modifier?: number;
  readonly melee_attack_modifier?: number;
  readonly armor_class_vs_ranged?: number;
  readonly armor_class_vs_melee?: number;
};

export const DND35_CONDITIONS = {
  blinded: { summary: 'Pierde Destreza a CA, -2 CA, media velocidad y oponentes con ocultación total.', loses_dexterity_to_ac: true, armor_class_modifier: -2 },
  confused: { summary: 'Cada turno aplica la conducta de la tabla de confusión; no elige libremente.' },
  cowering: { summary: 'No actúa, pierde Destreza a CA y sufre -2 CA.', can_act: false, loses_dexterity_to_ac: true, armor_class_modifier: -2 },
  dazed: { summary: 'No actúa y conserva su CA normal.', can_act: false, armor_class_mode: 'NORMAL' },
  dazzled: { summary: '-1 a ataques, Search y Spot.' },
  deafened: { summary: '-4 iniciativa, falla Listen y 20% de fallo con componente verbal.' },
  disabled: { summary: 'A 0 PG: una acción de movimiento o estándar; una extenuante causa 1 PG.' },
  dying: { summary: 'Entre -1 y -9 PG: inconsciente y sujeto a estabilización/pérdida de PG.', can_act: false },
  entangled: { summary: 'Media velocidad, no corre/carga, -2 ataques, -4 Destreza y concentración al lanzar.' },
  exhausted: { summary: 'Media velocidad y -6 Fuerza/Destreza; descanso adecuado reduce a fatigued.' },
  fascinated: { summary: 'Observa con penalizadores reactivos; amenaza evidente rompe el estado.' },
  fatigued: { summary: '-2 Fuerza/Destreza y no puede correr ni cargar.' },
  flat_footed: { summary: 'Pierde Destreza a CA y bonuses que dependan de conservarla.', loses_dexterity_to_ac: true },
  frightened: { summary: 'Huye si puede y sufre -2 a ataques, salvaciones, habilidades y características.' },
  grappled: { summary: 'Opciones limitadas; no amenaza y aplica pérdidas/penalizadores de la regla.' },
  helpless: { summary: 'Destreza efectiva 0; vulnerable a cuerpo a cuerpo y golpe de gracia.', can_act: false },
  invisible: { summary: 'Ocultación total y ventajas aplicables; puede detectarse por otros medios.' },
  nauseated: { summary: 'Sólo una acción de movimiento por turno.' },
  panicked: { summary: 'Huye a máxima velocidad, suelta objetos y sufre -2; si no huye, se encoge.' },
  paralyzed: { summary: 'Fuerza y Destreza efectivas 0; indefenso, permite acciones puramente mentales.' },
  petrified: { summary: 'Materia inerte; no actúa y puede sufrir daño físico al objeto.', can_act: false },
  pinned: { summary: 'Inmovilizado en agarre con restricciones y penalizadores adicionales.' },
  prone: { summary: '-4 ataques cuerpo a cuerpo; +4 CA vs distancia y -4 CA vs cuerpo a cuerpo.', melee_attack_modifier: -4, armor_class_vs_ranged: 4, armor_class_vs_melee: -4 },
  shaken: { summary: '-2 a ataques, salvaciones, habilidades y características.' },
  sickened: { summary: '-2 a ataques, daño, salvaciones, habilidades y características.' },
  stable: { summary: 'Inconsciente con PG negativos, deja de perder PG por estar muriendo.', can_act: false },
  staggered: { summary: 'Una acción estándar o movimiento, no ambas ni full-round.' },
  stunned: { summary: 'No actúa, suelta lo sostenido, pierde Destreza a CA y sufre -2 CA.', can_act: false, loses_dexterity_to_ac: true, armor_class_modifier: -2 },
  unconscious: { summary: 'Inconsciente e indefenso.', can_act: false }
} as const satisfies Record<string, Dnd35Condition>;

export type Dnd35ConditionId = keyof typeof DND35_CONDITIONS;

export function getCondition(id: string): Dnd35Condition | undefined {
  return Object.hasOwn(DND35_CONDITIONS, id)
    ? DND35_CONDITIONS[id as Dnd35ConditionId]
    : undefined;
}
