"""Deterministic event replay for the Python fallback."""

from __future__ import annotations

import copy
import math
from datetime import datetime
from typing import Any, TypeGuard

from .contracts import validate_contract, validate_event, validate_health, validate_state_schema
from .dice import roll_dice

JsonObject = dict[str, Any]


class StateError(ValueError):
    def __init__(self, code: str, event_id: str, message: str, event_index: int | None = None):
        self.code = code
        self.event_id = event_id
        self.event_index = event_index
        self.message = message
        suffix = "" if event_index is None else f" event_index={event_index}"
        super().__init__(f"{code} event_id={event_id}{suffix}: {message}")


def _object(value: Any) -> bool:
    return isinstance(value, dict)


def _integer(value: object) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool)


def _number(value: object) -> TypeGuard[int | float]:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def _event_id(event: JsonObject) -> str:
    value = event.get("event_id")
    return value if isinstance(value, str) else "UNKNOWN"


def _fail(event: JsonObject, code: str, message: str) -> StateError:
    return StateError(code, _event_id(event), message)


def _weight(inventory: JsonObject) -> float | int:
    items = inventory.get("items")
    if not isinstance(items, list):
        return 0
    total = 0.0
    for item in items:
        if isinstance(item, dict):
            quantity = item.get("quantity")
            weight_each = item.get("weight_each")
            if _integer(quantity) and _number(weight_each):
                total += quantity * float(weight_each)
    rounded = round(total, 6)
    return int(rounded) if rounded.is_integer() else rounded


def _recalculate_weight(inventory: JsonObject) -> None:
    carrying = inventory.get("carrying")
    if isinstance(carrying, dict):
        carrying["total_weight"] = _weight(inventory)


def _invariant_errors(state: JsonObject) -> tuple[str, ...]:
    errors: list[str] = []
    characters = state.get("characters")
    if isinstance(characters, dict):
        for character_id, value in characters.items():
            if not isinstance(value, dict):
                continue
            if value.get("character_id") != character_id:
                errors.append(f"/characters/{character_id} CHARACTER_ID_MISMATCH")
            if value.get("kind") == "player" and value.get("detail") != "full":
                errors.append(f"/characters/{character_id} INCOMPLETE_PLAYER_SHEET")

    locations: dict[str, str] = {}
    inventories = state.get("inventories")
    if not isinstance(inventories, dict):
        return tuple(errors)
    for inventory_id, value in inventories.items():
        if not isinstance(value, dict):
            continue
        if value.get("inventory_id") != inventory_id:
            errors.append(f"/inventories/{inventory_id} INVENTORY_ID_MISMATCH")
        containers = value.get("containers")
        container_ids = {
            item.get("container_id")
            for item in containers
            if isinstance(item, dict) and isinstance(item.get("container_id"), str)
        } if isinstance(containers, list) else set()
        if isinstance(containers, list):
            for index, container in enumerate(containers):
                if not isinstance(container, dict):
                    continue
                parent = container.get("parent_container_id")
                if parent is not None and parent not in container_ids:
                    errors.append(
                        f"/inventories/{inventory_id}/containers/{index} "
                        "INVALID_CONTAINER_REFERENCE"
                    )
        items = value.get("items")
        if isinstance(items, list):
            for index, item in enumerate(items):
                if not isinstance(item, dict):
                    continue
                item_id = item.get("item_instance_id")
                if isinstance(item_id, str):
                    if item_id in locations:
                        errors.append(
                            f"/inventories/{inventory_id}/items/{index} DUPLICATE_ITEM_INSTANCE"
                        )
                    else:
                        locations[item_id] = inventory_id
                quantity = item.get("quantity")
                if not _integer(quantity) or quantity < 0:
                    errors.append(f"/inventories/{inventory_id}/items/{index} NEGATIVE_QUANTITY")
                if item.get("owner_id") != value.get("owner_id"):
                    errors.append(f"/inventories/{inventory_id}/items/{index} OWNER_MISMATCH")
                container_id = item.get("container_id")
                if container_id is not None and container_id not in container_ids:
                    errors.append(
                        f"/inventories/{inventory_id}/items/{index} "
                        "INVALID_CONTAINER_REFERENCE"
                    )
                current = item.get("charges_current")
                maximum = item.get("charges_max")
                if (current is None) != (maximum is None) or (
                    _integer(current) and _integer(maximum) and (current < 0 or current > maximum)
                ):
                    errors.append(f"/inventories/{inventory_id}/items/{index} INVALID_CHARGES")
        carrying = value.get("carrying")
        actual_weight = carrying.get("total_weight") if isinstance(carrying, dict) else None
        if not _number(actual_weight) or abs(float(actual_weight) - float(_weight(value))) > 0.000001:
            errors.append(f"/inventories/{inventory_id}/carrying/total_weight WEIGHT_MISMATCH")
    return tuple(errors)


