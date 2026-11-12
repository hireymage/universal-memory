# Universal Memory MCP

Status: accepted MVP architecture, 2026-08-11

## 1. Product boundary

Universal Memory MCP is a vendor-neutral personal memory service. Markdown files are the durable source of truth in the first storage implementation. MCP and HTTP are adapters over one application layer; neither transport owns business logic. The core performs deterministic reading, validation, indexing, routing, linking, conflict detection, and safe writes. Natural-language interpretation remains the caller's responsibility.

The MVP is production-oriented but deliberately bounded: local full-text search is implemented without embeddings; authentication is bearer-token or disabled for loopback development; rollback is event-based and supports restoring retained snapshots. Optional LLM maintenance is only an extension port and is not required at runtime.

## 2. Current MCP baseline and explicit trade-off

The implementation targets MCP specification `2026-07-28` and the stable official TypeScript SDK v2 packages (`@modelcontextprotocol/server` and `@modelcontextprotocol/express`). The standard transports are stdio and Streamable HTTP. Legacy HTTP+SSE is not implemented.

The specification requires structured tool schemas, deterministic discovery, per-request metadata in the 2026 protocol era, and validation of Streamable HTTP origins. The SDK supplies protocol negotiation and wire behavior. Compact responses send one JSON text block. `MEMORY_RESPONSE=full` also sends `structuredContent` and the `meta` envelope for older clients.

Important evolution rule: the public tool names and meanings are additive. Existing fields are not repurposed. Breaking changes require a new tool name or major API version and a documented compatibility window.

## 3. Layers and dependency direction

```text
MCP stdio / MCP Streamable HTTP / REST HTTP
                    |
             Transport adapters
                    |
             Application services
                    |
         Domain model + policy + schemas
                    |
       Storage / Index / Audit abstractions
                    |
 MarkdownStorage  InMemoryIndex  JsonlAuditLog
```

Dependencies point inward. Domain code does not import Node filesystem, MCP, Express, Obsidian, SQLite, or an LLM SDK. A composition root constructs adapters and injects them into services.

### Ports

- `EntityStorage`: get, create, update, archive, scan, apply changeset.
- `SearchIndex`: rebuild, upsert, remove, query, backlinks, date queries.
- `AuditSink`: append immutable events and retrieve rollback material.
- `Clock` and `IdGenerator`: deterministic tests.
- Future `MaintenanceIntelligenceProvider`: optional structured proposals only; never needed by core.

`StorageRouter` maps entity type to backend plus a configurable path template. Today all types use `markdown`; later `person` can select Apple Contacts while `project` selects PostgreSQL without changing services or transports.

## 4. Domain model

`Entity` is the common aggregate:

```yaml
id: 01J...                 # stable ULID, independent of path/title
type: person               # extensible lower-case identifier
title: Ada Lovelace
created_at: 2026-08-11T10:00:00.000Z
updated_at: 2026-08-11T10:00:00.000Z
aliases: [Augusta Ada King]
tags: [mathematics]
status: active
schema_version: 1
revision: sha256:...       # content revision used for optimistic concurrency
```

The body is normal Markdown. Type-specific optional frontmatter is intentionally small:

- `person`: `birth_date`, `name_day`, `relationships`, `companies`.
- `project`: `started_at`, `completed_at`, `people`, `companies`.
- `inbox`: `captured_at`, `source`.
- `note`/`knowledge`: no required additional fields.

Relationships are reconstructable from frontmatter entity IDs and/or `[[wikilinks]]`. IDs are canonical; readable wikilinks remain first-class. Unknown frontmatter keys are preserved on round trips.

### Knowledge graph layer: Entity → Relation → Claim → Source

Phase F adds three graph constructs on top of the same entity aggregate, all
stored in the file's frontmatter (Markdown stays the single canonical truth):

```yaml
relations:
  - {id: 01JRELATIONULID, type: installed_in, target_id: 01JBOARD, created_at: "...", updated_at: "..."}
claims:
  - {id: 01JCLAIMULID, predicate: cores, value: 6, source_ids: [01JSOURCE],
     confidence: 0.95, valid_from: 2020-01-01, valid_to: null, status: current,
     created_at: "...", updated_at: "..."}
```

