"""Deterministic Dice Engine compatible with CPython Random and TypeScript."""

from __future__ import annotations

import hashlib
import random
import re
from typing import Any, TypeGuard

ALGORITHM = "sha256-seeded-python-random"
EXPRESSION = re.compile(r"^([1-9]\d*)d([1-9]\d*)([+-]\d+)?$")


def _integer(value: object) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool)


def roll_dice(state: dict[str, Any], expression: str) -> dict[str, Any]:
    algorithm = state.get("algorithm")
    campaign_seed = state.get("campaign_seed")
    roll_index = state.get("roll_index")
    if (
        algorithm != ALGORITHM
        or not isinstance(campaign_seed, str)
        or not campaign_seed
        or not _integer(roll_index)
        or roll_index < 0
        or roll_index > 9_007_199_254_740_991
    ):
        raise ValueError("INVALID_DICE_STATE")
    match = EXPRESSION.fullmatch(expression)
    if match is None:
        raise ValueError("INVALID_DICE_EXPRESSION")
    count = int(match.group(1))
    sides = int(match.group(2))
    modifier = int(match.group(3) or "0")
    if count > 1000 or sides < 2 or sides > 1_000_000 or abs(modifier) > 9_007_199_254_740_991:
        raise ValueError("DICE_LIMIT_EXCEEDED")

    material = f"{campaign_seed}:{roll_index}:{count}d{sides}".encode()
    seed = int.from_bytes(hashlib.sha256(material).digest(), byteorder="big")
    generator = random.Random(seed)
    rolls = [generator.randrange(sides) + 1 for _ in range(count)]
    record = {
        "algorithm": algorithm,
        "campaign_seed": campaign_seed,
        "roll_index": roll_index,
        "expression": expression,
        "count": count,
        "sides": sides,
        "modifier": modifier,
        "rolls": rolls,
        "total": sum(rolls, modifier),
    }
    return {
        "record": record,
        "next_rng": {**state, "roll_index": roll_index + 1},
    }