def validate_state(state: Any) -> tuple[str, ...]:
    schema_errors = validate_state_schema(state)
    if not isinstance(state, dict):
        return schema_errors
    return (*schema_errors, *_invariant_errors(state))


def _validate_envelope(state: JsonObject, event: JsonObject) -> None:
    schema_errors = validate_event(event)
    if schema_errors:
        raise _fail(event, "INVALID_EVENT", "; ".join(schema_errors))
    if event.get("campaign_id") != state.get("campaign_id"):
        raise _fail(event, "CAMPAIGN_MISMATCH", "El evento pertenece a otra campaña.")
    if event.get("branch_id") != state.get("branch_id"):
        raise _fail(event, "BRANCH_MISMATCH", "El evento pertenece a otra rama.")
    applied = state.get("applied_event_ids")
    if isinstance(applied, list) and event.get("event_id") in applied:
        raise _fail(event, "DUPLICATE_EVENT", "El event_id ya fue aplicado.")
    if event.get("base_state_version") != state.get("state_version"):
        raise _fail(event, "STALE_STATE_VERSION", "La versión base no coincide.")
    base_version = event.get("base_state_version")
    committed_version = event.get("committed_state_version")
    if not _integer(base_version) or committed_version != base_version + 1:
        raise _fail(event, "VERSION_SEQUENCE_INVALID", "La versión debe avanzar una unidad.")


def _character(state: JsonObject, event: JsonObject) -> JsonObject:
    payload = event["payload"]
    character_id = payload.get("character_id")
    characters = state.get("characters")
    value = characters.get(character_id) if isinstance(characters, dict) else None
    if not isinstance(character_id, str) or not isinstance(value, dict):
        raise _fail(event, "UNRESOLVED_REFERENCE", "El personaje objetivo no existe.")
    return value


def _inventory(state: JsonObject, event: JsonObject, field: str) -> JsonObject:
    payload = event["payload"]
    inventory_id = payload.get(field)
    inventories = state.get("inventories")
    value = inventories.get(inventory_id) if isinstance(inventories, dict) else None
    if not isinstance(inventory_id, str) or not isinstance(value, dict):
        raise _fail(event, "UNRESOLVED_REFERENCE", f"El inventario {field} no existe.")
    return value


def _item(value: Any) -> bool:
    return isinstance(value, dict) and (
        isinstance(value.get("item_instance_id"), str)
        and isinstance(value.get("template_id"), str)
        and isinstance(value.get("name"), str)
        and _integer(value.get("quantity"))
        and isinstance(value.get("owner_id"), str)
        and _number(value.get("weight_each"))
        and isinstance(value.get("provenance"), list)
        and isinstance(value.get("effects"), list)
    )


def _change_counter(event: JsonObject, record: Any, field: str, maximum: Any = 9007199254740991) -> None:
    delta = event['payload'].get('delta')
    if (not isinstance(record, dict) or not _integer(record.get(field))
            or not _integer(delta) or not delta or abs(delta) > 9007199254740991
            or abs(record[field]) > 9007199254740991 or not _integer(maximum)
            or maximum < 0 or maximum > 9007199254740991):
        raise _fail(event, 'INVALID_EVENT', 'Contador o delta inválido.')
    result = record[field] + delta
    if result < 0 or result > maximum or result > 9007199254740991:
        raise _fail(event, 'INVARIANT_VIOLATION', 'Contador fuera de límites.')
    record[field] = result


