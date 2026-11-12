import http.client
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from bdh_memory.model import AssociativeBDH
from bdh_memory.server import MemoryApp, make_handler, serve
from bdh_memory.store import StateStore


def _get(url: str, token: str | None = None) -> tuple[int, dict]:
    headers = {}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))


def _raw(
    port: int,
    method: str,
    path: str,
    host: str | None = None,
    body: bytes | None = None,
    token: str | None = None,
    authorization: str | None = None,
    content_length: str | None = None,
) -> tuple[int, dict]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.putrequest(method, path, skip_host=True)
        connection.putheader("Host", host or f"127.0.0.1:{port}")
        if authorization is not None:
            connection.putheader("Authorization", authorization)
        elif token is not None:
            connection.putheader("Authorization", f"Bearer {token}")
        payload = body or b""
        if content_length is not None:
            connection.putheader("Content-Length", content_length)
        elif method == "POST":
            connection.putheader("Content-Length", str(len(payload)))
        connection.endheaders(payload if method == "POST" and content_length is None else b"")
        response = connection.getresponse()
        raw = response.read()
        return response.status, json.loads(raw.decode("utf-8"))
    finally:
        connection.close()


def _post(url: str, payload: dict, token: str | None = None) -> tuple[int, dict]:
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))


class SidecarApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.store = StateStore(Path(self.tmp.name))
        self.model = AssociativeBDH()
        self.app = MemoryApp(self.model, self.store, token="test-token")
        self.server = serve("127.0.0.1", 0, self.app)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]
        self.base = f"http://127.0.0.1:{self.port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def test_health_is_open_and_posts_require_the_bearer(self) -> None:
        with urllib.request.urlopen(f"{self.base}/health", timeout=5) as response:
            body = json.loads(response.read().decode("utf-8"))
        self.assertTrue(body["ok"])
        self.assertEqual(body["device"], "cpu")
        self.assertTrue(body["bdh"]["hebbian_sigma"])
        self.assertFalse(body["bdh"]["trained_encoder"])
        status, denied = _post(f"{self.base}/v1/associate", {"query": "Comandante"})
        self.assertEqual(status, 401)
        self.assertEqual(denied["error"]["code"], "AUTH_REQUIRED")
        status, ids_denied = _get(f"{self.base}/v1/ids")
        self.assertEqual(status, 401)
        self.assertEqual(ids_denied["error"]["code"], "AUTH_REQUIRED")

    def test_upsert_associate_remove_and_rebuild_roundtrip(self) -> None:
        notes = [
            {"id": "bridge", "title": "Ranní rituál", "aliases": [], "content": "Comandante mele a Lelit vaří.", "revision": "a"},
            {"id": "gift", "title": "Dárek od Evy", "aliases": ["narozeninový dárek"], "content": "Lelit dostala Eva k narozeninám a stojí v kuchyni.", "revision": "b"},
            {"id": "garden", "title": "Zahrada", "aliases": [], "content": "Tulipány kvetou na záhoně vedle kompostu.", "revision": "c"},
        ]
        for note in notes:
            status, body = _post(f"{self.base}/v1/upsert", note, token="test-token")
            self.assertEqual(status, 200, body)
            self.assertTrue(body["ok"])
        status, associated = _post(f"{self.base}/v1/associate", {"query": "Comandante", "limit": 5}, token="test-token")
        self.assertEqual(status, 200)
        self.assertTrue(associated["advisory"])
        ids = [hit["id"] for hit in associated["results"]]
        self.assertIn("gift", ids)
        self.assertNotIn("garden", ids)
        status, removed = _post(f"{self.base}/v1/remove", {"id": "gift"}, token="test-token")
        self.assertEqual(status, 200)
        self.assertTrue(removed["removed"])
        status, rebuilt = _post(f"{self.base}/v1/rebuild", {"entities": notes, "reset": True}, token="test-token")
        self.assertEqual(status, 200)
        self.assertEqual(rebuilt["indexed"], 3)
        self.assertTrue(self.store.exists())
        # A second chunk must not wipe the first when reset is false.
        status, appended = _post(
            f"{self.base}/v1/rebuild",
            {"entities": [{"id": "extra", "title": "Poznámka", "content": "Jiný text o ničem společném.", "aliases": []}], "reset": False},
            token="test-token",
        )
        self.assertEqual(appended["indexed"], 4)
        status, bad = _post(f"{self.base}/v1/associate", {"query": ""}, token="test-token")
        self.assertEqual(status, 400)
        self.assertEqual(bad["error"]["code"], "VALIDATION_ERROR")

    def test_ids_lists_revisions_and_not_note_text(self) -> None:
        status, body = _post(
            f"{self.base}/v1/upsert",
            {"id": "bridge", "title": "Secret title", "aliases": [], "content": "secret body", "revision": "rev-9"},
            token="test-token",
        )
        self.assertEqual(status, 200, body)
        status, denied = _get(f"{self.base}/v1/ids")
        self.assertEqual(status, 401)
        status, ids = _get(f"{self.base}/v1/ids", token="test-token")
        self.assertEqual(status, 200)
        self.assertEqual(ids["bdh"], {"bridge": "rev-9"})
        self.assertIsNone(ids["vector"])
        self.assertNotIn("secret", json.dumps(ids))
        self.app.vectors = type("Vectors", (), {"revisions": {"bridge": "vec-1"}})()
        status, with_vectors = _get(f"{self.base}/v1/ids", token="test-token")
        self.assertEqual(status, 200)
        self.assertEqual(with_vectors["vector"], {"bridge": "vec-1"})
        self.assertNotIn("secret", json.dumps(with_vectors))

    def test_non_loopback_without_a_token_is_refused(self) -> None:
        bare = MemoryApp(AssociativeBDH(n=32, k=2, seed=1), self.store, token="")
        with self.assertRaises(SystemExit):
            serve("0.0.0.0", 0, bare)


class InputLimitsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.store = StateStore(Path(self.tmp.name))
        self.app = MemoryApp(AssociativeBDH(n=32, k=2, seed=1), self.store, token="test-token")
        self.server = serve("127.0.0.1", 0, self.app)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]
        self.base = f"http://127.0.0.1:{self.port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def test_foreign_host_is_rejected_on_loopback(self) -> None:
        status, body = _raw(self.port, "GET", "/health", host="evil.example")
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["code"], "FORBIDDEN")
        status, ok = _get(self.base + "/health")
        self.assertEqual(status, 200)
        self.assertNotIn("state_dir", ok)

    def test_oversized_content_and_bad_length_are_rejected(self) -> None:
        status, body = _post(
            f"{self.base}/v1/upsert",
            {"id": "x", "title": "t", "aliases": [], "content": "a" * 100_001, "revision": "r"},
            token="test-token",
        )
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "VALIDATION_ERROR")
        status, bad = _raw(self.port, "POST", "/v1/upsert", body=b"{}", token="test-token", content_length="nope")
        self.assertEqual(status, 400)
        self.assertIn("Content-Length", bad["error"]["message"])

    def test_non_ascii_authorization_is_unauthorized(self) -> None:
        status, body = _raw(
            self.port,
            "POST",
            "/v1/associate",
            body=b'{"query":"hi"}',
            authorization="Bearer test-tok\u00e9",
        )
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], "AUTH_REQUIRED")


class HandlerFactorySmokeTest(unittest.TestCase):
    def test_make_handler_is_importable(self) -> None:
        self.assertTrue(callable(make_handler))


if __name__ == "__main__":
    os.environ.setdefault("BDH_BIND", "127.0.0.1")
    unittest.main()
