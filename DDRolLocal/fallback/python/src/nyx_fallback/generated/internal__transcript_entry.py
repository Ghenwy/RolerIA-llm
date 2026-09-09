# GENERATED FILE - DO NOT EDIT. source=internal/transcript-entry.schema.json schema_sha256=984daf04c073106d02d6584d513b4c2d5cfae48451b9642c06915814a6a45c9f

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel, constr


class Speaker(Enum):
    player = 'player'
    gm = 'gm'
    system = 'system'


class SourceRef(RootModel[constr(min_length=1)]):
    root: constr(min_length=1)


class TranscriptEntryV1(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    transcript_id: constr(pattern=r'^TRANSCRIPT-[A-Za-z0-9][A-Za-z0-9._-]*$')
    campaign_id: constr(pattern=r'^CAMPAIGN-[A-Za-z0-9][A-Za-z0-9._-]*$')
    branch_id: constr(pattern=r'^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$')
    turn_id: constr(min_length=1)
    speaker: Speaker
    content: constr(min_length=1)
    occurred_at: AwareDatetime
    source_refs: list[SourceRef] = Field(..., min_length=1)
