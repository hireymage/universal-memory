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

| Signal | Effect |
|---|---|
| Title matches `decision`/`decided`/`rozhodnutí` | type hint `decision` |
| Title contains a kinship term (mother, father, wife, husband, son, daughter, brother, sister, bratr, sestra, mama, tata, grandmother, grandfather) | type hint `person` |
| Title matches `note`/`notes`/`memo`/`poznámka`/`poznámky` | type hint `note` |
| Chosen type is generic (`memory`) and a hint exists | `suggested_type` = hint |
| Explicit type strongly mismatched (kinship → person; decision → decision) | `suggested_type` = hint |
| Person (chosen or suggested) with family hint (kinship in title, `metadata.family: true`, or kinship `metadata.relation`) and no `metadata.member_of_collections` pinning | `suggested_collections: ["People/family"]` + routing note (flat person route vs `People/family/index.md`, collection-sync rule B) |
| Chosen type has no configured route in `config.yml` | routing note about the silent fallback to the `memory` route |

Confidence: `high` when metadata and title corroborate the same hint; `low` when the
type has no route at all; `medium` otherwise.

## What this is NOT

Semantic/LLM classification (the `umm_fast` INGEST_CLASS JSON pattern: type, topic,
candidate entities, suggested actions) remains an agent-side pattern. The server
deliberately does not interpret content, choose types, or write anything based on
classification — it only reports deterministic hints for the calling agent to act on.
