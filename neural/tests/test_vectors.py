"""Vector layer tests. A deterministic bag-of-words encoder stands in for the model,
so these run without downloading weights."""

import os
import tempfile
import threading
import unittest
from pathlib import Path

import torch

from bdh_memory.model import AssociativeBDH
from bdh_memory.server import MemoryApp, rebuild, upsert, remove, associate, min_score_from_env
from bdh_memory.store import StateStore
from bdh_memory.vectors import VectorIndex, passage_text, query_text

VOCAB = ["sqlite", "database", "garden", "tomato", "rozhodnuti", "pamet", "neural", "ocean"]


class BagOfWordsEncoder:
    dim = len(VOCAB)

    def encode(self, texts):
        rows = []
        for text in texts:
            words = text.lower().replace("\n", " ").split()
            vec = torch.zeros(self.dim)
            for index, term in enumerate(VOCAB):
                vec[index] = sum(1.0 for word in words if term in word)
            norm = vec.norm()
            rows.append(vec / norm if norm > 0 else vec)
        return torch.stack(rows) if rows else torch.zeros((0, self.dim))


class VectorIndexTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.index = VectorIndex(BagOfWordsEncoder(), self.dir)

    def test_ranks_the_matching_entity_first(self):
        self.index.upsert("a", "Database decision", [], "We chose sqlite for the database.", "r1")
        self.index.upsert("b", "Garden", [], "Tomato plants in the garden.", "r1")
        self.index.min_score = -1
        hits = self.index.search("sqlite database", 2)
        self.assertEqual(hits[0][0], "a")
        self.assertGreater(hits[0][1], hits[1][1])

    def test_same_revision_is_not_reembedded(self):
        self.assertTrue(self.index.upsert("a", "t", [], "sqlite", "r1"))
        self.assertFalse(self.index.upsert("a", "t", [], "sqlite", "r1"))
        self.assertTrue(self.index.upsert("a", "t", [], "tomato", "r2"))

    def test_remove_drops_the_entity_from_results(self):
        self.index.upsert("a", "t", [], "sqlite", "r1")
        self.index.upsert("b", "t", [], "ocean", "r1")
        self.assertTrue(self.index.remove("a"))
        self.index.min_score = -1
        self.assertEqual([i for i, _ in self.index.search("sqlite", 5)], ["b"])
        self.assertNotIn("a", [i for i, _ in self.index.search("sqlite", 5)])

    def test_persistence_round_trip(self):
        self.index.upsert("a", "t", [], "sqlite database", "r1")
        self.index.save()
        reloaded = VectorIndex(BagOfWordsEncoder(), self.dir)
        reloaded.load()
        self.assertEqual(len(reloaded), 1)
        self.assertEqual(reloaded.search("database", 1)[0][0], "a")

    def test_empty_index_returns_nothing(self):
        self.assertEqual(self.index.search("anything", 5), [])

    def test_single_note_still_matches_without_mean_centring(self):
        self.index.upsert("only", "Database", [], "sqlite database", "r1")
        hits = self.index.search("database", 5)
        self.assertEqual([i for i, _ in hits], ["only"])
        self.assertGreater(hits[0][1], 0)

    def test_passage_and_query_prefixes(self):
        self.assertTrue(passage_text("Title", ["Alias"], "body").startswith("passage: Title Alias"))
        self.assertEqual(query_text(" hledám "), "query: hledám")


class ServerVectorTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        model = AssociativeBDH(n=256, k=4, decay=0.9, seed=1)
        store = StateStore(self.dir)
        self.app = MemoryApp(model, store, token="", vectors=VectorIndex(BagOfWordsEncoder(), self.dir))

    def test_upsert_associate_and_remove_cover_both_layers(self):
        upsert(self.app, {"id": "n1", "title": "DB", "content": "sqlite database decision", "revision": "r1"})
        out = associate(self.app, {"query": "database", "limit": 5})
        self.assertTrue(out["vector_available"])
        self.assertEqual(out["vector_results"][0]["id"], "n1")
        remove(self.app, {"id": "n1"})
        self.assertEqual(associate(self.app, {"query": "database"})["vector_results"], [])

    def test_rebuild_with_reset_replaces_vectors(self):
        upsert(self.app, {"id": "old", "title": "x", "content": "ocean", "revision": "r"})
        rebuild(self.app, {"entities": [{"id": "new", "title": "t", "content": "sqlite", "revision": "r"}], "reset": True})
        self.assertEqual(len(self.app.vectors), 1)
        replaced = associate(self.app, {"query": "sqlite"})["vector_results"]
        self.assertEqual(replaced[0]["id"], "new")
        self.assertNotIn("old", [hit["id"] for hit in associate(self.app, {"query": "ocean"})["vector_results"]])

    def test_request_min_score_overrides_the_index_floor(self):
        upsert(self.app, {"id": "n1", "title": "DB", "content": "sqlite database decision", "revision": "r1"})
        upsert(self.app, {"id": "n2", "title": "Garden", "content": "tomato garden", "revision": "r1"})
        strict = associate(self.app, {"query": "database", "limit": 5, "min_score": 0.5})
        wide = associate(self.app, {"query": "database", "limit": 5, "min_score": -1})
        self.assertIn("n1", [hit["id"] for hit in strict["vector_results"]])
        self.assertTrue(all(hit["score"] > 0.5 for hit in strict["vector_results"]))
        self.assertGreaterEqual(len(wide["vector_results"]), len(strict["vector_results"]))
        with self.assertRaises(ValueError):
            associate(self.app, {"query": "database", "min_score": "high"})

    def test_vectors_off_reports_unavailable(self):
        self.app.vectors = None
        out = associate(self.app, {"query": "database"})
        self.assertFalse(out["vector_available"])
        self.assertEqual(out["vector_results"], [])


class ScriptedEncoder:
    """Two orthogonal directions so cosine signs are obvious after centring."""

    dim = 2

    def encode(self, texts):
        rows = []
        for text in texts:
            rows.append(torch.tensor([1.0, 0.0]) if "match" in text.lower() or "database" in text.lower() else torch.tensor([0.0, 1.0]))
        return torch.stack(rows) if rows else torch.zeros((0, self.dim))


class VectorFloorTest(unittest.TestCase):
    def setUp(self):
        self.index = VectorIndex(ScriptedEncoder(), Path(tempfile.mkdtemp()))
        self.index.upsert("match", "match", [], "database", "r1")
        self.index.upsert("other", "other", [], "unrelated", "r1")

    def test_default_floor_does_not_pad_limit_with_negative_cosine(self):
        hits = self.index.search("database", 5)
        self.assertEqual([i for i, _ in hits], ["match"])
        self.assertGreater(hits[0][1], 0)

    def test_min_score_argument_can_keep_or_drop_the_match(self):
        self.assertEqual({i for i, _ in self.index.search("database", 5, min_score=-2)}, {"match", "other"})
        self.assertEqual([i for i, _ in self.index.search("database", 5, min_score=0.99)], ["match"])
        self.assertEqual(self.index.search("database", 5, min_score=1.1), [])

    def test_default_floor_is_zero_without_an_override(self):
        self.assertEqual(self.index.min_score, 0.0)
        self.assertEqual([i for i, _ in self.index.search("database", 5)], ["match"])

    def test_concurrent_upsert_cannot_retarget_inflight_scores(self):
        errors: list[str] = []

        def searcher() -> None:
            for _ in range(40):
                try:
                    for entity_id, _score in self.index.search("database", 5, min_score=-2):
                        if entity_id not in {"match", "other"}:
                            errors.append(entity_id)
                except Exception as error:  # noqa: BLE001 — the test records any race
                    errors.append(repr(error))

        def writer() -> None:
            for generation in range(40):
                self.index.upsert("other", "other", [], "unrelated", f"r{generation}")
                self.index.remove("other")

        threads = [threading.Thread(target=searcher), threading.Thread(target=writer)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])


class MinScoreEnvTest(unittest.TestCase):
    def test_reads_a_finite_floor_and_rejects_garbage(self):
        previous = os.environ.get("BDH_VECTOR_MIN_SCORE")
        try:
            os.environ["BDH_VECTOR_MIN_SCORE"] = "0.2"
            self.assertEqual(min_score_from_env(), 0.2)
            os.environ["BDH_VECTOR_MIN_SCORE"] = "nope"
            with self.assertRaises(SystemExit):
                min_score_from_env()
            os.environ["BDH_VECTOR_MIN_SCORE"] = "nan"
            with self.assertRaises(SystemExit):
                min_score_from_env()
        finally:
            if previous is None:
                os.environ.pop("BDH_VECTOR_MIN_SCORE", None)
            else:
                os.environ["BDH_VECTOR_MIN_SCORE"] = previous


if __name__ == "__main__":
    unittest.main()
