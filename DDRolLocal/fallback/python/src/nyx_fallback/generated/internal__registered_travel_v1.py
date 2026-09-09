# GENERATED FILE - DO NOT EDIT. source=internal/registered-travel-v1.schema.json schema_sha256=4d334ca959748e3010c905ff9f136fa654c3c717045cc5e68317546b789a4b8a

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, RootModel, conint, constr


class SourceRef(RootModel[constr(min_length=1)]):
    root: constr(min_length=1)


class Id(RootModel[constr(pattern=r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')]):
    root: constr(pattern=r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')


class DestinationScene(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    location_id: Id
    summary: constr(min_length=1, max_length=400)
    present_character_ids: list[Id] = Field(..., min_length=1)
    immediate_threats: list[str] = Field(..., max_length=0)
    open_questions: list[constr(min_length=1)]


class RegisteredTravelV1(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    route_id: Id
    actor_id: Id
    from_location_id: Id
    to_location_id: Id
    character_ids: list[Id] = Field(..., min_length=1)
    duration_minutes: conint(ge=1, le=9007199254740990)
    source_refs: list[SourceRef] = Field(..., min_length=1)
    destination_scene: DestinationScene
