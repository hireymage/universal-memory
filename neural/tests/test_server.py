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

    def test_ids_reads_revisions_off_a_real_vector_index(self) -> None:
        import torch
        from bdh_memory.vectors import VectorIndex

        class Encoder:
            dim = 4

            def encode(self, texts):
                rows = [torch.ones(self.dim) for _ in texts]
                return torch.stack(rows) if rows else torch.zeros((0, self.dim))

        index = VectorIndex(Encoder(), Path(self.tmp.name) / "vectors")
        self.assertTrue(hasattr(index, "revisions"))
        self.assertTrue(index.upsert("bridge", "Secret title", [], "secret body", "vec-9"))
        self.app.vectors = index
        status, ids = _get(f"{self.base}/v1/ids", token="test-token")
        self.assertEqual(status, 200, ids)
        self.assertEqual(ids["vector"], {"bridge": "vec-9"})
        self.assertNotIn("secret", json.dumps(ids))
        status, created = _post(
            f"{self.base}/v1/upsert",
            {"id": "bridge", "title": "Secret title", "aliases": [], "content": "secret body", "revision": "rev-9"},
            token="test-token",
        )
        self.assertEqual(status, 200, created)
        status, ids = _get(f"{self.base}/v1/ids", token="test-token")
        self.assertEqual(status, 200, ids)
        self.assertEqual(ids["bdh"], {"bridge": "rev-9"})
        self.assertEqual(ids["vector"], {"bridge": "rev-9"})
        self.assertNotIn("secret", json.dumps(ids))

    def test_non_loopback_without_a_token_is_refused(self) -> None:
        bare = MemoryApp(AssociativeBDH(n=32, k=2, seed=1), self.store, token="")
        with self.assertRaises(SystemExit):
            serve("0.0.0.0", 0, bare)


class HandlerFactorySmokeTest(unittest.TestCase):
    def test_make_handler_is_importable(self) -> None:
        self.assertTrue(callable(make_handler))


if __name__ == "__main__":
    os.environ.setdefault("BDH_BIND", "127.0.0.1")
    unittest.main()
