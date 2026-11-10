"""Loopback HTTP API for the BDH associative-memory sidecar.

Endpoints (JSON):

* ``GET  /health``                 — no vault text; open so a healthcheck can call it
* ``POST /v1/upsert``              — ingest one entity
* ``POST /v1/remove``              — drop one entity and retract its synapses
* ``POST /v1/associate``           — ranked entity ids for a query
* ``POST /v1/rebuild``             — replace or extend the index from entity text

POST requests require ``Authorization: Bearer <token>`` whenever a token is
configured. Binding outside loopback without a token refuses to start, same
policy as the TypeScript server.
"""

from __future__ import annotations

import argparse
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import torch

from .model import DEFAULT_DECAY, DEFAULT_K, DEFAULT_NEURONS, DEFAULT_SEED, AssociativeBDH
from .store import StateStore

MAX_BODY = 64 * 1024 * 1024
LOOPBACK = {"127.0.0.1", "localhost", "::1"}


class MemoryApp:
    def __init__(self, model: AssociativeBDH, store: StateStore, token: str) -> None:
        self.model = model
        self.store = store
        self.token = token
        self.lock = threading.Lock()

    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "service": "bdh-associative-memory",
            "device": "cpu",
            "neurons": self.model.n,
            "fan_out": self.model.k,
            "decay": self.model.decay,
            "entities": len(self.model.entities),
            "state_dir": str(self.store.directory),
            "bdh": {
                "hebbian_sigma": True,
                "synaptic_readout": True,
                "trained_encoder": False,
                "slow_weights": True,
                "note": "Fast sigma is the BDH Hebbian rule and is discarded with the context. Slow sigma is the persisted, symmetrized consolidation. The encoder is a fixed sparse code, not a trained ReLU-lowrank matrix.",
            },
        }


def load_token() -> str:
    direct = os.environ.get("BDH_TOKEN", "").strip()
    if direct:
        return direct
    file_name = os.environ.get("BDH_TOKEN_FILE") or os.environ.get("MEMORY_API_TOKEN_FILE")
    if file_name:
        path = Path(file_name)
        if not path.is_file():
            raise SystemExit(f"token file is not readable: {file_name}")
        return path.read_text(encoding="utf-8").strip()
    return os.environ.get("MEMORY_API_TOKEN", "").strip()


def make_handler(app: MemoryApp) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args: Any) -> None:
            return

        def do_GET(self) -> None:  # noqa: N802 — stdlib name
            path = urlparse(self.path).path
            if path == "/health":
                send_json(self, 200, app.health())
                return
            send_json(self, 404, {"ok": False, "error": {"code": "NOT_FOUND", "message": "Unknown path"}})

        def do_POST(self) -> None:  # noqa: N802
            if not authorized(self, app.token):
                send_json(self, 401, {"ok": False, "error": {"code": "AUTH_REQUIRED", "message": "Valid bearer token required"}})
                return
            path = urlparse(self.path).path
            try:
                body = read_json(self)
            except ValueError as error:
                send_json(self, 400, {"ok": False, "error": {"code": "VALIDATION_ERROR", "message": str(error)}})
                return
            try:
                if path == "/v1/upsert":
                    send_json(self, 200, upsert(app, body))
                elif path == "/v1/remove":
                    send_json(self, 200, remove(app, body))
                elif path == "/v1/associate":
                    send_json(self, 200, associate(app, body))
                elif path == "/v1/rebuild":
                    send_json(self, 200, rebuild(app, body))
                else:
                    send_json(self, 404, {"ok": False, "error": {"code": "NOT_FOUND", "message": "Unknown path"}})
            except ValueError as error:
                send_json(self, 400, {"ok": False, "error": {"code": "VALIDATION_ERROR", "message": str(error)}})
            except Exception as error:  # noqa: BLE001 — the sidecar must answer, not drop the socket
                send_json(self, 500, {"ok": False, "error": {"code": "INTERNAL_ERROR", "message": str(error)}})

    return Handler


