"""Canonical JSON compatible with the governed TypeScript representation."""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping, Sequence
from typing import Any


def _format_float(value: float) -> str:
    if not math.isfinite(value):
        raise ValueError("NON_FINITE_JSON_NUMBER")
    if value == 0:
        return "0"

    absolute = abs(value)
    text = repr(value).lower()
    if "e" not in text:
        if value.is_integer():
            return str(int(value))
        return text

    mantissa, exponent_text = text.split("e", 1)
    exponent = int(exponent_text)
    sign = ""
    if mantissa.startswith("-"):
        sign = "-"
        mantissa = mantissa[1:]
    integer_part, dot, fraction_part = mantissa.partition(".")
    digits = f"{integer_part}{fraction_part}" if dot else integer_part

    if 1e-6 <= absolute < 1e21:
        decimal_position = 1 + exponent
        if decimal_position <= 0:
            return f"{sign}0.{('0' * -decimal_position)}{digits}"
        if decimal_position >= len(digits):
            return f"{sign}{digits}{'0' * (decimal_position - len(digits))}"
        return f"{sign}{digits[:decimal_position]}.{digits[decimal_position:]}"

    normalized_mantissa = digits[0]
    if len(digits) > 1:
        normalized_mantissa = f"{normalized_mantissa}.{digits[1:]}"
    exponent_sign = "+" if exponent >= 0 else ""
    return f"{sign}{normalized_mantissa}e{exponent_sign}{exponent}"


def _key_order(value: str) -> bytes:
    return value.encode("utf-16-be", errors="surrogatepass")


def _encode(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _format_float(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise TypeError("JSON object keys must be strings")
        parts = []
        for key in sorted(value, key=_key_order):
            parts.append(f"{_encode(key)}:{_encode(value[key])}")
        return f"{{{','.join(parts)}}}"
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return f"[{','.join(_encode(item) for item in value)}]"
    raise TypeError(f"Unsupported JSON value: {type(value).__name__}")


def canonical_json(value: Any) -> str:
    """Return deterministic UTF-8 JSON text with one trailing LF."""

    return f"{_encode(value)}\n"


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
