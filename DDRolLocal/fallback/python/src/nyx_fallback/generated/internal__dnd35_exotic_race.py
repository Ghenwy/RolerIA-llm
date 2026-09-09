# GENERATED FILE - DO NOT EDIT. source=internal/dnd35-exotic-race.schema.json schema_sha256=44cccb8fb42967215057691ed0550fa691b09a2f0d6de6df52566c09c71fc8c0

from __future__ import annotations

from enum import Enum

from pydantic import AnyUrl, BaseModel, ConfigDict, Field, RootModel, conint, constr


class SourceFamily(Enum):
    core_srd = 'core_srd'
    psionic_srd = 'psionic_srd'


class Size(Enum):
    small = 'small'
    medium = 'medium'
    large = 'large'


class AbilityMods(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    str: int | None = None
    dex: int | None = None
    con: int | None = None
    int_: int | None = Field(None, alias='int')
    wis: int | None = None
    cha: int | None = None


class Die(Enum):
    d4 = 'd4'
    d6 = 'd6'
    d8 = 'd8'
    d10 = 'd10'
    d12 = 'd12'


class Saves(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    fort: int
    ref: int
    will: int


class RacialHdPackage(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    die: Die
    bab: int
    saves: Saves
    feats: conint(ge=0)


class Trait(RootModel[constr(min_length=1)]):
    root: constr(min_length=1)


class AutomaticItem(RootModel[constr(min_length=1)]):
    root: constr(min_length=1)


class Bonu(RootModel[constr(min_length=1)]):
    root: constr(min_length=1)


class Languages(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    automatic: list[AutomaticItem]
    bonus: list[Bonu]


class Variant(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    id: constr(min_length=1)
    level_adjustment: conint(ge=0)
    minimum_starting_ecl: conint(ge=1)


class Dnd35ExoticRaceV1(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    id: constr(pattern=r'^dnd35\.race\.[a-z0-9_]+$')
    name_es: constr(min_length=1)
    source_family: SourceFamily
    type: constr(pattern=r'^[a-z][a-z0-9_]*$')
    size: Size
    speed_ft: conint(ge=0)
    ability_mods: AbilityMods
    racial_hd: conint(ge=0)
    racial_hd_package: RacialHdPackage | None = None
    level_adjustment: conint(ge=0)
    minimum_starting_ecl: conint(ge=1)
    traits: list[Trait]
    favored_class: constr(min_length=1)
    languages: Languages
    variants: list[Variant] | None = None
    source_url: AnyUrl
