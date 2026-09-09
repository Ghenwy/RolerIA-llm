# GENERATED FILE - DO NOT EDIT. source=internal/transaction-journal-v1.1.schema.json schema_sha256=1f57bef43d67fbe06242857c35d61de1d22da8cac3132f5bf95663e936cf19c3

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    RootModel,
    conint,
    constr,
)


class Stage(Enum):
    PREPARED = 'PREPARED'
    STATE_RENAMED = 'STATE_RENAMED'
    EVENTS_APPENDED = 'EVENTS_APPENDED'
    COMMITTED = 'COMMITTED'


class EventId(RootModel[constr(pattern=r'^EV(?:ENT)?-[A-Za-z0-9][A-Za-z0-9._-]*$')]):
    root: constr(pattern=r'^EV(?:ENT)?-[A-Za-z0-9][A-Za-z0-9._-]*$')


class Sha256(RootModel[constr(pattern=r'^[a-f0-9]{64}$')]):
    root: constr(pattern=r'^[a-f0-9]{64}$')


class RelativePath(RootModel[str]):
    model_config = ConfigDict(
        regex_engine="python-re",
    )
    root: constr(
        pattern=r'^(?![A-Za-z]:)(?![/\\])(?!.*(?:^|[/\\])\.\.(?:[/\\]|$)).+$',
        min_length=1,
    )


class TransactionJournalV11(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.1']
    transaction_id: constr(pattern=r'^TX-[A-Za-z0-9][A-Za-z0-9._-]*$')
    campaign_id: constr(pattern=r'^CAMPAIGN-[A-Za-z0-9][A-Za-z0-9._-]*$')
    branch_id: constr(pattern=r'^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$')
    base_state_version: conint(ge=0)
    target_state_version: conint(ge=1)
    stage: Stage
    state_temp_path: RelativePath
    state_final_path: RelativePath
    state_sha256: Sha256
    event_ids: list[EventId] = Field(..., min_length=1)
    event_batch_sha256: Sha256
    created_at: AwareDatetime
    updated_at: AwareDatetime
