"""Loopback HTTP API for the BDH associative-memory sidecar.

Endpoints (JSON):

* ``GET  /health``                 — no vault text; open so a healthcheck can call it
* ``GET  /v1/ids``                 — id to revision for the BDH layer and, when on, the vector layer
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
import hmac
import json
import math
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import torch

from .model import DEFAULT_DECAY, DEFAULT_K, DEFAULT_NEURONS, DEFAULT_SEED, AssociativeBDH
from .store import StateStore
from .vectors import DEFAULT_MODEL, SentenceEncoder, VectorIndex

MAX_BODY = 16 * 1024 * 1024
MAX_TEXT = 100_000
MAX_QUERY = 2_000
# The TypeScript client posts at most 40 entities per call
# (REBUILD_CHUNK in src/adapters/neural/bdh-client.ts). The cap is a backstop
# for a direct caller; the 16 MiB body limit is the memory bound.
MAX_REBUILD = 1000
LOOPBACK = {"127.0.0.1", "localhost", "::1"}


class MemoryApp:
    def __init__(self, model: AssociativeBDH, store: StateStore, token: str, vectors: VectorIndex | None = None) -> None:
        self.model = model
        self.store = store
        self.token = token
        self.vectors = vectors
        self.bind = "127.0.0.1"
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
            "vectors": {
                "enabled": self.vectors is not None,
                "entities": len(self.vectors) if self.vectors is not None else 0,
                "dim": self.vectors.encoder.dim if self.vectors is not None else None,
            },
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
            if not host_permitted(self, app.bind):
                send_json(self, 403, {"ok": False, "error": {"code": "FORBIDDEN", "message": "Host is not allowed"}})
                return
            path = urlparse(self.path).path
            if path == "/health":
                send_json(self, 200, app.health())
                return
            if path == "/v1/ids":
                if not authorized(self, app.token):
                    send_json(self, 401, {"ok": False, "error": {"code": "AUTH_REQUIRED", "message": "Valid bearer token required"}})
                    return
                send_json(self, 200, list_ids(app))
                return
            send_json(self, 404, {"ok": False, "error": {"code": "NOT_FOUND", "message": "Unknown path"}})

        def do_POST(self) -> None:  # noqa: N802
            if not host_permitted(self, app.bind):
                send_json(self, 403, {"ok": False, "error": {"code": "FORBIDDEN", "message": "Host is not allowed"}})
                return
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


def list_ids(app: MemoryApp) -> dict[str, Any]:
    """Revision maps only. No note text leaves the sidecar."""
    with app.lock:
        bdh = {entity_id: entity.revision for entity_id, entity in app.model.entities.items()}
        vector = None if app.vectors is None else dict(app.vectors.revisions)
    return {"ok": True, "bdh": bdh, "vector": vector}


def upsert(app: MemoryApp, body: dict[str, Any]) -> dict[str, Any]:
    entity_id = require_id(body)
    aliases = string_list(body.get("aliases"))
    title = bounded_text(str(body.get("title") or ""), "title", 500)
    content = bounded_text(str(body.get("content") or ""), "content")
    revision = bounded_text(str(body.get("revision") or ""), "revision", 200)
    with app.lock:
        result = app.model.upsert(entity_id, title, aliases, content, revision)
        if not result["unchanged"]:
            app.store.save(app.model)
        if app.vectors is not None:
            try:
                if app.vectors.upsert(entity_id, title, aliases, content, revision):
                    app.vectors.save()
                result["vector_indexed"] = True
            except Exception as error:  # noqa: BLE001 — the BDH write must still succeed
                result["vector_indexed"] = False
                result["vector_error"] = str(error)[:200]
    return {"ok": True, **result}


def remove(app: MemoryApp, body: dict[str, Any]) -> dict[str, Any]:
    entity_id = require_id(body)
    with app.lock:
        removed = app.model.remove(entity_id)
        if removed:
            app.store.save(app.model)
        if app.vectors is not None and app.vectors.remove(entity_id):
            app.vectors.save()
    return {"ok": True, "removed": removed}


def associate(app: MemoryApp, body: dict[str, Any]) -> dict[str, Any]:
    query = body.get("query")
    if not isinstance(query, str) or not query.strip():
        raise ValueError("query is required")
    if len(query) > MAX_QUERY:
        raise ValueError("query is too long")
    limit = body.get("limit", 10)
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
        raise ValueError("limit must be an integer from 1 to 100")
    with app.lock:
        hits = app.model.associate(query, limit)
        vector_hits: list[dict[str, Any]] = []
        vector_available = False
        if app.vectors is not None and body.get("vector", True):
            vector_hits = [{"id": i, "score": s} for i, s in app.vectors.search(query, limit, read_min_score(body, app.vectors.min_score))]
            vector_available = True
    return {
        "ok": True,
        "advisory": True,
        "results": [{"id": hit.id, "score": hit.score} for hit in hits],
        "vector_available": vector_available,
        "vector_results": vector_hits,
    }


def rebuild(app: MemoryApp, body: dict[str, Any]) -> dict[str, Any]:
    entities = body.get("entities")
    if not isinstance(entities, list):
        raise ValueError("entities must be a list")
    if len(entities) > MAX_REBUILD:
        raise ValueError(f"entities must contain at most {MAX_REBUILD} items")
    reset = body.get("reset", True)
    if not isinstance(reset, bool):
        raise ValueError("reset must be a boolean")
    prepared = checked_entities(entities)
    with app.lock:
        indexed = app.model.rebuild(prepared, reset=reset)
        app.store.save(app.model)
        if app.vectors is not None:
            if reset:
                app.vectors.clear()
            app.vectors.upsert_many(prepared)
            app.vectors.save()
    return {"ok": True, "indexed": indexed, "vectors_indexed": len(app.vectors) if app.vectors is not None else 0}


def checked_entities(entities: list[Any]) -> list[dict[str, Any]]:
    prepared: list[dict[str, Any]] = []
    for item in entities:
        if not isinstance(item, dict):
            continue
        prepared.append(
            {
                "id": require_id(item),
                "title": bounded_text(str(item.get("title") or ""), "title", 500),
                "aliases": string_list(item.get("aliases")),
                "content": bounded_text(str(item.get("content") or ""), "content"),
                "revision": bounded_text(str(item.get("revision") or ""), "revision", 200),
            }
        )
    return prepared


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
    if any(len(item) > 200 for item in value):
        raise ValueError("alias is too long")
    return [item for item in value if item][:32]


def bounded_text(value: str, label: str, limit: int = MAX_TEXT) -> str:
    if len(value) > limit:
        raise ValueError(f"{label} is too long")
    return value


def authorized(handler: BaseHTTPRequestHandler, token: str) -> bool:
    if not token:
        return True
    header = handler.headers.get("Authorization", "")
    # compare_digest on str rejects non-ASCII with TypeError. Bytes do not.
    try:
        got = header.encode("utf-8")
        expected = f"Bearer {token}".encode("utf-8")
    except (UnicodeError, AttributeError):
        return False
    if len(got) != len(expected):
        return False
    return hmac.compare_digest(got, expected)


def host_permitted(handler: BaseHTTPRequestHandler, bind: str) -> bool:
    """Loopback listeners reject a foreign Host so a browser cannot DNS-rebind onto them.

    ``BDH_ALLOW_ANY_HOST=1`` disables the check for a local reverse proxy.
    """
    if os.environ.get("BDH_ALLOW_ANY_HOST", "") == "1":
        return True
    if bind not in LOOPBACK:
        return True
    return normalize_host(handler.headers.get("Host", "")) in LOOPBACK


def normalize_host(value: str) -> str:
    text = value.strip().lower()
    if text.startswith("["):
        end = text.find("]")
        return text[1:end] if end > 1 else ""
    if text.count(":") == 1:
        return text.split(":", 1)[0]
    return text


def read_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    raw_length = handler.headers.get("Content-Length", "0").strip()
    if not raw_length.isdigit():
        raise ValueError("Content-Length must be an integer")
    length = int(raw_length)
    if length > MAX_BODY:
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


def read_min_score(body: dict[str, Any], default: float) -> float:
    if "min_score" not in body:
        return default
    value = body["min_score"]
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise ValueError("min_score must be a finite number")
    return float(value)


def min_score_from_env() -> float:
    raw = os.environ.get("BDH_VECTOR_MIN_SCORE", "0")
    try:
        value = float(raw)
    except ValueError as error:
        raise SystemExit(f"BDH_VECTOR_MIN_SCORE must be a finite number (got {raw!r})") from error
    if not math.isfinite(value):
        raise SystemExit(f"BDH_VECTOR_MIN_SCORE must be a finite number (got {raw!r})")
    return value


def build_vectors_from_env(state_dir: Path) -> VectorIndex | None:
    """Dense vector layer. Off unless BDH_VECTOR=1; the model must be present in the image or cache.

    Downloads stay off unless BDH_ALLOW_MODEL_DOWNLOAD=1 (see safety.configure_model_download).
    """
    if os.environ.get("BDH_VECTOR", "0") != "1":
        return None
    encoder = SentenceEncoder(
        os.environ.get("BDH_EMBED_MODEL", DEFAULT_MODEL),
        cache_dir=os.environ.get("SENTENCE_TRANSFORMERS_HOME") or None,
        pooling=os.environ.get("BDH_POOLING") or None,
    )
    index = VectorIndex(encoder, state_dir, min_score=min_score_from_env())
    index.load()
    return index


def serve(bind: str, port: int, app: MemoryApp) -> ThreadingHTTPServer:
    app.bind = bind
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
    vectors = build_vectors_from_env(store.directory)
    app = MemoryApp(model, store, load_token(), vectors)
    server = serve(args.bind, args.port, app)
    vector_note = f", vectors {len(vectors)}" if vectors is not None else ", vectors off"
    print(f"bdh associative memory listening on http://{args.bind}:{args.port} ({len(model.entities)} entities{vector_note}, cpu)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