```text
   Source (entity type:source)                 Claim (temporal fact)
   provider + conversation_id ─────referenced above──────────┐
   or content_hash                                           │
                                                             ├─ source_ids[]
   Entity ──relations (typed edge)──▶ Entity                 │
     CPU ──installed_in──▶ Motherboard ◀──claims about├──────┘
```

Design decisions:

- **Relation identity** is `(source_id, type, target_id)`. `create_relation`
  is idempotent — an existing identity returns unchanged without a write.
  The body carries a `## Relations` section with ``- [[Target]] <!-- rel:ID -->``
  markers so the visible graph and the structured record stay one construct.
- **Legacy shim**: entities only carrying the write-only legacy
  `relationships` key are served through `normalizeRelations`, which derives a
  stable synthetic id `legacy-<sha256(source|type|target)[:12]>` without
  rewriting the file. Collapse into structured relations happens only on
  writes through the relation API (audited).
- **Claim** is a temporal, sourced fact (`predicate`, YAML value,
  `valid_from`/`valid_to` with `null` meaning current, optional `confidence`
  and `status`). New knowledge closes old knowledge (`close_existing` →
  `valid_to` + `superseded`); conflicting knowledge is represented
  (`conflicts[]`) and never auto-decided. Invalidated claims stay in the file.
- **Source** is an entity of `type: source` with `provider` plus exactly one
  of `conversation_id` / `content_hash` as its import identity:
  this is what makes chat-conversation import idempotent against re-imports.
- **Guardrail**: `metadata.relations` / `metadata.claims` cannot be written
  through generic `create`/`update` patches — only through the graph API, so
  dedup, source validation, and audit always apply. Legacy `relationships`
  stays writable.
- The alias/edge index (`SearchIndex`) is derived state, rebuildable from
  Markdown; graph queries fall back to storage scans when it is cold.

## 5. Routing and filesystem semantics

Routing lives in configuration, never domain policy:

```yaml
routing:
  project: { backend: markdown, path: "02 Projects/{slug}/index.md" }
  person: { backend: markdown, path: "People/{slug}.md" }
  note: { backend: markdown, path: "03 Knowledge/{slug}.md" }
  knowledge: { backend: markdown, path: "03 Knowledge/{slug}.md" }
  inbox: { backend: markdown, path: "01 Inbox/{date}-{slug}.md" }
```

Paths are resolved under `vault_root`, normalized, and rejected if they escape it. Slugs are human-readable and collision-safe. Existing entities are found by stable ID through the rebuildable index, so manual rename/move does not change identity. A scan discovers all `.md` files, reparses metadata and links, and repairs index paths without rewriting files.

An explicit `update_memory` (or any `memory.update`) whose patch changes `metadata.type` re-routes the file onto that type's configured path. The caller must pass `expected_revision`. The audit event for that update records `rerouted`, `from_type`, `to_type`, `from_path`, and `to_path` in addition to the before/after snapshots. Nothing else moves a file because a health check noticed the folder. The health check only prepares a dry-run changeset.

Known types, their default routes, aliases, and required frontmatter live in `src/domain/entity-types.ts`. Config routing overrides the default path. A type with no route still falls back to the `memory` route; classification then suggests the nearest known type instead of only warning.

## 6. Markdown adapter and index

Writes use a sibling temporary file, flush/close, then atomic rename. Before every update the adapter rereads the file and compares `expected_revision` against the SHA-256 revision of the current canonical bytes. A mismatch returns a typed conflict and writes nothing.

The search index is an in-process `InMemoryIndex` rebuilt from Markdown. It is not a SQL database and it is not written to `index.sqlite`. It holds entity metadata, normalized searchable text, outbound links, backlink edges, and calendar fields for the life of the process. Restarting the server drops it; `reindex` rebuilds it from the vault and is the repair step after bulk manual edits. Audit events stay in JSONL under `audit_dir`, outside the vault.

Search modes:

- `text`: local token/full-text matching, always available offline.
- `metadata`: exact filters and indexed calendar queries.
- Future `semantic` and `hybrid`: optional index providers; never required for reads/writes.

## 7. Changesets, normalization, and rollback

