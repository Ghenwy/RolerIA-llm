# GENERATED FILE - DO NOT EDIT. source=sot/rule-resolution.schema.json schema_sha256=7e6be2402dc2225accf645c77aef94da8e3c1b754936aba2e56b47989e151727

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, confloat


class Status(Enum):
    resolved = 'resolved'
    partial = 'partial'
    blocked = 'blocked'
    conflict = 'conflict'


class Authority(Enum):
    house_rule = 'house_rule'
    official_errata = 'official_errata'
    srd_ogc = 'srd_ogc'
    campaign_ruling = 'campaign_ruling'
    user_excerpt = 'user_excerpt'


class Source(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    source_id: str
    section: str
    url: str
    authority: Authority


class Model(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    query_id: str
    status: Status
    ruling: str
    sources: list[Source]
    required_rolls: list[dict[str, Any]]
    modifiers: list[dict[str, Any]]
    resource_changes: list[dict[str, Any]]
    state_events: list[dict[str, Any]]
    ambiguities: list[str]
    confidence: confloat(ge=0.0, le=1.0)