def upsert(app: MemoryApp, body: dict[str, Any]) -> dict[str, Any]:
    entity_id = require_id(body)
    aliases = string_list(body.get("aliases"))
    with app.lock:
        result = app.model.upsert(entity_id, str(body.get("title") or ""), aliases, str(body.get("content") or ""), str(body.get("revision") or ""))
        if not result["unchanged"]:
            app.store.save(app.model)
    return {"ok": True, **result}


def remove(app: MemoryApp, body: dict[str, Any]) -> dict[str, Any]:
    entity_id = require_id(body)
    with app.lock:
        removed = app.model.remove(entity_id)
        if removed:
            app.store.save(app.model)
    return {"ok": True, "removed": removed}


def associate(app: MemoryApp, body: dict[str, Any]) -> dict[str, Any]:
    query = body.get("query")
    if not isinstance(query, str) or not query.strip():
        raise ValueError("query is required")
    limit = body.get("limit", 10)
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
        raise ValueError("limit must be an integer from 1 to 100")
    with app.lock:
        hits = app.model.associate(query, limit)
    return {
        "ok": True,
        "advisory": True,
        "results": [{"id": hit.id, "score": hit.score} for hit in hits],
    }


def rebuild(app: MemoryApp, body: dict[str, Any]) -> dict[str, Any]:
    entities = body.get("entities")
    if not isinstance(entities, list):
        raise ValueError("entities must be a list")
    reset = body.get("reset", True)
    if not isinstance(reset, bool):
        raise ValueError("reset must be a boolean")
    with app.lock:
        indexed = app.model.rebuild(entities, reset=reset)
        app.store.save(app.model)
    return {"ok": True, "indexed": indexed}


def require_id(body: dict[str, Any]) -> str:
    entity_id = body.get("id")
    if not isinstance(entity_id, str) or not entity_id.strip() or len(entity_id) > 200:
        raise ValueError("id is required")
    return entity_id.strip()


def string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError("aliases must be a list of strings")
    return [item for item in value if item][:32]


def authorized(handler: BaseHTTPRequestHandler, token: str) -> bool:
    if not token:
        return True
    header = handler.headers.get("Authorization", "")
    return header == f"Bearer {token}"


def read_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0"))
    if length < 0 or length > MAX_BODY:
        raise ValueError("request body is too large")
    raw = handler.rfile.read(length) if length else b""
    if not raw:
        return {}
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("body must be JSON") from error
    if not isinstance(parsed, dict):
        raise ValueError("body must be a JSON object")
    return parsed


def send_json(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def build_model_from_env() -> tuple[AssociativeBDH, StateStore]:
    model = AssociativeBDH(
        n=int(os.environ.get("BDH_NEURONS", DEFAULT_NEURONS)),
        k=int(os.environ.get("BDH_K", DEFAULT_K)),
        decay=float(os.environ.get("BDH_DECAY", DEFAULT_DECAY)),
        seed=int(os.environ.get("BDH_SEED", DEFAULT_SEED)),
    )
    store = StateStore(Path(os.environ.get("BDH_STATE_DIR", "./.state/neural")))
    if store.exists():
        model.load_payload(store.load())
    return model, store


def serve(bind: str, port: int, app: MemoryApp) -> ThreadingHTTPServer:
    if bind not in LOOPBACK and not app.token:
        raise SystemExit("refusing a non-loopback bind without a bearer token (set BDH_TOKEN or BDH_TOKEN_FILE)")
    server = ThreadingHTTPServer((bind, port), make_handler(app))
    return server


def main() -> None:
    torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
    parser = argparse.ArgumentParser(description="BDH associative-memory sidecar (CPU)")
    parser.add_argument("--bind", default=os.environ.get("BDH_BIND", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("BDH_PORT", "8091")))
    args = parser.parse_args()
    model, store = build_model_from_env()
    app = MemoryApp(model, store, load_token())
    server = serve(args.bind, args.port, app)
    print(f"bdh associative memory listening on http://{args.bind}:{args.port} ({len(model.entities)} entities, cpu)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