All multi-step maintenance follows two phases:

1. `prepare_normalization` or `prepare_changeset` reads a scope and returns an immutable proposal containing operations, base revisions, diagnostics, and a `changeset_id`. No content changes occur.
2. `apply_changeset` requires the ID and expected base revisions. It validates paths, schemas, IDs, link targets, read-only state, and conflicts, then writes. If validation or any precondition fails, nothing is applied.

The MVP file adapter stages every new file before commit. Existing bytes needed for rollback are retained in the audit area. An append-only JSONL event records timestamp, operation, entity, client identity when supplied, before/after revisions, diff summary, and snapshot references. `rollback_change` prepares a new inverse changeset rather than erasing history.

`dry_run` is true by default for normalization and schema migrations. The server never invents semantic rewrites. For content understanding, an LLM reads entities, proposes structured patch operations, and the server validates and applies them.

Scope union:

- `{kind: "file", path}`
- `{kind: "folder", path}`
- `{kind: "entity_type", entity_type}`
- `{kind: "project", entity_id}`
- `{kind: "changed_since", timestamp}`
- `{kind: "vault"}`

## 8. Public tool surface

To prevent tool overload for smaller models, the default surface has stable domain tools and a compact maintenance surface. Closely related operations use explicit `action` enums. All responses share an envelope: `{ok, data, error?, meta:{request_id, api_version}}`. Errors use stable codes such as `NOT_FOUND`, `VALIDATION_ERROR`, `CONFLICT`, `READ_ONLY`, `AUTH_REQUIRED`, and `INTERNAL_ERROR`.

### General memory and entities

| Tool | Purpose | Required input | Output data |
|---|---|---|---|
| `remember` | Store a durable memory with inferred type supplied by caller | `title`, `content`; optional `entity_type`, metadata, client | entity summary |
| `recall` | Retrieve one entity by stable ID | `id` | entity including Markdown |
| `find` | One query across fulltext, vectors, and neural associations, with inline filters | `query`; optional `detail`, `order` | compact ranked hits |
| `search_memory` | Search across types | `query`; optional filters, limit, `verbose` | ranked summaries |
| `update_memory` | Update title/body/metadata with concurrency | `id`, patch, `expected_revision` | updated entity |
| `archive_memory` | Non-destructively archive | `id`, `expected_revision` | entity summary |
| `retrieve_context` | Universal cross-category retrieval | query, optional explicit subject ID, limits | full matching entities and deterministic graph evidence |
| `get_context` | Compatibility context around a known entity | stable ID, limits | entity and relations |
| `find_related` | Deterministic links/backlinks/shared metadata | `id`; optional limit | related entities with reasons |
| `create_entity` | Extensible primitive | `entity_type`, `title`, `content` | entity summary |
| `get_entity` | Extensible primitive | `id` | entity |
| `update_entity` | Extensible primitive | `id`, patch, `expected_revision` | entity |
| `search_entities` | Extensible primitive | filters/query | summaries |
| `link_entities` | Add typed reconstructable relation | source/target IDs, relation, revision | updated source |

### Domain tools

| Tool | Operations / input | Output |
|---|---|---|
| `inbox` | `action: add|list|process|move`, action-specific payload | items and optional changeset |
| `triage_inbox` | list, or `decisions` that prepare a retype changeset | inbox items; changeset only when decisions are passed |
| `notes` | `action: create|update|search|link|related` | entities/results |
| `people` | `action: create|update|get|search|list|birthdays|name_days|context`; date-window inputs are explicit ISO dates | people/results |
| `projects` | `action: create|update|get|list|search|archive|add_note|link|context` | projects/results |

The grouped tools implement the requested semantic operations while keeping the advertised list small. REST exposes conventional aliases (`POST /v1/memory`, `GET /v1/people/birthdays`, etc.) over the same methods. Generic entity tools are escape hatches, not the preferred interface for known types.

### Maintenance tools

