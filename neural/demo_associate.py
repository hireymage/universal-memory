#!/usr/bin/env python3
"""Show associative recall finding a note that plain substring search misses.

The bridge note mentions Comandante and Lelit together. The gift note mentions
Lelit and never mentions Comandante. A substring search for Comandante cannot
see the gift. After the bridge note is read, Hebbian synapses connect the two
words, so the query recalls the gift note.

Run from the repository root:

    python neural/demo_associate.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from bdh_memory.model import AssociativeBDH  # noqa: E402

NOTES = [
    {
        "id": "bridge",
        "title": "Ranní rituál",
        "aliases": [],
        "content": "Comandante mele a Lelit vaří.",
    },
    {
        "id": "gift",
        "title": "Dárek od Evy",
        "aliases": ["narozeninový dárek"],
        "content": "Lelit dostala Eva k narozeninám a stojí v kuchyni.",
    },
    {
        "id": "garden",
        "title": "Zahrada",
        "aliases": [],
        "content": "Tulipány kvetou na záhoně vedle kompostu.",
    },
]

QUERY = "Comandante"


def substring_hits(query: str, notes: list[dict[str, object]]) -> list[str]:
    needle = query.casefold()
    hits: list[str] = []
    for note in notes:
        haystack = " ".join([str(note["title"]), str(note["content"]), *note["aliases"]]).casefold()  # type: ignore[misc]
        if needle in haystack:
            hits.append(str(note["id"]))
    return hits


def main() -> None:
    memory = AssociativeBDH()
    for note in NOTES:
        memory.upsert(str(note["id"]), str(note["title"]), list(note["aliases"]), str(note["content"]))
    lexical = substring_hits(QUERY, NOTES)
    associated = memory.associate(QUERY, limit=10)
    titles = {str(note["id"]): str(note["title"]) for note in NOTES}
    print("BDH associative memory demo")
    print("encoder: fixed sparse code (not a trained BDH encoder)")
    print("recall:  Hebbian sigma readout, slow weights consolidated per note")
    print()
    print(f"Query: {QUERY}")
    print()
    print("Substring search (the query string must occur in the note):")
    if not lexical:
        print("  (no hits)")
    for entity_id in lexical:
        print(f"  - {titles[entity_id]} [{entity_id}]")
    print()
    print("Associative recall (advisory; synapse overlap, not a fact):")
    if not associated:
        print("  (no hits)")
    for hit in associated:
        print(f"  - {titles.get(hit.id, hit.id)} [{hit.id}]  score={hit.score:.4f}")
    print()
    lexical_ids = set(lexical)
    associated_ids = [hit.id for hit in associated]
    recalled_only = [entity_id for entity_id in associated_ids if entity_id not in lexical_ids]
    if "gift" in recalled_only and "gift" not in lexical_ids and "garden" not in associated_ids:
        print("Result: substring search misses 'Dárek od Evy'. Associative recall finds it, because Comandante and Lelit fired together in the bridge note. The unrelated garden note is not returned.")
        return
    print("Result: the demo did not separate the gift note from substring search.")
    print(f"  substring={lexical}")
    print(f"  associate={associated_ids}")
    raise SystemExit(1)


if __name__ == "__main__":
    main()
