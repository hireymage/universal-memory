"""Vector layer tests. A deterministic bag-of-words encoder stands in for the model,
so these run without downloading weights."""

import tempfile
import unittest
from pathlib import Path

import torch

from bdh_memory.model import AssociativeBDH
from bdh_memory.server import MemoryApp, rebuild, upsert, remove, associate
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
        self.assertEqual([i for i, _ in self.index.search("sqlite", 5)], ["b"])

    def test_persistence_round_trip(self):
        self.index.upsert("a", "t", [], "sqlite database", "r1")
        self.index.save()
        reloaded = VectorIndex(BagOfWordsEncoder(), self.dir)
        reloaded.load()
        self.assertEqual(len(reloaded), 1)
        self.assertEqual(reloaded.search("database", 1)[0][0], "a")

    def test_empty_index_returns_nothing(self):
        self.assertEqual(self.index.search("anything", 5), [])

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
        self.assertEqual(associate(self.app, {"query": "ocean"})["vector_results"][0]["id"], "new")

    def test_vectors_off_reports_unavailable(self):
        self.app.vectors = None
        out = associate(self.app, {"query": "database"})
        self.assertFalse(out["vector_available"])
        self.assertEqual(out["vector_results"], [])


if __name__ == "__main__":
    unittest.main()