| Tool | Purpose | Key input | Output |
|---|---|---|---|
| `inspect_memory` | Scan without mutation | scope | inventory and diagnostics |
| `validate_memory` | Schema/path/link consistency | scope | issues with severity and locations |
| `prepare_normalization` | Deterministic or caller-proposed normalization | scope, mode, proposed patches | stored changeset |
| `apply_changeset` | Explicit atomic apply | changeset ID; optional client | result and audit event |
| `find_duplicates` | Candidate duplicates, never auto-merge | scope, threshold | candidate groups with reasons |
| `find_broken_links` | Unresolved wikilinks/IDs | scope | link diagnostics |
| `suggest_links` | Lexical/metadata suggestions only | scope, limit | suggestions, never writes |
| `migrate_schema` | Prepare/apply schema migration | scope, target version, dry-run/apply | changeset/result |
| `reindex` | Rebuild derived state | optional scope | counts and diagnostics |
| `audit_history` | Inspect events or prepare rollback | filters/action | events or inverse changeset |

Each concrete JSON Schema is generated from Zod in code. The server validates that schema (`additionalProperties: false` where the object is strict, enums, bounded limits, and real ISO dates). The advertised copy is compact unless `verbose_schema` / `MEMORY_VERBOSE_SCHEMA` is set: flattened unions, no defaults, ISO `format` (`date` / `date-time`) without the long calendar regex. The shared output envelope is not repeated as `outputSchema` unless `advertise_output_schema` (or `MEMORY_OUTPUT_SCHEMA`) is on. `TOOL_CONTRACTS.md` contains the human-readable catalog. `MEMORY_TOOLSET` selects `minimal`, `standard`, or `full` (default `standard`). `MEMORY_TOOL_DISCOVERY=eager` lists every selected tool; the default `lazy` keeps full-only groups behind `tool_groups`.

### Graph tools

| Tool | Purpose | Key input | Output |
|---|---|---|---|
| `resolve_entity` | Category-independent reference resolution | query, optional hint and type filter | single resolution or ranked ambiguous candidates (never auto-selects) |
| `create_relation` | Idempotent typed edge with visible marker | source, type, target, revision | relation with `created` flag and new revision |
| `get_entity_relations` | Typed relations incl. legacy shim view | entity id | normalized edges with resolved targets |
| `query_relations` | Typed traversal (both directions, depth 1–2) | filters over the edge store | cycle-safe relation list |
| `delete_relation` | Remove record + marker line only | entity, relation id, revision | deletion confirmed; unrelated wikilinks untouched |
| `create_claim` / `update_claim` / `invalidate_claim` / `get_claims` | Temporal, sourced facts over frontmatter claims | subject, predicate/value, validity window | conflicts represented; closes with `superseded`, never deletes history |
| `create_source` / `get_source` / `find_source` | Idempotent conversation/import provenance | provider + `conversation_id` XOR `content_hash` | source entity under `Sources/` |
| `merge_entities` (via changeset) | Duplicate consolidation as one audited bundle | both entity ids + both revisions | all-or-nothing apply with one audit event and bundle rollback |

## i7-8700K — the graph model end to end

One runnable contract example: entities, typed relations, temporal claims, and
a conversation source, all regular Markdown.

```text
Sources/claude/2026-10-07-cpu-spec-chat.md        (type: source, conversation_id: conv-123)
03 Knowledge/intel-core-i7-8700k.md               (entity "Intel Core i7-8700K",
                                                   claims: cores=6, threads=12)
```

```bash
# provenance first
create_source   {title: "Chat: 8700K spec", provider: "claude", conversation_id: "conv-123"}
# facts, each tied to that source
create_claim    {entity_id: 01JCPU, predicate: "cores", value: 6, source_ids: [01JSRC], confidence: 0.98}
create_claim    {entity_id: 01JCPU, predicate: "threads", value: 12, source_ids: [01JSRC], confidence: 0.98}
create_relation {entity_id: 01JCPU, relation_type: "installed_in", target_id: 01JMOTHERBOARD, expected_revision: <cpu rev>}
create_relation {entity_id: 01JCPU, relation_type: "located_in", target_id: 01JCHASSIS, expected_revision: <rev>}
create_relation {entity_id: 01JCPU, relation_type: "paired_with", target_id: 01JGPU, expected_revision: <rev>}
create_relation {entity_id: 01JCPU, relation_type: "used_for", target_id: 01JPROJECT, expected_revision: <rev>}
```

