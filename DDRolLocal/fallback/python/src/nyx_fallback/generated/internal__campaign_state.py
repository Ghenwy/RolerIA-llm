# GENERATED FILE - DO NOT EDIT. source=internal/campaign-state.schema.json schema_sha256=b187466f2634d1104a51612aefe8ef8c2a5c78bc28f58b77445426129af9622d

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, RootModel, conint, constr


class AppliedEventId(
    RootModel[constr(pattern=r'^EV(?:ENT)?-[A-Za-z0-9][A-Za-z0-9._-]*$')]
):
    root: constr(pattern=r'^EV(?:ENT)?-[A-Za-z0-9][A-Za-z0-9._-]*$')


class World(BaseModel):
    model_config = ConfigDict(
        extra='allow',
    )
    elapsed_minutes: conint(ge=0)


class Rng(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    algorithm: Literal['sha256-seeded-python-random']
    campaign_seed: constr(min_length=1)
    roll_index: conint(ge=0)


class Kind(Enum):
    player = 'player'
    npc = 'npc'


class Detail(Enum):
    full = 'full'
    lite = 'lite'


class Character(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    character_id: constr(min_length=1)
    kind: Kind
    detail: Detail
    sheet: dict[str, Any]


class AuthorizedSubjectId(RootModel[constr(min_length=1)]):
    root: constr(min_length=1)


class Secret(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    value: Any
    authorized_subject_ids: list[AuthorizedSubjectId]


class Canon(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    facts: dict[str, Any]
    secrets: dict[str, Secret]
    rulings: dict[str, Any]


class CampaignStateV1(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    campaign_id: constr(pattern=r'^CAMPAIGN-[A-Za-z0-9][A-Za-z0-9._-]*$')
    branch_id: constr(pattern=r'^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$')
    state_version: conint(ge=0)
    applied_event_ids: list[AppliedEventId]
    world: World
    scene: dict[str, Any]
    quests: dict[str, Any]
    factions: dict[str, Any]
    rng: Rng
    characters: dict[str, Character]
    inventories: dict[str, dict[str, Any]]
    canon: Canon
    knowledge: dict[str, dict[str, Any]]
    beliefs: dict[str, dict[str, Any]]
    rumors: dict[str, dict[str, Any]]
