# GENERATED FILE - DO NOT EDIT. source=sot/d-d-3-5-character-extension.schema.json schema_sha256=596866eefba49d012055d2281726f94d7ca85d263d0f636fe3a506cc625098c1

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, conint


class Model(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    ruleset_id: Literal['dnd35_srd_ogc']
    race_option_id: str
    race_tags: list[str]
    racial_hit_dice: conint(ge=0)
    class_levels: list[dict[str, Any]]
    prestige_levels: list[dict[str, Any]]
    level_adjustment: conint(ge=0)
    total_hd: conint(ge=1)
    class_level_total: conint(ge=0)
    ecl: conint(ge=1)
    bab: int
    saves: dict[str, Any]
    armor_class: dict[str, Any]
    grapple: int
    initiative: int
    speed: dict[str, Any]
    spellcasting: list[dict[str, Any]]
    manifesting: list[dict[str, Any]]
    feats: list[dict[str, Any]]
    skills: list[dict[str, Any]]
    conditions: list[dict[str, Any]]
    source_refs: list[str]