def _remaining_event(state: JsonObject, event: JsonObject) -> bool:
    kind, p = event['event_type'], event['payload']
    if kind in ('ITEM_CHARGES_CHANGED', 'CURRENCY_CHANGED'):
        inventory = _inventory(state, event, 'inventory_id')
        if kind == 'ITEM_CHARGES_CHANGED':
            item = next((item for item in inventory['items'] if item['item_instance_id'] == p.get('item_instance_id')), None)
            if item is None or item.get('charges_current') is None or item.get('charges_max') is None:
                raise _fail(event, 'UNRESOLVED_REFERENCE', 'Objeto con cargas no registrado.')
            _change_counter(event, item, 'charges_current', item['charges_max'])
        else:
            currency, delta = p.get('currency'), p.get('delta')
            if not isinstance(currency, str) or currency not in inventory['currencies']:
                raise _fail(event, 'UNRESOLVED_REFERENCE', 'Moneda no registrada.')
            current = inventory['currencies'][currency]
            if not _number(current) or not _number(delta) or delta == 0:
                raise _fail(event, 'INVALID_EVENT', 'Moneda o delta inválido.')
            result = current + delta
            if not math.isfinite(result) or result < 0 or result > 9007199254740991:
                raise _fail(event, 'INVARIANT_VIOLATION', 'Saldo inválido.')
            inventory['currencies'][currency] = result
        inventory['version'] += 1
        return True
    if kind == 'FACTION_CLOCK_CHANGED':
        faction_id, clock_id = p.get('faction_id'), p.get('clock_id')
        faction = state['factions'].get(faction_id) if isinstance(faction_id, str) else None
        clocks = faction.get('clocks') if isinstance(faction, dict) else None
        clock = clocks.get(clock_id) if isinstance(clocks, dict) and isinstance(clock_id, str) else None
        if not isinstance(clock, dict):
            raise _fail(event, 'UNRESOLVED_REFERENCE', 'Reloj de facción no registrado.')
        _change_counter(event, clock, 'current', clock.get('maximum'))
        return True
    if kind == 'RULE_RULING_RECORDED':
        keys = {'ruling_id', 'question', 'answer', 'source_refs', 'errata_status', 'scope', 'campaign_id', 'created_at', 'supersedes'}
        strings = keys - {'source_refs', 'supersedes'}
        refs = p.get('source_refs')
        if (set(p) != keys or not all(isinstance(p.get(key), str) and p[key] for key in strings)
                or p['campaign_id'] != state['campaign_id'] or not isinstance(refs, list)
                or not all(isinstance(ref, str) for ref in refs) or len(set(refs)) != len(refs)
                or set(refs) != set(event['source_refs']) or len(refs) != len(event['source_refs'])
                or p['ruling_id'] in state['canon']['rulings']
                or (p['supersedes'] is not None and (not isinstance(p['supersedes'], str)
                    or p['supersedes'] not in state['canon']['rulings']))):
            raise _fail(event, 'INVALID_EVENT', 'Ruling incompleto o sin procedencia.')
        try:
            datetime.fromisoformat(p['created_at'].replace('Z', '+00:00'))
        except ValueError as error:
            raise _fail(event, 'INVALID_EVENT', 'Fecha de ruling inválida.') from error
        state['canon']['rulings'][p['ruling_id']] = copy.deepcopy(p)
        return True
    if kind not in ('NONLETHAL_CHANGED', 'XP_CHANGED', 'DAILY_USE_CHANGED', 'CONDITION_ADDED',
                    'CONDITION_REMOVED', 'LEVEL_CHANGED', 'RELATIONSHIP_CHANGED', 'CHARACTER_DIED'):
        return False
    sheet = _character(state, event)['sheet']
    if kind == 'NONLETHAL_CHANGED':
        _change_counter(event, sheet.get('health'), 'nonlethal_damage')
    elif kind == 'XP_CHANGED':
        _change_counter(event, sheet.get('advancement'), 'xp')
    elif kind == 'DAILY_USE_CHANGED':
        uses, use_id = sheet.get('daily_uses'), p.get('use_id')
        use = uses.get(use_id) if isinstance(uses, dict) and isinstance(use_id, str) else None
        if not isinstance(use, dict):
            raise _fail(event, 'UNRESOLVED_REFERENCE', 'Uso diario no registrado.')
        _change_counter(event, use, 'current', use.get('maximum'))
    elif kind in ('CONDITION_ADDED', 'CONDITION_REMOVED'):
        conditions, value = sheet.get('conditions'), p.get('condition')
        condition_id = value.get('condition_id') if kind == 'CONDITION_ADDED' and isinstance(value, dict) else p.get('condition_id')
        if (not isinstance(conditions, list) or not all(isinstance(item, dict) for item in conditions)
                or not isinstance(condition_id, str) or not condition_id):
            raise _fail(event, 'INVALID_EVENT', 'Condición inválida.')
        index = next((i for i, item in enumerate(conditions) if item.get('condition_id') == condition_id), -1)
        if kind == 'CONDITION_ADDED':
            if not isinstance(value, dict) or not isinstance(value.get('name'), str) or not value['name'] or index >= 0:
                raise _fail(event, 'INVALID_EVENT', 'Condición incompleta o duplicada.')
            conditions.append(copy.deepcopy(value))
        else:
            if index < 0:
                raise _fail(event, 'UNRESOLVED_REFERENCE', 'Condición no aplicada.')
            conditions.pop(index)
    elif kind == 'LEVEL_CHANGED':
        advancement, name, delta = sheet.get('advancement'), p.get('class_name'), p.get('delta')
        if (not isinstance(advancement, dict) or not isinstance(advancement.get('classes'), list)
                or not isinstance(name, str) or not name or not _integer(delta) or delta not in (1, -1)):
            raise _fail(event, 'INVALID_EVENT', 'Nivel requiere clase y cambio unitario.')
        classes = advancement['classes']
        if (not all(isinstance(item, dict) and isinstance(item.get('name'), str)
                    and _integer(item.get('level')) and 0 < item['level'] <= 9007199254740991 for item in classes)
                or len({item['name'] for item in classes}) != len(classes)
                or sum(item['level'] for item in classes) != advancement.get('level')):
            raise _fail(event, 'INVALID_EVENT', 'Progresión de clases incoherente.')
        index = next((i for i, item in enumerate(classes) if item['name'] == name), -1)
        if index < 0 and delta < 0:
            raise _fail(event, 'UNRESOLVED_REFERENCE', 'Clase no registrada.')
        _change_counter(event, advancement, 'level')
        if index < 0:
            classes.append({'name': name, 'level': 1, 'source_ref': event['source_refs'][0]})
        else:
            classes[index]['level'] += delta
            if classes[index]['level'] == 0:
                classes.pop(index)
    elif kind == 'RELATIONSHIP_CHANGED':
        relationships, target_id, value = sheet.get('relationships'), p.get('target_id'), p.get('value')
        if (not isinstance(relationships, list) or not all(isinstance(item, dict) for item in relationships)
                or not isinstance(target_id, str) or target_id not in state['characters']
                or not isinstance(value, dict) or not value):
            raise _fail(event, 'INVALID_EVENT', 'Relación o personaje inválido.')
        index = next((i for i, item in enumerate(relationships) if item.get('target_id') == target_id), -1)
        entry = {**copy.deepcopy(value), 'target_id': target_id}
        if index < 0:
            relationships.append(entry)
        else:
            relationships[index] = entry
    elif kind == 'CHARACTER_DIED':
        health = sheet.get('health')
        if (not isinstance(health, dict) or health.get('death_state') not in ('alive', 'disabled', 'dying', 'stable')
                or p.get('death_state') not in ('dead', 'destroyed') or not isinstance(p.get('reason'), str) or not p['reason']):
            raise _fail(event, 'INVALID_EVENT', 'Estado de muerte inválido.')
        health['death_state'] = p['death_state']
    return True


