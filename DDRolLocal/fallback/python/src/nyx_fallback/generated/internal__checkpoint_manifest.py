# GENERATED FILE - DO NOT EDIT. source=internal/checkpoint-manifest.schema.json schema_sha256=af5e83c4daa04abdd7566bf8574d7f91451431dc7f44b53668c1235fff7e6cb6

from __future__ import annotations

from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, RootModel, conint, constr


class Sha256(RootModel[constr(pattern=r'^[a-f0-9]{64}$')]):
    root: constr(pattern=r'^[a-f0-9]{64}$')


class FingerprintMap(RootModel[dict[constr(min_length=1), Sha256]]):
    root: dict[constr(min_length=1), Sha256]


class CheckpointManifestV1(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    checkpoint_id: constr(pattern=r'^CHECKPOINT-[A-Za-z0-9][A-Za-z0-9._-]*$')
    campaign_id: constr(pattern=r'^CAMPAIGN-[A-Za-z0-9][A-Za-z0-9._-]*$')
    branch_id: constr(pattern=r'^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$')
    parent_checkpoint_id: (
        constr(pattern=r'^CHECKPOINT-[A-Za-z0-9][A-Za-z0-9._-]*$') | None
    )
    state_version: conint(ge=0)
    state_sha256: Sha256
    event_tail_hash: Sha256
    rng_hash: Sha256
    schema_fingerprints: FingerprintMap
    prompt_fingerprints: FingerprintMap
    model_fingerprint: Sha256
    created_at: AwareDatetime
