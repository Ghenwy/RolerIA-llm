# GENERATED FILE - DO NOT EDIT. source=design/narration-proposal-v1.schema.json schema_sha256=7dd7f89c61ec94d6fe53d912de120f756b1c42d20cf21c1be007ab71cde84edd

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, constr


class NarrationProposalV1(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    narration: constr(pattern=r'\S', min_length=1, max_length=1200)
