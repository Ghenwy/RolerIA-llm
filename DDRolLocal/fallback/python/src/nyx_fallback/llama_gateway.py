"""Loopback-only llama-server adapter for the degraded Python runtime."""

from __future__ import annotations

import copy
import hashlib
import json
import urllib.error
import urllib.request
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any, Literal, cast
from urllib.parse import urlparse

from jsonschema import Draft202012Validator, FormatChecker

from .core.contracts import _load_schema, validate_contract
from .workflow import WorkflowInput, WorkflowPortError

JsonObject = dict[str, Any]
Transport = Callable[[str, JsonObject, float], JsonObject]
ContextProvider = Callable[[], JsonObject | None]


def _npc_scoped_job_schema(job: JsonObject) -> JsonObject:
    npc, other = copy.deepcopy(job), copy.deepcopy(job)
    npc["properties"]["worker_id"] = {"const": "rpg.npc_director"}
    other["properties"]["worker_id"]["enum"] = [worker for worker in other["properties"]["worker_id"]["enum"]
                                                 if worker != "rpg.npc_director"]
    npc["properties"]["inputs"]["properties"]["state_refs"] = {
        "type": "array", "minItems": 1, "items": {"type": "string", "pattern": "^subject:[A-Za-z0-9_-]+$"}}
    return {"oneOf": [npc, other]}


def _object(value: Any, code: str) -> JsonObject:
    if not isinstance(value, dict):
        raise WorkflowPortError(code, "La respuesta no es un objeto JSON.")
    return cast(JsonObject, value)


def _balanced_dialogue(text: str) -> bool:
    # Presentation only; not a truth or narrative-quality evaluator.
    closes = {"«": "»", "“": "”"}
    stack: list[str] = []
    for char in text:
        if char in closes:
            stack.append(closes[char])
        elif char in closes.values() and (not stack or stack.pop() != char):
            return False
    return not stack


