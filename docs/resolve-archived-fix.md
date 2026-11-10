# Archived entities in `resolve_entity` — fix note

## Problem

`merge_entities` archives the duplicate stub but leaves it in the index. `InMemoryIndex.resolveLookup` iterated `this.entities.values()` with no status filter and `GraphService.resolve` filtered only by `types`, so a canonical entity and its archived stub were both candidates:

```
resolve_entity("Jan Novák") -> ambiguous: true, candidates: [canonical, archived stub]
```

Seven production queries were affected (names anonymized in this repository): `Jan Novák`, `Honza`, `Eva Nováková`, `Eva Svobodová`, `Anna Nováková`, `Petr Novák`, `Tomáš Novák`. Alias-collision reporting was inflated by the same effect (98 -> 102).

This is resolver/index semantics, not vault data. Renaming, deleting, or alias-stripping archived entities is not acceptable.

## Semantics chosen

Archived entities **stay indexed**:

- addressable by stable ID (`get_entity`, `storage.get`)
- auditable (`audit_history`, snapshots, rollback)
- restorable (`restore` / rollback makes them resolvable again)
- still valid wikilink targets (`find_broken_links`, `backlinks` unchanged)
- still returned by `search_entities` (explicit `status` filter available)

They are invisible to **resolution** (`resolveLookup`), **alias-collision reporting** (`aliasCollisions`) and **date windows** (`dateWindow` / `find_birthdays` / name days) unless the caller opts in.

Default: `include_archived: false`.

## Changes

| file | change |
|---|---|
| `src/ports/index.ts` | `ArchivedVisibility { includeArchived?: boolean }`; `resolveLookup`, `aliasCollisions`, `dateWindow` take it |
| `src/adapters/index/in-memory-index.ts` | single private `isVisible(entity, visibility)` predicate applied in `resolveLookup`, `aliasCollisions`, `dateWindow`; rebuild and upsert share it, so cold start and writes cannot drift |
| `src/application/graph-service.ts` | `ResolveInput.include_archived` (default false), echoed in the response as `include_archived` |
| `src/transports/mcp/server.ts` | `resolve_entity` schema gains `include_archived: z.boolean().default(false)` |
| `src/application/maintenance-service.ts` | merge identifier-eligibility check passes `{ includeArchived: true }` deliberately — a wikilink may legitimately target an archived duplicate file, and silently redirecting it would destroy intent |

## Deliberately unchanged

- `backlinks`, `linksFrom`, `edgesFrom`, `edgesTo` — graph traversal and wikilink integrity must see archived files.
- `search_entities` — no implicit hiding; status filtering is explicit.
- `findSources` — source identity lookups are not alias resolution.
- No entity renamed, deleted, or stripped of aliases. No vault file touched.

## Tests

`tests/resolve-archived.test.ts` (12 tests) against `tests/fixtures/vault` — a read-only fixture mirroring the real post-merge state (canonical active + archived stub with identical title, and identical alias for Jan/Eva).

Coverage: the seven queries resolve to exactly one active canonical entity; archived stubs never appear by default; `include_archived: true` restores ambiguity; archived ID not a candidate by default but is with opt-in; `memory.get`/`storage.get` still return archived entities; `archive()` write path equals rebuild path; a fresh `compose()` + `reindex()` reproduces identical results (restart simulation); `restore()`/rollback makes the entity resolvable again; `aliasCollisions` and `dateWindow` exclude archived claimants by default and include them on opt-in; search/retrieveContext unchanged; audit history and before/after snapshots intact.

```
npm run typecheck  -> clean
npm run lint       -> clean
npm run build      -> clean
npm test           -> 85 passed (6 files); 73 before the change
```

## Real-vault verification (read-only, separate process, no restart)

```
Jan Novák       default: ambiguous=false n=1 -> 01KZRAWNR9RYCRBNQ5WCJT6WY7 [exact] | include_archived: ambiguous=true n=2
Honza              default: ambiguous=false n=1 -> 01KZRAWNR9RYCRBNQ5WCJT6WY7 [exact] | include_archived: ambiguous=true n=2
Eva Nováková  default: ambiguous=false n=1 -> 01KZRAWNQNAAC3DEAAKHEF5NNZ [exact] | include_archived: ambiguous=true n=2
Eva Svobodová default: ambiguous=false n=1 -> 01KZRAWNQNAAC3DEAAKHEF5NNZ [exact] | include_archived: ambiguous=true n=2
Anna Nováková    default: ambiguous=false n=1 -> 01KZRAWNPPGZQDNHB307E44QZR [exact] | include_archived: ambiguous=true n=2
Petr Novák      default: ambiguous=false n=1 -> 01KZRAWNPGTCABNPENP5DNEQWQ [exact] | include_archived: ambiguous=true n=2
Tomáš Novák        default: ambiguous=false n=1 -> 01KZRAWNQFFDH6594AKZSJF0Y9 [exact] | include_archived: ambiguous=true n=2
archived stub by ID: default candidates = 0 | opt-in = 1
get_entity archived stub: Jan Novák | status archived
files 680 valid 678 alias collisions 85   (was 102)
birthdays 2026: Tomáš, Petr, Anna, Eva (no archived duplicates)
archived searchable via search: 7
broken links: 52 (unchanged)
```

## Open risk before deploy

`src/migration/phase3.ts` calls `services.graph.resolve(...)` without `include_archived`. If a migration probe ever targets an archived entity it will now report no candidates. Migration runs operate on active entities, so this is not currently triggered — but it is the one call site worth re-checking before a deploy that includes migration stages.
