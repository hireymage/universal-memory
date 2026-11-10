import tempfile
import unittest
from pathlib import Path

import torch

from bdh_memory.model import AssociativeBDH, fast_sigma
from bdh_memory.store import StateStore


BRIDGE = {
    "id": "bridge",
    "title": "Ranní rituál",
    "aliases": [],
    "content": "Comandante mele a Lelit vaří.",
}
GIFT = {
    "id": "gift",
    "title": "Dárek od Evy",
    "aliases": ["narozeninový dárek"],
    "content": "Lelit dostala Eva k narozeninám a stojí v kuchyni.",
}
GARDEN = {
    "id": "garden",
    "title": "Zahrada",
    "aliases": [],
    "content": "Tulipány kvetou na záhoně vedle kompostu.",
}


def load_demo(memory: AssociativeBDH) -> None:
    for note in (BRIDGE, GIFT, GARDEN):
        memory.upsert(note["id"], note["title"], note["aliases"], note["content"])


class HebbianRulesTest(unittest.TestCase):
    def test_fast_sigma_wires_the_next_word_and_forgets_direction_until_symmetrized(self) -> None:
        memory = AssociativeBDH(n=64, k=1, decay=0.5, seed=7)
        codes = memory.encoder.codes(["comandante", "lelit"])
        sigma = fast_sigma(codes, decay=0.5)
        presynaptic = int(codes[0].argmax())
        postsynaptic = int(codes[1].argmax())
        self.assertGreater(float(sigma[presynaptic, postsynaptic]), 0.0)
        # The online rule is directional: the later word has not yet fired as Y.
        self.assertEqual(float(sigma[postsynaptic, presynaptic]), 0.0)
        # A one-token context has no co-activation, so it contributes no synapse.
        self.assertEqual(float(memory._delta(["comandante"]).sum()), 0.0)

    def test_associate_finds_the_note_substring_search_misses(self) -> None:
        memory = AssociativeBDH()
        load_demo(memory)
        gift_text = f"{GIFT['title']} {GIFT['content']} {' '.join(GIFT['aliases'])}".casefold()
        self.assertNotIn("comandante", gift_text)
        hits = memory.associate("Comandante", limit=10)
        ids = [hit.id for hit in hits]
        self.assertIn("bridge", ids)
        self.assertIn("gift", ids)
        self.assertNotIn("garden", ids)
        scores = {hit.id: hit.score for hit in hits}
        self.assertGreater(scores["bridge"], scores["gift"])
        self.assertGreater(scores["gift"], 0.05)

    def test_a_long_note_is_not_diluted_below_the_collision_floor(self) -> None:
        memory = AssociativeBDH()
        load_demo(memory)
        memory.upsert("long", "Dlouhá poznámka", [], "Lelit je tu jen jednou. " + " ".join(f"slovo{i}xx" for i in range(80)))
        hits = {hit.id: hit.score for hit in memory.associate("Comandante", limit=10)}
        self.assertIn("long", hits)
        self.assertNotIn("garden", hits)
        self.assertGreater(hits["long"], hits["gift"] * 0.2)

    def test_remove_retracts_the_bridge_and_drops_the_association(self) -> None:
        memory = AssociativeBDH()
        load_demo(memory)
        self.assertTrue(memory.remove("bridge"))
        self.assertFalse(memory.remove("bridge"))
        ids = [hit.id for hit in memory.associate("Comandante", limit=10)]
        self.assertNotIn("gift", ids)
        self.assertNotIn("bridge", ids)

    def test_upsert_replaces_synapses_when_the_text_changes(self) -> None:
        memory = AssociativeBDH()
        load_demo(memory)
        before = memory.synapse.sigma.clone()
        memory.upsert("bridge", "Ranní rituál", [], "Tulipány a kompost, žádný mlýnek.")
        self.assertFalse(torch.equal(before, memory.synapse.sigma))
        ids = [hit.id for hit in memory.associate("Comandante", limit=10)]
        self.assertNotIn("gift", ids)

    def test_unchanged_revision_does_not_rewrite_sigma(self) -> None:
        memory = AssociativeBDH()
        memory.upsert("bridge", BRIDGE["title"], [], BRIDGE["content"], revision="rev-1")
        snapshot = memory.synapse.sigma.clone()
        result = memory.upsert("bridge", BRIDGE["title"], [], BRIDGE["content"], revision="rev-1")
        self.assertTrue(result["unchanged"])
        self.assertTrue(torch.equal(snapshot, memory.synapse.sigma))

    def test_state_roundtrip_keeps_the_ranking(self) -> None:
        memory = AssociativeBDH(n=128, k=4, seed=11)
        load_demo(memory)
        expected = [(hit.id, hit.score) for hit in memory.associate("Comandante", limit=5)]
        with tempfile.TemporaryDirectory() as tmp:
            store = StateStore(Path(tmp))
            store.save(memory)
            restored = AssociativeBDH(n=128, k=4, seed=11)
            restored.load_payload(store.load())
        got = [(hit.id, hit.score) for hit in restored.associate("Comandante", limit=5)]
        self.assertEqual(expected, got)

    def test_incompatible_state_is_refused(self) -> None:
        memory = AssociativeBDH(n=32, k=2, seed=1)
        memory.upsert("bridge", BRIDGE["title"], [], BRIDGE["content"])
        payload = memory.state_dict_payload()
        other = AssociativeBDH(n=64, k=2, seed=1)
        with self.assertRaises(ValueError):
            other.load_payload(payload)

    def test_rebuild_resets_then_appends(self) -> None:
        memory = AssociativeBDH()
        load_demo(memory)
        indexed = memory.rebuild([GARDEN], reset=True)
        self.assertEqual(indexed, 1)
        self.assertEqual(set(memory.entities), {"garden"})
        memory.rebuild([BRIDGE, GIFT], reset=False)
        self.assertEqual(set(memory.entities), {"garden", "bridge", "gift"})
        ids = [hit.id for hit in memory.associate("Comandante", limit=10)]
        self.assertIn("gift", ids)


if __name__ == "__main__":
    unittest.main()
