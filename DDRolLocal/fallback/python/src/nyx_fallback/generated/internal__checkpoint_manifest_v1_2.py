# GENERATED FILE - DO NOT EDIT. source=internal/checkpoint-manifest-v1.2.schema.json schema_sha256=60b9272dcf7f351e70bb8744167d17bb8da1585b428457426a08b4f24d8c5c89

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, RootModel, conint, constr


class Kind(Enum):
    dnd35_events = 'dnd35_events'
    rule_source = 'rule_source'


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


class FingerprintMap(RootModel[dict[constr(min_length=1), Sha256]]):
    root: dict[constr(min_length=1), Sha256]


class Artifact(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    relative_path: RelativePath
    sha256: Sha256
    byte_length: conint(ge=0)
    kind: Kind


class CheckpointManifestV12(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.2']
    checkpoint_id: constr(pattern=r'^CHECKPOINT-[A-Za-z0-9][A-Za-z0-9._-]*$')
    campaign_id: constr(pattern=r'^CAMPAIGN-[A-Za-z0-9][A-Za-z0-9._-]*$')
    branch_id: constr(pattern=r'^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$')
    parent_checkpoint_id: (
        constr(pattern=r'^CHECKPOINT-[A-Za-z0-9][A-Za-z0-9._-]*$') | None
    )
    state_version: conint(ge=0)
    state_file: RelativePath
    state_sha256: Sha256
    event_file: RelativePath
    event_count: conint(ge=0)
    event_tail_event_id: (
        constr(pattern=r'^EV(?:ENT)?-[A-Za-z0-9][A-Za-z0-9._-]*$') | None
    )
    event_tail_hash: Sha256
    campaign_time: constr(min_length=1)
    rng_hash: Sha256
    schema_fingerprints: FingerprintMap
    prompt_fingerprints: FingerprintMap
    model_fingerprint: Sha256
    created_at: AwareDatetime
    artifacts: list[Artifact]
