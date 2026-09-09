# GENERATED FILE - DO NOT EDIT. source=sot/dnd35-character-sheet.schema.json schema_sha256=2ceb0ede44982b338a29913b176fdcfe8077fbfeac7cbef570b389b7e2be8c72

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, conint, constr


class EntityType(Enum):
    player_character = 'player_character'
    npc_full = 'npc_full'
    npc_lite = 'npc_lite'
    creature = 'creature'


class Identity(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    player_name: str | None
    race: str
    alignment: str
    deity: str | None
    size: str
    age: int | None
    gender: str | None
    languages: list[str]
    public_description: str


class Class(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    name: str
    level: conint(ge=1)
    source_ref: str | None = None


class Advancement(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    level: conint(ge=0)
    xp: conint(ge=0)
    classes: list[Class]


class Str(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    score: int
    temporary_score: int | None
    modifier: int


class Dex(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    score: int
    temporary_score: int | None
    modifier: int


class Con(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    score: int
    temporary_score: int | None
    modifier: int


class Int(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    score: int
    temporary_score: int | None
    modifier: int


class Wis(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    score: int
    temporary_score: int | None
    modifier: int


class Cha(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    score: int
    temporary_score: int | None
    modifier: int


class Abilities(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    str: Str
    dex: Dex
    con: Con
    int: Int
    wis: Wis
    cha: Cha


class DeathState(Enum):
    alive = 'alive'
    disabled = 'disabled'
    dying = 'dying'
    stable = 'stable'
    dead = 'dead'
    destroyed = 'destroyed'


class Health(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    hp_max: int
    hp_current: int
    temporary_hp: conint(ge=0)
    nonlethal_damage: conint(ge=0)
    hit_dice: list[str]
    death_state: DeathState


class Defense(BaseModel):
    model_config = ConfigDict(
        extra='allow',
    )
    ac: int
    touch_ac: int
    flat_footed_ac: int


class Combat(BaseModel):
    model_config = ConfigDict(
        extra='allow',
    )
    initiative: int
    base_attack_bonus: int
    grapple: int
    speed: dict[str, Any]
    attacks: list[dict[str, Any]]


class Saves(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    fortitude: int
    reflex: int
    will: int


class Features(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    feats: list[dict[str, Any]]
    class_features: list[dict[str, Any]]
    racial_traits: list[dict[str, Any]]
    special_abilities: list[dict[str, Any]]


class Magic(BaseModel):
    model_config = ConfigDict(
        extra='allow',
    )
    caster_profiles: list[dict[str, Any]]
    active_effects: list[dict[str, Any]]


class Status(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    active: bool
    present_in_scene: bool
    last_seen_at: str | None


class DND35CharacterSheet(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    character_id: str
    entity_type: EntityType
    name: constr(min_length=1)
    ruleset: Literal['dnd35']
    version: conint(ge=1)
    identity: Identity
    advancement: Advancement
    abilities: Abilities
    health: Health
    defense: Defense
    combat: Combat
    saves: Saves
    skills: list[dict[str, Any]]
    features: Features
    magic: Magic
    conditions: list[dict[str, Any]]
    inventory_ref: str
    location_id: str
    knowledge: list[dict[str, Any]]
    beliefs: list[dict[str, Any]]
    secrets: list[dict[str, Any]]
    relationships: list[dict[str, Any]]
    status: Status
