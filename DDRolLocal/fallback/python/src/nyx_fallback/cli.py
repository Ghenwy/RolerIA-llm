"""Executable degraded-mode CLI entered only through a validated handoff."""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from collections.abc import Sequence
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from .handoff import accept_filesystem_handoff, release_writer
from .llama_gateway import LlamaServerFallbackGateway
from .local_ports import (
    CampaignFiles,
    FilesystemCheckpoint,
    FilesystemContext,
    FilesystemTranscript,
    FilesystemTurnPorts,
    FilesystemWriterLease,
)
from .workflow import FallbackWorkflow, WorkflowInput, WorkflowPortError


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="nyx-fallback")
    commands = parser.add_subparsers(dest="command", required=True)
    play = commands.add_parser("play", help="Inicia DEGRADED_MODE tras un handoff confirmado")
    play.add_argument("--product-root", type=Path, required=True)
    play.add_argument("--campaign-root", type=Path, required=True)
    play.add_argument("--handoff-file", type=Path, required=True)
    play.add_argument("--input", help="Ejecuta un único turno no interactivo")
    return parser


def _safe_handoff(root: Path, candidate: Path) -> Path:
    handoffs = (root / "handoffs").resolve()
    resolved = candidate.resolve()
    if not resolved.is_relative_to(handoffs) or resolved.suffix != ".json":
        raise WorkflowPortError("HANDOFF_PATH_INVALID", "handoff-file está fuera de la campaña.")
    return resolved


def _play(args: argparse.Namespace) -> int:
    product_root = args.product_root.resolve()
    campaign_root = args.campaign_root.resolve()
    handoff_file = _safe_handoff(campaign_root, args.handoff_file)
    handoff = json.loads(handoff_file.read_bytes().decode("utf-8"))
    if not isinstance(handoff, dict):
        raise WorkflowPortError("HANDOFF_CONTRACT_INVALID", "El handoff no es un objeto.")
    accepted = accept_filesystem_handoff(
        campaign_root,
        handoff,
        "python",
        max(1, os.getpid()),
        datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    )
    token = str(accepted["lease"]["token"])
    try:
        CampaignFiles(campaign_root).interactive_manifest()
        context: FilesystemContext
        gateway = LlamaServerFallbackGateway(product_root, lambda: context.snapshot)
        context = FilesystemContext(
            campaign_root,
            gateway,
            maximum_input_tokens=gateway.maximum_input_tokens,
        )
        transcript = FilesystemTranscript(campaign_root)
        transcript.drain()
        turn_ports = FilesystemTurnPorts(campaign_root, token)
        checkpoints = FilesystemCheckpoint(campaign_root)
        workflow = FallbackWorkflow(
            lease=FilesystemWriterLease(campaign_root),
            context=context,
            gateway=gateway,
            workers=gateway,
            dice=turn_ports,
            state=turn_ports,
            checkpoints=checkpoints,
            mechanics=turn_ports,
            max_resolve_cycles=8,
        )
        actions = [args.input] if isinstance(args.input, str) else None
        while True:
            if actions is None:
                try:
                    action = input("nyx(degraded)> ").strip()
                except EOFError:
                    break
            elif actions:
                action = actions.pop(0).strip()
            else:
                break
            if action.lower() in {"quit", "exit", "/quit"}:
                break
            if not action:
                continue
            files = CampaignFiles(campaign_root)
            state = files.state()
            manifest = files.manifest()
            turn = WorkflowInput(
                campaign_id=str(state["campaign_id"]),
                branch_id=str(state["branch_id"]),
                turn_id=f"TURN-FALLBACK-{uuid.uuid4().hex.upper()}",
                base_state_version=int(state["state_version"]),
                player_input=action,
                context_refs=(),
                language=str(manifest["language"]),
                writer_token=token,
            )
            transcript.append_player(turn)
            outcome = workflow.run(turn)
            if outcome.status == "COMMITTED":
                checkpoints.create(turn, "Límite confirmado tras turno fallback.")
            print(json.dumps(asdict(outcome), ensure_ascii=False, separators=(",", ":")))
            if outcome.status == "BLOCKED" and outcome.code.startswith("CONTEXT_UNSAFE"):
                return 1
        return 0
    finally:
        release_writer(campaign_root, token)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = _parser().parse_args(list(argv) if argv is not None else None)
        return _play(args)
    except (OSError, UnicodeError, json.JSONDecodeError, WorkflowPortError, ValueError) as error:
        code = error.code if isinstance(error, WorkflowPortError) else "FALLBACK_START_FAILED"
        print(json.dumps({"ok": False, "code": code, "message": str(error)}), file=sys.stderr)
        return 1
