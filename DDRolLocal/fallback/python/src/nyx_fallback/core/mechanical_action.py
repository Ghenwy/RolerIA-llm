"""Same explicit-action boundary as TypeScript; schemas remain the runtime authority."""

from __future__ import annotations

import copy
import re
from collections.abc import Sequence
from typing import Any

from jsonschema import Draft202012Validator

from .contracts import _load_schema, validate_contract

JsonObject = dict[str, Any]
CONTRACT = "internal/mechanical-action-v1.schema.json"


def _at(value: Any, keys: Sequence[str]) -> Any:
    for key in keys:
        if key in {"__proto__", "constructor", "prototype"} or not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def _parts(expression: str) -> tuple[int, int, int] | None:
    match = re.fullmatch(r"([1-9][0-9]*)d([1-9][0-9]*)([+-][0-9]+)?", expression)
    if not match:
        return None
    count, sides, modifier = int(match[1]), int(match[2]), int(match[3] or 0)
    if count > 1000 or not 2 <= sides <= 1_000_000 or abs(modifier) > 9007199254740991:
        return None
    return count, sides, modifier


def prepare_mechanical_action(
    state: JsonObject, campaign_id: str, turn_id: str, base_version: int, player_input: str
) -> JsonObject | None:
    if state.get("campaign_id") != campaign_id or state.get("state_version") != base_version:
        raise ValueError("MECHANICAL_STATE_STALE")
    selected = re.match(r"^/action ([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(?:\s|$)", player_input)
    if not selected:
        if player_input.startswith("/action"):
            raise ValueError("MECHANICAL_ACTION_INVALID")
        return None
    profile = copy.deepcopy(_at(state, ["world", "mechanical_actions", selected[1]]))
    schema = _load_schema(CONTRACT)
    validator = Draft202012Validator({"$schema": schema["$schema"], "$defs": schema["$defs"],
                                     "$ref": "#/$defs/MechanicalActionProfile"})
    if not validator.is_valid(profile):
        raise ValueError("MECHANICAL_ACTION_UNREGISTERED")
    if profile["action_id"] != selected[1] or _at(state, ["characters", profile["actor_id"], "kind"]) != "player":
        raise ValueError("MECHANICAL_ACTOR_INVALID")
    if not isinstance(_at(state, ["world", "mechanical_targets", profile["target_id"]]), dict):
        raise ValueError("MECHANICAL_TARGET_UNCONFIRMED")  # noqa: TRY004 -- Persisted-data failure uses the workflow's domain-error contract.
    action: JsonObject = {
        "schema_version": "1.0", "campaign_id": campaign_id, "branch_id": state["branch_id"],
        "turn_id": turn_id, "base_state_version": base_version,
        "base_rng_counter": state["rng"]["roll_index"], "profile": profile,
        "parameters": {key: _at(state, refs) for key, refs in profile["parameter_refs"].items()},
        "rolls": [], "next_roll": None, "outcome": None, "narration": None,
    }
    if validate_contract(CONTRACT, action) or not _parts(action["parameters"]["damage_expression"]):
        raise ValueError("MECHANICAL_PARAMETERS_UNCONFIRMED")
    return action


def advance_mechanical_action(action: JsonObject, rolls: Sequence[JsonObject]) -> JsonObject:
    if validate_contract(CONTRACT, action):
        raise ValueError("MECHANICAL_CONTRACT_INVALID")
    frame = {**copy.deepcopy(action), "rolls": copy.deepcopy(list(rolls)),
             "next_roll": None, "outcome": None, "narration": None}
    if validate_contract(CONTRACT, frame):
        raise ValueError("MECHANICAL_ROLL_MISMATCH")
    p = action["parameters"]
    bonus = p["attack_bonus"]
    expression = f"1d20{bonus:+d}" if bonus else "1d20"
    index = 0

    def consume(stage: str, dice_expression: str) -> int | None:
        nonlocal index
        request = {"roll_id": f"ROLL-{action['turn_id']}-{stage}", "expression": dice_expression}
        if index == len(rolls):
            frame["next_roll"] = request
            return None
        rolled = rolls[index]
        parts = _parts(dice_expression)
        if not parts:
            raise ValueError("MECHANICAL_ROLL_MISMATCH")
        count, sides, modifier = parts
        total = rolled.get("result")
        if (rolled.get("roll_id") != request["roll_id"] or rolled.get("expression") != dice_expression
                or rolled.get("rng_counter") != action["base_rng_counter"] + index
                or type(total) is not int or not count + modifier <= total <= count * sides + modifier):
            raise ValueError("MECHANICAL_ROLL_MISMATCH")
        index += 1
        return total

    total = consume("attack", expression)
    if total is None:
        return frame
    natural = total - bonus
    hits = natural == 20 or (natural != 1 and total >= p["armor_class"])
    critical = False
    if hits and natural >= p["critical_threshold"] and not p["critical_immune"]:
        confirmation = consume("confirm", expression)
        if confirmation is None:
            return frame
        critical = confirmation - bonus == 20 or (confirmation - bonus != 1 and confirmation >= p["armor_class"])
    damage = 0
    if hits:
        for number in range(1, (p["critical_multiplier"] if critical else 1) + 1):
            rolled_damage = consume("damage" if number == 1 else f"damage-{number}", p["damage_expression"])
            if rolled_damage is None:
                return frame
            damage += rolled_damage
    if index != len(rolls):
        raise ValueError("MECHANICAL_EXTRA_ROLL")
    if not 0 <= damage <= 9007199254740991:
        raise ValueError("MECHANICAL_DAMAGE_UNSUPPORTED")
    frame["outcome"] = {"attack_total": total, "natural_attack": natural, "hits": hits,
                        "critical_confirmed": critical, "damage_total": damage,
                        "effect": "CALCULATE_DAMAGE_ONLY"}
    narration = f"El ataque obtiene {total} frente a CA {p['armor_class']} y {'acierta' if hits else 'falla'}."
    if hits:
        narration += f" {'Crítico confirmado; daño' if critical else 'Daño'} calculado: {damage}."
    frame["narration"] = narration + " Esta acción registra el cálculo, sin modificar puntos de golpe."
    return frame


def validate_mechanical_candidate(frame: JsonObject | None, candidate: JsonObject) -> None:
    proposed = candidate.get('events_to_commit')
    if isinstance(proposed, list) and any(
        isinstance(event, dict) and event.get('event_type') == 'HP_CHANGED'
        and isinstance(event.get('payload'), dict)
        and event['payload'].get('kind') == 'WEAPON_DAMAGE'
        for event in proposed
    ):
        raise ValueError('MECHANICAL_EFFECT_MUST_BE_CODE_GENERATED')
    status = candidate.get("resolution_status")
    if frame is None:
        if status == "AWAITING_ROLL" or candidate.get("required_rolls"):
            raise ValueError("MECHANICAL_ACTION_REQUIRED")
        return
    if status in {"BLOCKED", "AWAITING_WORKER"}:
        return
    if frame["next_roll"] is not None:
        if status != "AWAITING_ROLL" or candidate.get("required_rolls") != [frame["next_roll"]]:
            raise ValueError("MECHANICAL_REQUIRED_ROLL")
        return
    if (status != "READY" or frame["outcome"] is None or candidate.get("player_facing_narration") != frame["narration"]
            or any(candidate.get(key) != [] for key in ("required_rolls", "events_to_commit", "patches_to_commit"))):
        raise ValueError("MECHANICAL_RECEIPT_MISMATCH")
