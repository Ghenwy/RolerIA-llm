# GENERATED FILE - DO NOT EDIT. source=internal/knowledge-acquisition-v1.schema.json schema_sha256=06c3651a5cf409e0218f013cdda623a565f47de47550a1e3d52ca9d2918d4fe0

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, constr


class Kind(Enum):
    DISCLOSURE = 'DISCLOSURE'
    OBSERVATION = 'OBSERVATION'


class KnowledgeAcquisitionV1(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    kind: Kind
    source_subject_id: constr(min_length=1, max_length=128) | None
    source_id: constr(min_length=1, max_length=256)
