# GENERATED FILE - DO NOT EDIT. source=design/campaign-manifest.schema.json schema_sha256=e37997332f192216cccd4b40c171c676e83949ab0da2955c567b0c5c4a52730a

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, RootModel, conint, constr


class RuntimeProfile(Enum):
    field_96k = '96k'
    field_112k = '112k'


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


class Paths(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    state: RelativePath
    events: RelativePath
    transcript: RelativePath
    checkpoints: RelativePath


class Fingerprints(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schemas: FingerprintMap
    prompts: FingerprintMap
    model: Sha256


class CampaignManifestV1(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    campaign_id: constr(pattern=r'^CAMPAIGN-[A-Za-z0-9][A-Za-z0-9._-]*$')
    language: constr(pattern=r'^[a-z]{2}(?:-[A-Z]{2})?$')
    ruleset_id: constr(min_length=1)
    runtime_profile: RuntimeProfile
    active_branch_id: constr(pattern=r'^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$')
    state_version: conint(ge=0)
    paths: Paths
    fingerprints: Fingerprints
    last_checkpoint_at: AwareDatetime | None
