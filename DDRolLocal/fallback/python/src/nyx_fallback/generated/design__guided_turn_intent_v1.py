# GENERATED FILE - DO NOT EDIT. source=design/guided-turn-intent-v1.schema.json schema_sha256=7d87adfd5b58e62ff582e7ad7dc05e2edc47ef4f316d91c369a04a1eeba1a786

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, RootModel, constr


class Id(RootModel[constr(pattern=r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')]):
    root: constr(pattern=r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')


class Text(RootModel[constr(pattern=r'\S', min_length=1, max_length=32768)]):
    root: constr(pattern=r'\S', min_length=1, max_length=32768)


class GuidedTurnIntentV11(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    kind: Literal['conversation']
    text: Text


class GuidedTurnIntentV12(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    kind: Literal['rule']
    scope: Id
    question: Text


class GuidedTurnIntentV13(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    kind: Literal['travel']
    route_id: Id


class GuidedTurnIntentV14(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    kind: Literal['action']
    action_id: Id
    text: constr(max_length=32768)


class GuidedTurnIntentV1(
    RootModel[
        GuidedTurnIntentV11
        | GuidedTurnIntentV12
        | GuidedTurnIntentV13
        | GuidedTurnIntentV14
    ]
):
    root: (
        GuidedTurnIntentV11
        | GuidedTurnIntentV12
        | GuidedTurnIntentV13
        | GuidedTurnIntentV14
    ) = Field(
        ...,
        description='[DESIGN DEC-081] Explicit assisted intent constructed by application code, never by the model. IDs select registered capabilities; free text does not grant authority.',
        title='GuidedTurnIntentV1',
    )
