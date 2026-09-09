"""Admission of new acquisitions only. Historical replay deliberately does not call this policy."""

from typing import Any

from .canonical import canonical_json
from .contracts import validate_contract


def _at(value: Any, key: Any) -> Any:
    return value.get(key) if isinstance(value, dict) and isinstance(key, str) else None


def _text(value: Any) -> str | None:
    text = _at(value, "text")
    return text if isinstance(text, str) and text else None


def validate_new_knowledge_events(state: dict[str, Any], events: list[dict[str, Any]], narration: str, player_input: str) -> None:
    learning = [event for event in events if _at(event, "event_type") == "NPC_KNOWLEDGE_ADDED"]
    if not learning:
        return
    if len(learning) != len(events):
        raise ValueError("KNOWLEDGE_MIXED_TRANSACTION")
    present = state["scene"].get("present_character_ids", [])
    if not isinstance(present, list):
        present = []
    receipts: list[str] = []
    learned: set[str] = set()
    for event in learning:
        payload = event.get("payload")
        if (not isinstance(payload, dict) or set(payload) != {"acquisition", "subject_id", "knowledge_id", "value"}
                or validate_contract("internal/knowledge-acquisition-v1.schema.json", payload["acquisition"])):
            raise ValueError("KNOWLEDGE_PROVENANCE_REQUIRED")
        proof = payload["acquisition"]
        subject = payload["subject_id"]
        receiver = _at(state["characters"], subject)
        receiver_name = _at(_at(receiver, "sheet"), "name")
        if not isinstance(receiver, dict) or subject not in present or not isinstance(receiver_name, str) or not receiver_name:
            raise ValueError("KNOWLEDGE_SOURCE_UNCONFIRMED")
        receiver_knowledge = _at(state["knowledge"], subject)
        identity = f"{subject}:{canonical_json(payload['value'])}"
        if (not isinstance(payload["knowledge_id"], str) or identity in learned
                or (isinstance(receiver_knowledge, dict) and (payload["knowledge_id"] in receiver_knowledge
                    or any(canonical_json(value) == canonical_json(payload["value"]) for value in receiver_knowledge.values())))):
            raise ValueError("KNOWLEDGE_ALREADY_ACQUIRED")
        learned.add(identity)
        if proof["kind"] == "DISCLOSURE":
            source_id = proof["source_subject_id"]
            source = _at(state["characters"], source_id)
            source_name = _at(_at(source, "sheet"), "name")
            expected = _at(_at(state["knowledge"], source_id), proof["source_id"])
            text = _text(expected)
            if (not isinstance(source, dict) or not isinstance(source_name, str) or not source_name or not text
                    or source_id not in present or source_id == subject or event.get("actor_id") != source_id):
                raise ValueError("KNOWLEDGE_SOURCE_UNCONFIRMED")
            if isinstance(expected, dict) and "secret_id" in expected:
                secret = _at(state["canon"]["secrets"], expected["secret_id"])
                audience = _at(secret, "authorized_subject_ids")
                readers = [character["character_id"] for character in state["characters"].values() if character["kind"] == "player"]
                if not isinstance(audience, list) or not all(member in audience for member in [subject, source_id, *readers]):
                    raise ValueError("KNOWLEDGE_AUDIENCE_BLOCKED")
            reference = f"knowledge:{source_id}:{proof['source_id']}"
            receipt = f"{source_name} dice en privado a {receiver_name}: «{text}»"
            if source["kind"] == "player" and player_input != receipt:
                raise ValueError("KNOWLEDGE_PLAYER_AGENCY_BLOCKED")
        else:
            fact = _at(state["canon"]["facts"], proof["source_id"])
            text = _text(fact)
            if (proof["source_subject_id"] is not None or not isinstance(fact, dict) or not text
                    or fact.get("visibility") != "public" or not isinstance(fact.get("location_id"), str)
                    or fact["location_id"] != state["scene"].get("location_id")
                    or fact["location_id"] != state["world"].get("location_id") or event.get("actor_id") != subject):
                raise ValueError("KNOWLEDGE_SOURCE_UNCONFIRMED")
            expected = {"fact_id": proof["source_id"], "text": text}
            reference = f"canon:{proof['source_id']}"
            receipt = f"{receiver_name} observa: «{text}»"
        if canonical_json(payload["value"]) != canonical_json(expected):
            raise ValueError("KNOWLEDGE_CLAIM_MISMATCH")
        if not all(isinstance(event.get(key), list) and needle in event[key]
                   for key, needle in (("source_refs", reference), ("evidence", reference), ("targets", subject))):
            raise ValueError("KNOWLEDGE_SOURCE_UNCONFIRMED")
        receipts.append(receipt)
    if narration != " ".join(receipts):
        raise ValueError("KNOWLEDGE_NARRATION_MISMATCH")
