# GENERATED FILE - DO NOT EDIT. source=internal/dnd35-prestige-class.schema.json schema_sha256=436f2c0811b3937db54a68419e6f851b4d61a98d63dcdb7214ddca132c8c089f

from __future__ import annotations

from enum import Enum

from pydantic import AnyUrl, BaseModel, ConfigDict, RootModel, conint, constr


class SourceFamily(Enum):
    core_srd = 'core_srd'
    psionic_srd = 'psionic_srd'


class HitDie(Enum):
    d4 = 'd4'
    d6 = 'd6'
    d8 = 'd8'
    d10 = 'd10'
    d12 = 'd12'


class Bab(Enum):
    half = 'half'
    three_quarters = 'three_quarters'
    full = 'full'


class GoodSave(Enum):
    fortitude = 'fortitude'
    reflex = 'reflex'
    will = 'will'


class StringArrayItem(RootModel[constr(min_length=1)]):
    root: constr(min_length=1)


class StringArray(RootModel[list[StringArrayItem]]):
    root: list[StringArrayItem]


class LevelArrayItem(RootModel[conint(ge=1, le=20)]):
    root: conint(ge=1, le=20)


class LevelArray(RootModel[list[LevelArrayItem]]):
    root: list[LevelArrayItem]


class ScalarArray(RootModel[list[str | int | bool]]):
    root: list[str | int | bool]


class NumberByLevel(
    RootModel[dict[constr(pattern=r'^(?:[1-9]|1[0-9]|20)$'), conint(ge=0)]]
):
    root: dict[constr(pattern=r'^(?:[1-9]|1[0-9]|20)$'), conint(ge=0)]


class Requirements(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    alignment: constr(min_length=1) | None = None
    bab_min: conint(ge=0) | None = None
    feats_all: StringArray | None = None
    feats_pattern: StringArray | None = None
    languages_all: StringArray | None = None
    proficiencies: StringArray | None = None
    psionics: StringArray | None = None
    race_exclusions: StringArray | None = None
    race_tags_all: StringArray | None = None
    race_tags_any: StringArray | None = None
    skills: dict[str, conint(ge=0)] | None = None
    skills_pattern: StringArray | None = None
    special: StringArray | None = None
    spellcasting: StringArray | None = None


class Progression(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    arcane_spellcasting_levels: LevelArray | None = None
    bonus_spell_effect: constr(min_length=1) | None = None
    bonus_spells_by_level: NumberByLevel | None = None
    caster_level: constr(min_length=1) | None = None
    divine_spellcasting_levels: LevelArray | None = None
    manifesting_levels: LevelArray | None = None
    own_manifesting: constr(min_length=1) | None = None
    own_spellcasting: constr(min_length=1) | None = None
    power_points_by_class_table: bool | None = None
    prior_spellcasting: ScalarArray | None = None
    spellcasting: ScalarArray | None = None
    spellcasting_levels: LevelArray | None = None
    spells_per_day: ScalarArray | None = None


class Dnd35PrestigeClassV1(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    id: constr(pattern=r'^dnd35\.prestige\.[a-z0-9_]+$')
    name_es: constr(min_length=1)
    source_family: SourceFamily
    levels: conint(ge=1, le=20)
    hit_die: HitDie
    bab: Bab
    good_saves: list[GoodSave]
    requirements: Requirements
    progression: Progression
    milestones: dict[constr(pattern=r'^(?:[1-9]|1[0-9]|20)$'), StringArray]
    notes: StringArray
    source_url: AnyUrl