Resulting entity file (body excerpt) — structured record and visible line are
one construct:

```markdown
## Relations
- [[Z390 Board]] <!-- rel:01JRELATIONULID -->
```

Six years later the machine is rebuilt — the new claim closes the old
knowledge, history stays queryable:

```bash
create_claim {entity_id: 01JCPU, predicate: "installed_until", value: "2026-10-07", close_existing: true, valid_from: "2020-01-01"}
get_claims   {entity_id: 01JCPU, valid_at: "2023-01-01"}   # still answers as of that date
```

## 9. HTTP API and authentication

The HTTP process serves:

- `/mcp`: Streamable HTTP via the official SDK.
- `/api/v1/*`: REST routes over application services.
- `/healthz` and `/readyz`: no vault contents.

Default bind is `127.0.0.1`. Non-loopback binding requires configured bearer authentication. Allowed origins are explicit; absent/invalid browser origins are handled according to the transport specification. Reverse-proxy deployment must terminate TLS and pass authenticated identity. Tokens come only from environment variables or mounted secret files, never repository config.

stdio logs only to stderr. HTTP request limits, schema validation, path containment, rate-limit hook, redaction, and timeouts reduce common abuse. Markdown is treated as untrusted data and never executed.

## 10. Existing-vault workflow

First run never rewrites existing files:

1. Start with `read_only: true`.
2. `inspect_memory` with vault scope.
3. `reindex` to build disposable metadata.
4. Review unknown types, duplicate IDs, malformed YAML, route mismatches, and broken links.
5. Configure mapping/routing.
6. `prepare_normalization` or `migrate_schema` in dry-run.
7. Review exact operations and base revisions.
8. Disable read-only intentionally and call `apply_changeset`.

Malformed or externally created files remain readable through inspection and are never silently rewritten. `scan_external_files` identifies them using their path and content hash. `prepare_file_adoption` creates a dry-run changeset; explicit apply atomically adds canonical frontmatter while preserving the original Markdown body. A changed hash aborts with a conflict. A later audited `move` operation can relocate the adopted entity without changing its stable ID.

## 11. Repository layout

```text
src/
  domain/          entities, errors, validation, changesets
  application/     services and use cases
  ports/           storage, index, audit interfaces
  adapters/
    markdown/      Markdown/Obsidian storage
    index/         in-memory search index rebuilt from Markdown
    audit/         JSONL audit and snapshots
  transports/
    mcp/           tool catalog and stdio/HTTP adapters
    http/          REST adapter
  config/          validated configuration
  composition.ts   dependency injection
  cli.ts           serve/inspect/reindex commands
tests/fixtures/vault/
config.example.yml
Dockerfile
docker-compose.yml
```

## 12. Risks and controls

| Risk | Control / trade-off |
|---|---|
| Manual edit races with server write | required revision token and last-moment reread |
| Crash during multi-file commit | staged files, journaled intent, recovery scan; filesystem rename atomicity is only guaranteed per file |
| YAML parser changes formatting | preserve body and unknown keys; rewrite only explicit mutations; dry-run diff |
| Duplicate/missing IDs in old vault | report first; never silently assign during read-only inspection |
| Link ambiguity after rename | stable IDs in metadata plus aliases and index diagnostics |
| Index drift | files remain authoritative; full reindex and incremental freshness checks |
| Path traversal/symlinks | canonical root containment and no-follow validation |
| Remote data exposure | loopback default, origin allowlist, auth required off-loopback, TLS at proxy |
| Tool proliferation | grouped domain tools plus five generic primitives; additive versions |
| Optional semantic search leaks data | opt-in provider port; offline lexical path remains complete |
| Multi-backend transactions | future adapters need saga/prepare semantics; MVP guarantees atomicity only within Markdown backend |

## 13. Acceptance gates

- Unit/integration coverage for entity CRUD, routing, projects, people/date windows, inbox, search, manual changes, wikilinks, broken links, dry-run/apply, conflicts, reindex, migration, and rollback.
- Typecheck, lint, tests, build.
- MCP stdio handshake/tool call smoke test and Streamable HTTP smoke test.
- REST smoke test.
- Docker build and fixture-vault execution smoke test.
- No test accesses a real user vault.