def _health_state(hp: float) -> str:
    return 'alive' if hp > 0 else 'disabled' if hp == 0 else 'dying' if hp >= -9 else 'dead'


def _health_damage(state: JsonObject, event: JsonObject) -> None:
    payload = event['payload']
    if validate_contract('internal/health-change-v1.schema.json', payload):
        raise _fail(event, 'INVALID_EVENT', 'Payload de salud versionado inválido.')
    sheet = _character(state, event)['sheet']
    health = sheet.get('health')
    if 'hit_points' in sheet or not isinstance(health, dict) or validate_health(health):
        raise _fail(event, 'INVALID_EVENT', 'Se requiere una única autoridad health conforme al SOT.')
    current, maximum = health['hp_current'], health['hp_max']
    # The SOT schema above validates numeric types. Bound before float conversion;
    # Python's arbitrary integers may be larger than a float or a JS safe integer.
    if (not -9007199254740991 <= current <= 9007199254740991
            or not 1 <= maximum <= 9007199254740991
            or not float(current).is_integer() or not float(maximum).is_integer() or current > maximum
            or health['temporary_hp'] != 0 or health['nonlethal_damage'] != 0
            or health['death_state'] != _health_state(current) or health['death_state'] == 'dead'
            or payload['before_hp'] != current or payload['before_death_state'] != health['death_state']
            or abs(current + payload['delta']) > 9007199254740991
            or payload['after_hp'] != current + payload['delta']
            or payload['after_death_state'] != _health_state(payload['after_hp'])
            or event['targets'] != [payload['character_id']]):
        raise _fail(event, 'INVALID_EVENT', 'Salud inconsistente o transición no soportada.')
    health['hp_current'] = payload['after_hp']
    health['death_state'] = payload['after_death_state']


