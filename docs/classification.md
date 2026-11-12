# Advisory classification on create (Step 10)

`createWithDedup` now returns an optional `classification` block alongside `dedup`:

```ts
classifyCreate(draft: EntityDraft, routes: Record<string, Route>): AdvisoryClassification | null
```

Pure function, no I/O, no network, no LLM. Returns `null` when nothing is advisory,
in which case `createWithDedup` omits the key entirely. Computed inside its own
try/catch: any failure degrades to the key being absent — the create never fails
and the caller's draft is never mutated.

`createWithDedup` then applies one routing policy the pure function does not:
when the numeric confidence is below `classification.inbox_confidence_threshold`
(default 0.5, override `MEMORY_INBOX_CONFIDENCE_THRESHOLD`), the item is stored
as `inbox` instead of the caller's type. Scores are `high` 0.9, `medium` 0.6,
`low` 0.3, and 1 when `classifyCreate` returns null. The default therefore parks
only `low`. A confident create stays on the requested type even if the threshold
is raised. The parked file keeps `suggested_type`, `classification_confidence`,
and `requested_type` in frontmatter. `triage_inbox` lists those files and can
prepare a dry-run changeset; `apply_changeset` does the write.

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
does not interpret free text with a model. The only write that follows from this
block is the low-confidence park into `inbox` described above; it does not invent
a type the rules did not already suggest.
