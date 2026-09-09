# GENERATED FILE - DO NOT EDIT. source=sot/inventory.schema.json schema_sha256=c2d3372526e3002ca614b2a1938374055ef14cee9033386f30073996fb3c72a2

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, confloat, conint


class OwnerType(Enum):
    character = 'character'
    party = 'party'
    location = 'location'
    vehicle = 'vehicle'
    organization = 'organization'


class Container(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    container_id: str
    name: str
    parent_container_id: str | None
    capacity: float | None
    location: str


class Item(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    item_instance_id: str
    template_id: str
    name: str
    quantity: conint(ge=0)
    owner_id: str
    container_id: str | None
    equipped_slot: str | None
    weight_each: confloat(ge=0.0)
    identified: bool
    charges_current: conint(ge=0) | None
    charges_max: conint(ge=0) | None
    condition: str
    quest_item: bool
    provenance: list[str]
    effects: list[dict[str, Any]]
    source_ref: str | None


class LoadState(Enum):
    light = 'light'
    medium = 'medium'
    heavy = 'heavy'
    overloaded = 'overloaded'
    not_applicable = 'not_applicable'


class Carrying(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    total_weight: confloat(ge=0.0)
    light_limit: float | None
    medium_limit: float | None
    heavy_limit: float | None
    load_state: LoadState


class Inventory(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    inventory_id: str
    owner_type: OwnerType
    owner_id: str
    version: conint(ge=1)
    currencies: dict[str, int]
    containers: list[Container]
    items: list[Item]
    carrying: Carrying