def _reduce(state: JsonObject, event: JsonObject) -> None:
    if _remaining_event(state, event):
        return
    event_type = event["event_type"]
    payload = event["payload"]
    if event_type == "HP_CHANGED":
        character_id = payload.get('character_id')
        if not isinstance(character_id, str) or character_id not in state['characters']:
            raise _fail(event, 'UNRESOLVED_REFERENCE', 'El personaje objetivo no existe.')
        target = _character(state, event)
        sheet = target.get("sheet")
        # Legacy metadata is not a format discriminator; the sheet owns health.
        if isinstance(sheet, dict) and 'health' in sheet:
            _health_damage(state, event)
            return
        delta = payload.get("delta")
        hit_points = sheet.get("hit_points") if isinstance(sheet, dict) else None
        if not _number(delta) or not isinstance(hit_points, dict):
            raise _fail(event, "INVALID_EVENT", "HP_CHANGED requiere delta y hit_points.")
        current = hit_points.get("current")
        maximum = hit_points.get("maximum")
        if not _number(current) or not _number(maximum):
            raise _fail(event, "INVALID_EVENT", "hit_points no es numérico.")
        next_hit_points = float(current) + float(delta)
        if not math.isfinite(next_hit_points) or next_hit_points > float(maximum):
            raise _fail(event, "INVARIANT_VIOLATION", "Los puntos de golpe son inválidos.")
        hit_points["current"] = (
            int(next_hit_points) if next_hit_points.is_integer() else next_hit_points
        )
        return
    if event_type in ("SPELL_SLOT_USED", "SPELL_SLOT_RESTORED"):
        target = _character(state, event)
        spell_level = payload.get("spell_level")
        delta = payload.get("delta")
        sheet = target.get("sheet")
        spell_slots = sheet.get("spell_slots") if isinstance(sheet, dict) else None
        if (
            not _integer(spell_level)
            or spell_level < 0
            or not _integer(delta)
            or abs(delta) > 9007199254740991
            or (delta >= 0 if event_type == 'SPELL_SLOT_USED' else delta <= 0)
            or not isinstance(spell_slots, dict)
        ):
            raise _fail(
                event,
                "INVALID_EVENT",
                "SPELL_SLOT_USED requiere nivel, delta negativo y spell_slots válidos.",
            )
        slot = spell_slots.get(str(spell_level))
        if not isinstance(slot, dict):
            raise _fail(
                event,
                "UNRESOLVED_REFERENCE",
                "El nivel de spell slot no existe en la ficha.",
            )
        current = slot.get("current")
        maximum = slot.get("maximum")
        if not _integer(current) or not _integer(maximum):
            raise _fail(
                event,
                "INVALID_EVENT",
                "El spell slot debe contener current y maximum enteros.",
            )
        next_slot = current + delta
        if next_slot < 0 or next_slot > maximum:
            raise _fail(
                event,
                "INVARIANT_VIOLATION",
                "El consumo excede los spell slots disponibles.",
            )
        slot["current"] = next_slot
        return
    if event_type == "LOCATION_CHANGED":
        origin = payload.get("from_location_id")
        destination = payload.get("to_location_id")
        travelers = payload.get("character_ids")
        scene = payload.get("scene")
        if (
            not isinstance(origin, str) or not origin
            or not isinstance(destination, str) or not destination or destination == origin
            or state["world"].get("location_id") != origin or state["scene"].get("location_id") != origin
            or not isinstance(travelers, list) or not travelers
            or not all(isinstance(item, str) for item in travelers) or len(set(travelers)) != len(travelers)
            or not isinstance(scene, dict) or scene.get("location_id") != destination
            or not isinstance(scene.get("summary"), str) or not scene["summary"]
            or not isinstance(scene.get("present_character_ids"), list)
            or not isinstance(scene.get("immediate_threats"), list) or not isinstance(scene.get("open_questions"), list)
        ):
            raise _fail(event, "INVALID_EVENT", "LOCATION_CHANGED requiere origen, destino y escena completos.")
        present = scene["present_character_ids"]
        if (
            not all(isinstance(item, str) and item in state["characters"] for item in present)
            or len(set(present)) != len(present)
            or any(item not in state["characters"] or item not in present
                   or state["characters"][item]["sheet"].get("location_id", origin) != origin for item in travelers)
        ):
            raise _fail(event, "UNRESOLVED_REFERENCE", "Participantes del viaje incoherentes.")
        for character_id in travelers:
            state["characters"][character_id]["sheet"]["location_id"] = destination
        state["world"]["location_id"] = destination
        state["scene"] = copy.deepcopy(scene)
        return
    if event_type == "TIME_ADVANCED":
        minutes = payload.get("minutes")
        world = state.get("world")
        if not _integer(minutes) or minutes <= 0 or not isinstance(world, dict):
            raise _fail(event, "INVALID_EVENT", "TIME_ADVANCED requiere minutos positivos.")
        elapsed = world.get("elapsed_minutes")
        if not _integer(elapsed):
            raise _fail(event, "INVALID_EVENT", "elapsed_minutes es inválido.")
        world["elapsed_minutes"] = elapsed + minutes
        return
    if event_type == "DICE_ROLLED":
        expression = payload.get("expression")
        rng = state.get("rng")
        if not isinstance(expression, str) or not isinstance(rng, dict):
            raise _fail(event, "INVALID_EVENT", "DICE_ROLLED requiere expresión y RNG.")
        try:
            dice_result = roll_dice(rng, expression)
        except ValueError as error:
            raise _fail(event, "INVALID_EVENT", f"DICE_ROLLED inválido: {error}.") from error
        if payload != dice_result["record"]:
            raise _fail(event, "INVARIANT_VIOLATION", "La tirada no coincide con el RNG.")
        state["rng"] = dice_result["next_rng"]
        return
    if event_type == "CANON_FACT_ADDED":
        fact_id = payload.get("fact_id")
        canon = state.get("canon")
        facts = canon.get("facts") if isinstance(canon, dict) else None
        if not isinstance(fact_id, str) or not fact_id or "value" not in payload or not isinstance(facts, dict):
            raise _fail(event, "INVALID_EVENT", "CANON_FACT_ADDED requiere fact_id y value.")
        if fact_id in facts:
            raise _fail(event, "INVARIANT_VIOLATION", "El fact_id ya existe.")
        facts[fact_id] = copy.deepcopy(payload["value"])
        return
    if event_type == "QUEST_UPDATED":
        quest_id = payload.get("quest_id")
        value = payload.get("value")
        quests = state.get("quests")
        if (
            not isinstance(quest_id, str)
            or not isinstance(quests, dict)
            or quest_id not in quests
        ):
            raise _fail(
                event,
                "UNRESOLVED_REFERENCE",
                "QUEST_UPDATED requiere una quest existente.",
            )
        if not isinstance(value, dict):
            raise _fail(event, "INVALID_EVENT", "QUEST_UPDATED requiere un valor objeto.")
        quests[quest_id] = copy.deepcopy(value)
        return
    if event_type == "ITEM_ACQUIRED":
        destination = _inventory(state, event, "inventory_id")
        item = payload.get("item")
        if (
            not _item(item)
            or item["quantity"] <= 0
            or item["owner_id"] != destination.get("owner_id")
        ):
            raise _fail(event, "INVALID_EVENT", "ITEM_ACQUIRED contiene un item inválido.")
        inventories = state["inventories"]
        if any(
            candidate.get("item_instance_id") == item["item_instance_id"]
            for inventory in inventories.values()
            if isinstance(inventory, dict)
            for candidate in inventory.get("items", [])
            if isinstance(candidate, dict)
        ):
            raise _fail(event, "INVARIANT_VIOLATION", "item_instance_id ya existe.")
        destination["items"].append(copy.deepcopy(item))
        destination["version"] += 1
        _recalculate_weight(destination)
        return
    if event_type == "ITEM_TRANSFERRED":
        origin = _inventory(state, event, "from_inventory_id")
        destination = _inventory(state, event, "to_inventory_id")
        item_id = payload.get("item_instance_id")
        quantity = payload.get("quantity")
        if not isinstance(item_id, str) or not _integer(quantity) or quantity <= 0:
            raise _fail(event, "INVALID_EVENT", "ITEM_TRANSFERRED requiere item y cantidad.")
        items = origin["items"]
        item_index = next(
            (index for index, item in enumerate(items) if item.get("item_instance_id") == item_id),
            None,
        )
        if item_index is None:
            raise _fail(event, "UNRESOLVED_REFERENCE", "El item origen no existe.")
        item = items[item_index]
        if quantity > item["quantity"]:
            raise _fail(event, "INVARIANT_VIOLATION", "La transferencia excede la cantidad.")
        new_item_id = payload.get("new_item_instance_id")
        if quantity < item["quantity"] and not isinstance(new_item_id, str):
            raise _fail(event, "INVALID_EVENT", "La transferencia parcial requiere nuevo ID.")
        full_transfer = quantity == item["quantity"]
        if full_transfer:
            items.pop(item_index)
        else:
            item["quantity"] -= quantity
        moved = copy.deepcopy(item)
        moved["item_instance_id"] = moved["item_instance_id"] if full_transfer else new_item_id
        moved["quantity"] = quantity
        moved["owner_id"] = destination["owner_id"]
        moved["container_id"] = None
        moved["equipped_slot"] = None
        destination["items"].append(moved)
        origin["version"] += 1
        destination["version"] += 1
        _recalculate_weight(origin)
        _recalculate_weight(destination)
        return
    if event_type == "ITEM_CONSUMED":
        source = _inventory(state, event, "inventory_id")
        item_id = payload.get("item_instance_id")
        quantity = payload.get("quantity")
        if not isinstance(item_id, str) or not _integer(quantity) or quantity <= 0:
            raise _fail(event, "INVALID_EVENT", "ITEM_CONSUMED requiere item y cantidad.")
        items = source["items"]
        item_index = next(
            (index for index, item in enumerate(items) if item.get("item_instance_id") == item_id),
            None,
        )
        if item_index is None:
            raise _fail(event, "UNRESOLVED_REFERENCE", "El item consumido no existe.")
        item = items[item_index]
        if quantity > item["quantity"]:
            raise _fail(event, "INVARIANT_VIOLATION", "El consumo excede la cantidad.")
        if (
            quantity == item["quantity"]
            and item.get("quest_item") is True
            and payload.get("authorized_quest_item_removal") is not True
        ):
            raise _fail(event, "INVARIANT_VIOLATION", "Quest item sin autorización.")
        item["quantity"] -= quantity
        if item["quantity"] == 0:
            items.pop(item_index)
        source["version"] += 1
        _recalculate_weight(source)
        return
    if event_type == "NPC_PROMOTED":
        target = _character(state, event)
        full_sheet = payload.get("full_sheet")
        if (
            target.get("kind") != "npc"
            or target.get("detail") != "lite"
            or not isinstance(full_sheet, dict)
            or not full_sheet
        ):
            raise _fail(event, "INVALID_EVENT", "NPC_PROMOTED requiere NPC lite y ficha full.")
        target["detail"] = "full"
        target["sheet"] = copy.deepcopy(full_sheet)
        return
    if event_type in ("NPC_KNOWLEDGE_ADDED", "NPC_BELIEF_CHANGED"):
        namespace = "knowledge" if event_type == "NPC_KNOWLEDGE_ADDED" else "beliefs"
        id_field = "knowledge_id" if event_type == "NPC_KNOWLEDGE_ADDED" else "belief_id"
        subject_id = payload.get("subject_id")
        record_id = payload.get(id_field)
        characters = state.get("characters")
        if (
            not isinstance(subject_id, str)
            or not isinstance(characters, dict)
            or subject_id not in characters
            or not isinstance(record_id, str)
            or "value" not in payload
        ):
            raise _fail(event, "UNRESOLVED_REFERENCE", f"{event_type} contiene referencias inválidas.")
        records_by_subject = state[namespace]
        records = records_by_subject.setdefault(subject_id, {})
        if event_type == "NPC_KNOWLEDGE_ADDED" and record_id in records:
            raise _fail(event, "INVARIANT_VIOLATION", "ADDED no sobrescribe conocimiento existente.")
        value = payload["value"]
        if isinstance(value, dict) and "secret_id" in value:
            secret_id = value["secret_id"]
            if not isinstance(secret_id, str) or secret_id not in state["canon"]["secrets"]:
                raise _fail(event, "UNRESOLVED_REFERENCE", "El secreto referenciado no existe en canon.")
        records[record_id] = copy.deepcopy(payload["value"])
        return
    raise _fail(event, "UNSUPPORTED_EVENT", f"No existe reducer para {event_type}.")


def apply_event(state: JsonObject, event: JsonObject) -> JsonObject:
    _validate_envelope(state, event)
    candidate = copy.deepcopy(state)
    _reduce(candidate, event)
    invariant_errors = _invariant_errors(candidate)
    if invariant_errors:
        raise _fail(event, "INVARIANT_VIOLATION", "; ".join(invariant_errors))
    candidate["applied_event_ids"].append(event["event_id"])
    candidate["state_version"] = event["committed_state_version"]
    return candidate


def replay_events(state: JsonObject, events: list[JsonObject]) -> JsonObject:
    initial_errors = validate_state(state)
    if initial_errors:
        raise ValueError(f"INVALID_STATE: {'; '.join(initial_errors)}")
    current = copy.deepcopy(state)
    for event_index, event in enumerate(events):
        try:
            current = apply_event(current, event)
        except StateError as error:
            raise StateError(error.code, error.event_id, error.message, event_index) from error
    final_errors = validate_state(current)
    if final_errors:
        raise ValueError(f"INVALID_STATE: {'; '.join(final_errors)}")
    return current
