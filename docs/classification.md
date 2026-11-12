# Advisory classification on create (Step 10)

`createWithDedup` now returns an optional `classification` block alongside `dedup`:

```ts
classifyCreate(draft: EntityDraft, routes: Record<string, Route>): AdvisoryClassification | null
```

Pure function, no I/O, no network, no LLM. Returns `null` when nothing is advisory,
in which case `createWithDedup` omits the key entirely. Computed inside its own
try/catch: any failure degrades to the key being absent — the create never fails,
the draft is never mutated, and routing is never changed.

## Block shape

```json
{
  "suggested_type": "note",
  "suggested_collections": ["People/family"],
  "routing_notes": ["person with family hints routes flat to People/{slug}.md without metadata.member_of_collections pinning; consider pinning to People/family"],
  "confidence": "medium"
}
```

All fields except `confidence` are optional and only present when non-empty.

## Rule table (deterministic, first match wins)

Patterns run on the accent-stripped title (`Nováková` → `novakova`) with Unicode
letter boundaries `(?<!\p{L})…(?!\p{L})`. JavaScript `\b` is ASCII-only, even with
the `u` flag, so a word ending in a diacritic (`Rozhodnutí`, and the same class of
bug for `Poznámka` when the mark sits on a boundary) never used to match.

| Order | Signal | Type hint |
|---|---|---|
| 1 | A date and a time (`2026-11-12 14:30`, `12. 11. 2026` + `14:30`) | `event` |
| 2 | `mám rád` / `nemám rád` / `preferuji` / `prefer` (also feminine `ráda`) | `preference` |
| 3 | `TODO`, `to-do`, `koupit`, `udělat`, `do pátku`, or a `- [ ]` checkbox | `task` |
| 4 | `nápad` / `idea` | `idea` |
| 5 | `decision` / `decided` / `rozhodnutí` | `decision` |
| 6 | Kinship (including `maminka`, `tatínek`, `matka`, `otec`, `dcera`, `syn`, …) or `narozeniny` / `birthday` | `person` |
| 7 | `note` / `notes` / `memo` / `poznámka` / `poznámky` | `note` |

| Signal | Effect |
|---|---|
| Chosen type is loose (`memory`, `note`, `knowledge`, `inbox`) and a hint exists | `suggested_type` = hint |
| Explicit type strongly mismatched (kinship → person; decision word → decision) | `suggested_type` = hint |
| Person (chosen or suggested) with a kinship hint (`metadata.family: true`, kinship in the title, or kinship `metadata.relation`) and no `metadata.member_of_collections` pinning | `suggested_collections: ["People/family"]` + routing note. `narozeniny` alone does not pin the family collection |
| Chosen type has no configured route | routing note about the silent fallback to the `memory` route, plus `suggested_type` set to the nearest registry type (exact alias, otherwise similarity) when one is close enough |

Confidence: `high` when metadata and title corroborate the same kinship hint; `low` when the
type has no route at all; `medium` otherwise. The draft is never mutated.

## What this is NOT

Semantic/LLM classification (the `umm_fast` INGEST_CLASS JSON pattern: type, topic,
candidate entities, suggested actions) remains an agent-side pattern. The server
deliberately does not interpret content, choose types, or write anything based on
classification — it only reports deterministic hints for the calling agent to act on.