class LlamaServerFallbackGateway:
    def __init__(
        self,
        product_root: Path,
        context_provider: ContextProvider,
        *,
        transport: Transport | None = None,
        timeout_seconds: float = 180.0,
    ) -> None:
        root = product_root.resolve()
        configuration = _object(
            json.loads((root / "config" / "runtime-profiles.json").read_text(encoding="utf-8")),
            "RUNTIME_PROFILE_INVALID",
        )
        profile_name = configuration["production_profile"]
        profiles = configuration["profiles"]
        profile = next(
            (
                candidate
                for candidate in profiles
                if isinstance(candidate, dict) and candidate.get("profile") == profile_name
            ),
            None,
        )
        if not isinstance(profile, dict) or profile.get("host") != "127.0.0.1":
            raise WorkflowPortError("RUNTIME_PROFILE_INVALID", "El perfil fallback no es loopback.")
        origin = f"http://127.0.0.1:{int(profile['port'])}"
        parsed = urlparse(origin)
        if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.path not in ("", "/"):
            raise WorkflowPortError("RUNTIME_ORIGIN_INVALID", "llama-server debe usar loopback HTTP.")
        self.origin = origin
        self.model_id = str(configuration["model"]["alias"])
        self.context_per_slot = int(profile["context_per_slot"])
        self._root = root
        self._context = context_provider
        self._transport = transport or self._post
        self._timeout = timeout_seconds
        prompts = root / "packages" / "contracts" / "prompts" / "nyx"
        self._gm_prompt = (prompts / "nyx_gm.txt").read_text(encoding="utf-8")
        self._gm_prompt += ("\n[DESIGN] /action selecciona una acción registrada. mechanical_action null no autoriza dados. "
                            "Si next_roll existe, solicita exactamente esa tirada. Si outcome existe, READY copia narration "
                            "exactamente, sin eventos/patches ni sumar otra vez el modificador. CALCULATE_DAMAGE_ONLY no cambia PG.\n")
        self._gm_prompt += ("\n[DESIGN] Una pregunta o recordar un dato no crea conocimiento: events_to_commit vacío si no cambia estado. "
                            "El NPC sólo usa knowledge/beliefs/observaciones suministrados; si no sabe, reconoce su limitación. "
                            "Un worker o un manual no acreditan verdad. NPC_KNOWLEDGE_ADDED requiere payload "
                            "{subject_id,knowledge_id,value,acquisition:{schema_version:'1.0',kind:'DISCLOSURE'|'OBSERVATION',source_subject_id,source_id}}. "
                            "DISCLOSURE copia value exactamente de knowledge del emisor presente y autorizado, actor_id=emisor, "
                            "targets incluye receptor, evidence/source_refs incluyen knowledge:<emisor>:<source_id>; narración exacta "
                            "<emisor> dice en privado a <receptor>: «<text exacto>». No inventes discurso voluntario del jugador. "
                            "OBSERVATION requiere fact public y location_id actual, source_subject_id=null, value={fact_id,text exacto}, "
                            "actor_id=receptor, targets incluye receptor, referencia canon:<fact_id>, narración <receptor> observa: «<text exacto>». "
                            "Sin fuente confirmada, o mezclado con otros eventos, el commit se bloquea. Las creencias no son conocimiento.\n")
        self._worker_prompts = {
            "rpg.rules_arbiter": (prompts / "rpg_rules_arbiter.txt").read_text(encoding="utf-8"),
            "rpg.npc_director": (prompts / "rpg_npc_director.txt").read_text(encoding="utf-8"),
            "rpg.world_simulator": (prompts / "rpg_world_simulator.txt").read_text(encoding="utf-8"),
            "rpg.encounter_engine": (prompts / "rpg_encounter_engine.txt").read_text(encoding="utf-8"),
            "rpg.state_keeper": (prompts / "rpg_state_keeper.txt").read_text(encoding="utf-8"),
            "rpg.memory_keeper": (prompts / "rpg_memory_keeper.txt").read_text(encoding="utf-8"),
            "rpg.canon_validator": (prompts / "rpg_canon_validator.txt").read_text(encoding="utf-8"),
            "rpg.lore_curator": (prompts / "rpg_lore_curator.txt").read_text(encoding="utf-8"),
        }

    @property
    def maximum_input_tokens(self) -> int:
        return self.context_per_slot - 8192

    def count_tokens(self, value: WorkflowInput, context: JsonObject) -> int:
        payload = {
            "turn_envelope": self._envelope(value, "PLAN"),
            "context_packet": context,
        }
        response = self._transport(
            "/v1/chat/completions/input_tokens",
            {"model": self.model_id, "messages": self._messages(self._gm_prompt, payload)},
            self._timeout,
        )
        count = response.get("input_tokens")
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            raise WorkflowPortError("TOKEN_COUNT_INVALID", "llama-server no devolvió input_tokens.")
        return count

    def plan(self, envelope: JsonObject) -> JsonObject:
        return self._completion(
            "TurnPlan",
            "sot/turn-plan.schema.json",
            self._gm_prompt,
            self._turn_payload(envelope, []),
            slot=0,
            correlation=f"{envelope['turn_id']}-PLAN",
            generation_schema=self._turn_plan_generation_schema(envelope),
        )

    def resolve(
        self,
        envelope: JsonObject,
        turn_plan: JsonObject,
        worker_results: Sequence[JsonObject],
        mechanical_action: JsonObject | None | Literal[False] = False,
    ) -> JsonObject:
        payload = self._turn_payload(envelope, worker_results)
        payload["turn_plan"] = turn_plan
        if mechanical_action is not False:
            payload["mechanical_action"] = mechanical_action
        return self._completion(
            "TurnResolution",
            "sot/turn-resolution.schema.json",
            self._gm_prompt,
            payload,
            slot=0,
            correlation=f"{envelope['turn_id']}-RESOLVE-{len(envelope['deterministic_rolls'])}",
            generation_schema=self._turn_resolution_generation_schema(envelope, mechanical_action),
        )

    def execute_p0(self, value: JsonObject, _: WorkflowInput) -> JsonObject:
        return self._run_worker(value)

    def execute_awaited(self, resolution: JsonObject, _: WorkflowInput) -> JsonObject:
        required = next(
            (
                item.get("required_job")
                for item in resolution["open_threads"]
                if isinstance(item, dict) and isinstance(item.get("required_job"), dict)
            ),
            None,
        )
        if not isinstance(required, dict):
            raise WorkflowPortError(
                "AWAITED_JOB_UNSPECIFIED",
                "AWAITING_WORKER no contiene required_job machine-ready.",
            )
        return self._run_worker(cast(JsonObject, required))

    def _run_worker(self, job: JsonObject) -> JsonObject:
        errors = validate_contract("sot/rpgjob-card.schema.json", job)
        if errors:
            raise WorkflowPortError("WORKER_JOB_INVALID", "; ".join(errors))
        worker_id = str(job["worker_id"])
        if worker_id == "rpg.rules_arbiter":
            raise WorkflowPortError("RULES_ADAPTER_UNAVAILABLE", "El fallback no adjudica reglas nuevas sin un adapter de fuentes ejecutable.")
        prompt = self._worker_prompts.get(worker_id)
        if prompt is None:
            raise WorkflowPortError("WORKER_PROMPT_MISSING", worker_id)
        context = self._context()
        if context is None:
            raise WorkflowPortError("CONTEXT_UNAVAILABLE", "No existe snapshot confirmado.")
        state = _object(context.get("canonical_state"), "CONTEXT_UNAVAILABLE")
        subjects = sorted({ref.removeprefix("subject:") for ref in job["inputs"]["state_refs"]
                           if ref.startswith("subject:") and ref.removeprefix("subject:") in state["characters"]})
        if worker_id == "rpg.npc_director" and not any(state["characters"][subject]["kind"] == "npc" for subject in subjects):
            raise WorkflowPortError("WORKER_SUBJECT_REQUIRED", "NPC Director requiere un sujeto confirmado explícito.")
        # Worker proposals never receive the unfiltered canonical snapshot.
        knowledge = {subject: {
            "knowledge": state["knowledge"].get(subject, {}),
            "beliefs": state["beliefs"].get(subject, {}),
            "rumors": state["rumors"].get(subject, {}),
            "authorized_secrets": {key: secret["value"] for key, secret in state["canon"]["secrets"].items()
                                   if subject in secret["authorized_subject_ids"]},
        } for subject in subjects}
        context = {"campaign_id": state["campaign_id"], "branch_id": state["branch_id"], "ruleset_id": context.get("ruleset_id"),
                   "state_version": state["state_version"], "authorized_subject_ids": subjects,
                   "subject_knowledge": knowledge}
        return self._completion(
            "RPGWorkerResult",
            "sot/rpgworker-result.schema.json",
            prompt,
            {"job": job, "context": [context]},
            slot=1,
            correlation=f"{job['turn_id']}-{job['job_id']}",
        )

    def _turn_payload(
        self, envelope: JsonObject, worker_results: Sequence[JsonObject]
    ) -> JsonObject:
        context = self._context()
        if context is None:
            raise WorkflowPortError("CONTEXT_UNAVAILABLE", "No existe snapshot confirmado.")
        return {
            "turn_envelope": envelope,
            "context_packet": context,
            "resolved_worker_results": list(worker_results),
        }

    def _completion(
        self,
        contract_name: str,
        schema_path: str,
        prompt: str,
        payload: JsonObject,
        *,
        slot: int,
        correlation: str,
        generation_schema: JsonObject | None = None,
    ) -> JsonObject:
        contract_schema = _object(
            json.loads(
                (self._root / "packages" / "contracts" / "schemas" / schema_path).read_text(
                    encoding="utf-8"
                )
            ),
            "SCHEMA_LOAD_FAILED",
        )
        schema = generation_schema or contract_schema
        generation_validator = Draft202012Validator(schema, format_checker=FormatChecker())
        last_error = "respuesta ausente"
        feedback = ""
        for attempt, temperature in enumerate((0.75, 0.1), start=1):
            messages = self._messages(prompt + feedback, payload)
            count_response = self._transport("/v1/chat/completions/input_tokens",
                                             {"model": self.model_id, "messages": messages}, self._timeout)
            count = count_response.get("input_tokens")
            if type(count) is not int or count < 0:
                raise WorkflowPortError("TOKEN_COUNT_INVALID", "El request exacto no tiene conteo válido.")
            if count > self.maximum_input_tokens:
                raise WorkflowPortError("CONTEXT_LIMIT", "El request exacto excede el presupuesto disponible.")
            response = self._transport(
                "/v1/chat/completions",
                {
                    "model": self.model_id,
                    "id_slot": slot,
                    "seed": self._seed(f"{correlation}-{attempt}"),
                    "cache_prompt": True,
                    "stream": False,
                    "temperature": temperature,
                    "top_p": 0.95,
                    "repeat_penalty": 1,
                    "max_tokens": 8192,
                    "chat_template_kwargs": {"enable_thinking": False},
                    "messages": messages,
                    "response_format": {
                        "type": "json_schema",
                        "json_schema": {
                            "name": contract_name,
                            "strict": True,
                            "schema": schema,
                        },
                    },
                },
                self._timeout,
            )
            try:
                content = response["choices"][0]["message"]["content"]
                parsed = json.loads(content)
                value = _object(parsed, "LLM_INVALID_RESPONSE")
                errors = validate_contract(schema_path, value)
                if not errors and generation_validator.is_valid(value):
                    if (contract_name == "TurnResolution" and value.get("resolution_status") == "READY"
                            and not _balanced_dialogue(value["player_facing_narration"])):
                        last_error = "player_facing_narration:unbalanced-quotes"
                        feedback = ("\nCorrige el cierre de comillas: cada « tiene un » y cada “ tiene un ”, "
                                    "sin cierres sobrantes ni comillas externas. Conserva los hechos confirmados.")
                        continue
                    return value
                last_error = "; ".join(errors) if errors else "generation-overlay:invalid"
            except (KeyError, IndexError, TypeError, json.JSONDecodeError) as error:
                last_error = str(error)
        raise WorkflowPortError("LLM_SCHEMA_INVALID", last_error)

    def _turn_plan_generation_schema(self, envelope: JsonObject) -> JsonObject:
        base = _object(
            json.loads(
                (self._root / "packages" / "contracts" / "schemas" / "sot" / "turn-plan.schema.json")
                .read_text(encoding="utf-8")
            ),
            "SCHEMA_LOAD_FAILED",
        )

        def strip_identifiers(value: Any) -> Any:
            if isinstance(value, list):
                return [strip_identifiers(item) for item in value]
            if not isinstance(value, dict):
                return value
            return {
                key: strip_identifiers(nested)
                for key, nested in value.items()
                if key not in {"$schema", "$id"}
            }

        branches: list[JsonObject] = []
        for decision in ("DIRECT", "DELEGATE", "ASK_CLARIFICATION", "BLOCKED"):
            branch = cast(JsonObject, strip_identifiers(copy.deepcopy(base)))
            properties = cast(JsonObject, branch["properties"])
            properties["decision"] = {"const": decision}
            properties["turn_id"] = {
                **cast(JsonObject, properties["turn_id"]),
                "const": envelope["turn_id"],
            }
            properties["base_state_version"] = {
                **cast(JsonObject, properties["base_state_version"]),
                "const": envelope["base_state_version"],
            }
            jobs = cast(JsonObject, properties["jobs"])
            job = cast(JsonObject, jobs["items"])
            job_properties = cast(JsonObject, job["properties"])
            job_properties["turn_id"] = {
                **cast(JsonObject, job_properties["turn_id"]),
                "const": envelope["turn_id"],
            }
            job_properties["base_state_version"] = {
                **cast(JsonObject, job_properties["base_state_version"]),
                "const": envelope["base_state_version"],
            }
            jobs["items"] = _npc_scoped_job_schema(job)
            if decision == "DELEGATE":
                jobs["minItems"] = 1
            else:
                jobs["maxItems"] = 0
                cast(JsonObject, properties["blocking_job_ids"])["maxItems"] = 0
            if decision == "ASK_CLARIFICATION":
                intent = cast(JsonObject, properties["player_intent"])
                intent_properties = cast(JsonObject, intent["properties"])
                cast(JsonObject, intent_properties["ambiguities"])["minItems"] = 1
            branches.append(branch)
        return {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "title": "TurnPlanGenerationOverlay",
            "oneOf": branches,
        }

    def _turn_resolution_generation_schema(self, envelope: JsonObject,
                                           mechanical_action: JsonObject | None | Literal[False] = False) -> JsonObject:
        schema_root = self._root / "packages" / "contracts" / "schemas" / "sot"
        base = _object(
            json.loads((schema_root / "turn-resolution.schema.json").read_text(encoding="utf-8")),
            "SCHEMA_LOAD_FAILED",
        )
        job_schema = _object(
            json.loads((schema_root / "rpgjob-card.schema.json").read_text(encoding="utf-8")),
            "SCHEMA_LOAD_FAILED",
        )
        event_schema = _object(
            json.loads(
                (
                    self._root
                    / "packages"
                    / "contracts"
                    / "schemas"
                    / "internal"
                    / "domain-event-v1.1.schema.json"
                ).read_text(encoding="utf-8")
            ),
            "SCHEMA_LOAD_FAILED",
        )

        def strip_identifiers(value: Any) -> Any:
            if isinstance(value, list):
                return [strip_identifiers(item) for item in value]
            if not isinstance(value, dict):
                return value
            return {
                key: strip_identifiers(nested)
                for key, nested in value.items()
                if key not in {"$schema", "$id"}
            }

        branches: list[JsonObject] = []
        for status in ("READY", "AWAITING_ROLL", "AWAITING_WORKER", "BLOCKED"):
            if mechanical_action is None and status == "AWAITING_ROLL":
                continue
            if isinstance(mechanical_action, dict) and status == (
                    "READY" if mechanical_action["next_roll"] is not None else "AWAITING_ROLL"):
                continue
            branch = cast(JsonObject, strip_identifiers(copy.deepcopy(base)))
            properties = cast(JsonObject, branch["properties"])
            properties["resolution_status"] = {"const": status}
            properties["turn_id"] = {
                **cast(JsonObject, properties["turn_id"]),
                "const": envelope["turn_id"],
            }
            properties["base_state_version"] = {
                **cast(JsonObject, properties["base_state_version"]),
                "const": envelope["base_state_version"],
            }
            required_rolls = cast(JsonObject, properties["required_rolls"])
            patches = cast(JsonObject, properties["patches_to_commit"])
            patches["maxItems"] = 0
            if status == "AWAITING_ROLL":
                required_rolls["minItems"] = 1
            else:
                required_rolls["maxItems"] = 0
            events = cast(JsonObject, properties["events_to_commit"])
            if status == "READY":
                event = cast(JsonObject, strip_identifiers(copy.deepcopy(event_schema)))
                event_properties = cast(JsonObject, event["properties"])
                context = self._context()
                if context is None:
                    raise WorkflowPortError("CONTEXT_UNAVAILABLE", "No existe snapshot confirmado.")
                event_properties["campaign_id"] = {"const": context["campaign_id"]}
                event_properties["branch_id"] = {"const": context["branch_id"]}
                event_properties["turn_id"] = {"const": envelope["turn_id"]}
                knowledge_event = copy.deepcopy(event)
                knowledge_event["properties"]["event_type"] = {"const": "NPC_KNOWLEDGE_ADDED"}
                knowledge_event["properties"]["payload"] = {
                    "type": "object", "additionalProperties": False,
                    "required": ["subject_id", "knowledge_id", "value", "acquisition"],
                    "properties": {"subject_id": {"type": "string", "minLength": 1},
                                   "knowledge_id": {"type": "string", "minLength": 1}, "value": {"type": "object"},
                                   "acquisition": strip_identifiers(_load_schema("internal/knowledge-acquisition-v1.schema.json"))}}
                event_properties["event_type"]["enum"] = [kind for kind in event_properties["event_type"]["enum"]
                                                         if kind != "NPC_KNOWLEDGE_ADDED"]
                events["items"] = {"oneOf": [knowledge_event, event]}
            else:
                events["maxItems"] = 0
            if status == "AWAITING_WORKER":
                required_job = cast(JsonObject, strip_identifiers(copy.deepcopy(job_schema)))
                job_properties = cast(JsonObject, required_job["properties"])
                job_properties["turn_id"] = {
                    **cast(JsonObject, job_properties["turn_id"]),
                    "const": envelope["turn_id"],
                }
                job_properties["base_state_version"] = {
                    **cast(JsonObject, job_properties["base_state_version"]),
                    "const": envelope["base_state_version"],
                }
                job_properties["priority"] = {"const": "P0"}
                job_properties["blocking"] = {"const": True}
                properties["open_threads"] = {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["required_job"],
                        "properties": {"required_job": _npc_scoped_job_schema(required_job)},
                    },
                }
            if isinstance(mechanical_action, dict):
                events["maxItems"] = 0
                if status == "READY":
                    properties["player_facing_narration"] = {"type": "string", "const": mechanical_action["narration"]}
                if status == "AWAITING_ROLL":
                    request = mechanical_action["next_roll"]
                    required_rolls.update({"minItems": 1, "maxItems": 1, "items": {
                        "type": "object", "additionalProperties": False, "required": ["roll_id", "expression"],
                        "properties": {"roll_id": {"const": request["roll_id"]}, "expression": {"const": request["expression"]}}
                    }})
            branches.append(branch)
        return {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "title": "TurnResolutionGenerationOverlay",
            "oneOf": branches,
        }

    @staticmethod
    def _messages(prompt: str, payload: JsonObject) -> list[JsonObject]:
        messages = [
            {"role": "system", "content": prompt},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False, separators=(",", ":"))},
        ]
        current = payload.get("context_packet", {}).get("current_player_message")
        if current is None:
            current = payload.get("turn_envelope", {}).get("player_input")
        if isinstance(current, str):
            messages.append({"role": "user", "content": current})
        return messages

    @staticmethod
    def _seed(correlation: str) -> int:
        return int.from_bytes(hashlib.sha256(correlation.encode()).digest()[:4], "big") & 0x7FFFFFFF

    @staticmethod
    def _envelope(value: WorkflowInput, phase: str) -> JsonObject:
        return {
            "schema_version": "1.0",
            "campaign_id": value.campaign_id,
            "turn_id": value.turn_id,
            "phase": phase,
            "base_state_version": value.base_state_version,
            "player_input": value.player_input if phase == "PLAN" else None,
            "context_refs": list(value.context_refs),
            "worker_results": [],
            "deterministic_rolls": [],
            "language": value.language,
        }

    def _post(self, path: str, payload: JsonObject, timeout: float) -> JsonObject:
        request = urllib.request.Request(
            f"{self.origin}{path}",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return _object(json.loads(response.read().decode("utf-8")), "LLM_INVALID_RESPONSE")
        except (OSError, UnicodeError, json.JSONDecodeError, urllib.error.URLError) as error:
            raise WorkflowPortError("LLM_HTTP_ERROR", str(error)) from error
