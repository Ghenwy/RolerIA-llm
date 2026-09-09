import type { CampaignState, InventoryRecord } from '../state/types.js';

export type CampaignInvariantCode =
  | 'DUPLICATE_ITEM_INSTANCE'
  | 'NEGATIVE_QUANTITY'
  | 'OWNER_MISMATCH'
  | 'INVALID_CONTAINER_REFERENCE'
  | 'INVALID_CHARGES'
  | 'WEIGHT_MISMATCH'
  | 'INCOMPLETE_PLAYER_SHEET'
  | 'CHARACTER_ID_MISMATCH'
  | 'INVENTORY_ID_MISMATCH';

export interface CampaignInvariantError {
  code: CampaignInvariantCode;
  path: string;
  message: string;
}

export function recalculateInventoryWeight(inventory: InventoryRecord): void {
  inventory.carrying.total_weight = Number(
    inventory.items.reduce((total, item) => total + item.weight_each * item.quantity, 0).toFixed(6)
  );
}

export function validateCampaignInvariants(state: CampaignState): CampaignInvariantError[] {
  const errors: CampaignInvariantError[] = [];
  for (const [characterId, character] of Object.entries(state.characters)) {
    if (character.character_id !== characterId) {
      errors.push({ code: 'CHARACTER_ID_MISMATCH', path: `/characters/${characterId}`, message: 'La clave no coincide con character_id.' });
    }
    if (character.kind === 'player' && character.detail !== 'full') {
      errors.push({ code: 'INCOMPLETE_PLAYER_SHEET', path: `/characters/${characterId}`, message: 'Una ficha de jugador siempre debe ser full.' });
    }
  }

  const itemLocations = new Map<string, string>();
  for (const [inventoryId, inventory] of Object.entries(state.inventories)) {
    if (inventory.inventory_id !== inventoryId) {
      errors.push({ code: 'INVENTORY_ID_MISMATCH', path: `/inventories/${inventoryId}`, message: 'La clave no coincide con inventory_id.' });
    }
    const containerIds = new Set(inventory.containers.map(container => container.container_id));
    for (const [index, container] of inventory.containers.entries()) {
      if (container.parent_container_id !== null && !containerIds.has(container.parent_container_id)) {
        errors.push({
          code: 'INVALID_CONTAINER_REFERENCE',
          path: `/inventories/${inventoryId}/containers/${index}/parent_container_id`,
          message: 'El contenedor padre no existe en el inventario.'
        });
      }
    }
    for (const [index, item] of inventory.items.entries()) {
      const previous = itemLocations.get(item.item_instance_id);
      if (previous) {
        errors.push({
          code: 'DUPLICATE_ITEM_INSTANCE',
          path: `/inventories/${inventoryId}/items/${index}/item_instance_id`,
          message: `La instancia ya existe en ${previous}.`
        });
      } else itemLocations.set(item.item_instance_id, inventoryId);
      if (!Number.isInteger(item.quantity) || item.quantity < 0) {
        errors.push({ code: 'NEGATIVE_QUANTITY', path: `/inventories/${inventoryId}/items/${index}/quantity`, message: 'quantity debe ser un entero no negativo.' });
      }
      if (item.owner_id !== inventory.owner_id) {
        errors.push({ code: 'OWNER_MISMATCH', path: `/inventories/${inventoryId}/items/${index}/owner_id`, message: 'El owner del item no coincide con el inventario.' });
      }
      if (item.container_id !== null && !containerIds.has(item.container_id)) {
        errors.push({ code: 'INVALID_CONTAINER_REFERENCE', path: `/inventories/${inventoryId}/items/${index}/container_id`, message: 'El contenedor del item no existe.' });
      }
      if (
        (item.charges_current === null) !== (item.charges_max === null) ||
        (item.charges_current !== null && item.charges_max !== null && (item.charges_current < 0 || item.charges_current > item.charges_max))
      ) {
        errors.push({ code: 'INVALID_CHARGES', path: `/inventories/${inventoryId}/items/${index}`, message: 'Las cargas del item son inconsistentes.' });
      }
    }
    const expectedWeight = Number(inventory.items.reduce((total, item) => total + item.weight_each * item.quantity, 0).toFixed(6));
    if (Math.abs(expectedWeight - inventory.carrying.total_weight) > 0.000001) {
      errors.push({ code: 'WEIGHT_MISMATCH', path: `/inventories/${inventoryId}/carrying/total_weight`, message: 'El peso total debe recalcularse desde los items.' });
    }
  }
  return errors;
}
