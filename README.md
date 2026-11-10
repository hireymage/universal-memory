# Universal Memory MCP

A vendor-neutral, local-first personal memory server. AI clients call semantic MCP tools; n8n and other automation can call the same application services through HTTP. Human-readable Markdown remains the source of truth, and the disposable in-memory index can always be rebuilt.

Current baseline: MCP `2026-07-28`, official TypeScript SDK `2.0.0`, stdio and Streamable HTTP. Legacy HTTP+SSE is intentionally absent.

## Safety defaults

- Existing vaults start with `read_only: true`.
- Writes use a temporary sibling file plus rename.
- Updates require the latest `revision`; stale writes fail with `CONFLICT`.
- Delete is not exposed. Archive is a metadata update.
- Maintenance prepares a dry-run changeset first; `apply_changeset` is separate.
- HTTP binds to `127.0.0.1` by default. Non-loopback bind refuses to start without a bearer token.
- Index and audit state live outside the vault content tree in the examples.

## Native macOS development

Requires Node.js 22 or newer. The server persists no database: Markdown is the only durable data format.

```bash
npm ci
cp config.example.yml config.yml
# Edit vault_root and keep read_only: true for the first inspection.
npm run build
node dist/cli.js --config config.yml inspect
node dist/cli.js --config config.yml reindex
node dist/cli.js --config config.yml serve
```

For local MCP clients, configure the command `node`, arguments `[/absolute/path/dist/cli.js, --config, /absolute/path/config.yml, serve]`, and stdio transport. Logs go only to stderr.

For HTTP, set `transport: http`. The endpoint is `http://127.0.0.1:3333/mcp`; REST is under `/api/v1`. Set the environment variable named by `http.bearer_token_env` to require bearer auth even on loopback.

## Existing Obsidian vault migration

1. Point `vault_root` at the vault with `read_only: true`.
2. Run `inspect`; no Markdown is changed.
3. Run `reindex`; only disposable state is written outside the vault.
4. Review malformed YAML, missing metadata, duplicate IDs, and broken links via MCP maintenance tools.
5. Adjust routing and prepare normalization/migration changesets.
6. Review their exact operations and revision preconditions.
7. Back up the vault, intentionally set `read_only: false`, and apply selected changesets.

Files created manually by Obsidian without managed frontmatter are reported by `scan_external_files`. Use `prepare_file_adoption` and then `apply_changeset` to preserve the Markdown body and add a stable ID and metadata in place. Adoption uses the scanned content hash for conflict detection and never happens silently.

The REST equivalents are `GET /api/v1/external-files`, `POST /api/v1/external-files/adoptions`, and `POST /api/v1/changesets/:id/apply`. This makes the same reconciliation workflow available to n8n and other automations without duplicating application logic.

## Entity timeline & claim correction over REST

The graph capabilities exposed over MCP (`get_entity_timeline`, `correct_claim`, `find_suspect_claims`) have REST parity:

- `GET /api/v1/entities/:id/timeline` — claims divided into `past` / `present` / `planned` buckets (deterministic order). Optional `?as_of=<ISO date>` evaluates validity windows at another point in time.
- `POST /api/v1/claims/:id/correct` — body: `{ entity_id, value, reason, expected_revision }` (all required; `entity_id` and `expected_revision` enforce optimistic concurrency). Optional: `predicate`, `source_ids`, `valid_from`, `confidence`, client via `x-client-id`. Marks the original claim `recorded_in_error` and creates the corrected claim with `corrects` provenance in ONE audited write. Errors: 400 (missing fields / validation), 404 (unknown entity/claim), 409 (stale revision).
- `GET /api/v1/claims/suspects?entity=<id>&source=<client|source_id>&limit=20` — read-only scan for sibling claims from the same source that may share the same error. Never fixes anything.

Responses mirror the MCP tools' `structuredContent.data` payloads; auth and error mapping are identical to every other `/api/v1` route.

## Folder index auto-sync

On every entity create (and on update that keeps/changes type), the server keeps `folder_collection` indexes in sync: an entity lands in an index when its routed path nests under the index's directory, or when the creator sets `metadata.member_of_collections: ["People/family", …]` explicitly (needed for flat routes like `People/{slug}.md` vs `People/family/index.md`). Sync is idempotent, best-effort (never fails the main write), with bounded revision-conflict retry. Known residuals: links are NOT removed when an entity moves/archives, and index writes bypass the audit sink (view maintenance, not content mutation). Numeric limit params (`limit`, `max_content_chars`) must be positive integers; invalid values return `400 VALIDATION_ERROR`.

## Bulk relation building (build_relations)

`build_relations` creates typed edges on one source entity from a spec list `[{target, type, inverse?}]` (max 100 specs per batch; empty batch, empty type/target, empty `inverse`, and duplicate identical `(type, target)` specs are rejected up front). Each `target` is resolved with `resolve_entity` semantics: stable id, exact title/alias, vault path, or normalized/compact alias. Ambiguity never auto-selects — the edge is skipped (`skipped_ambiguous`) and the ranked candidates are reported in the per-edge result; unresolvable targets are `skipped_not_found`, self-relations are `skipped_self_relation`.

Reciprocity is EXPLICIT: both edges are written. There is no automatic inverse anywhere in the model — relations are directed edges held on the source entity, identity is `(source, type, target_id)`. When a spec carries `inverse`, the reverse edge is written explicitly on the target entity through the same `createRelation` path, so idempotence, legacy-shim collapse, body markers, and audit are inherited per edge. An identical existing edge is `skipped_existing` — no duplicate, no extra audit event.

Default mode is best-effort: every edge is attempted independently and the report carries a per-edge status (`created`, `skipped_*`, `failed`) plus a `summary: {created, skipped, failed}` that counts forward and inverse edges alike. `all_or_nothing: true` pre-flights the whole batch (resolution, ambiguity, self-reference) and aborts with `VALIDATION_ERROR` listing every offending spec before any write. Documented limitation: a mid-batch `CONFLICT` after pre-flight (e.g. a concurrent revision bump) is reported as `failed` for that edge; rollback of a partially applied batch is out of scope.

## Advisory classification on create

Every title-create tool (`remember`, `create_entity`, `people` action=create, `projects` action=create, `record_project_decision`, `inbox` action=add, `notes` action=create) returns an optional additive `classification` block alongside `dedup`. It is computed locally by pure deterministic rules (no LLM, no I/O, no network): `suggested_type` when the chosen type is generic (`memory`) or strongly mismatched with the title evidence (kinship terms → `person`, `decision`/`rozhodnutí` → `decision`, `notes`/`poznámka` → `note`), `suggested_collections` (a person with family hints routed flat to `People/{slug}.md` without `metadata.member_of_collections` pinning is advised to pin `People/family`), and `routing_notes` flagging types with no configured route (silent fallback to the `memory` route). `confidence` is `high`/`medium`/`low`. Strictly advisory: it never blocks a create, never mutates the draft, and never changes routing; any failure inside classification simply omits the key. Semantic/LLM classification (the `umm_fast` INGEST_CLASS pattern: type, topic, candidate entities, suggested actions) remains an agent-side pattern, not a server feature. Details in [docs/classification.md](./docs/classification.md).

## Docker

```bash
cp config.docker.example.yml config.docker.yml
export MEMORY_VAULT_PATH=/absolute/path/to/vault
export MEMORY_API_TOKEN='replace-with-a-long-random-token'
docker compose up --build
```

The image is read-only; `/vault` and `/state` are mounts. Change `read_only` in the mounted config only after inspection and backup. The Compose port remains loopback-published.

## Commands

- `serve`: stdio MCP or HTTP MCP + REST, selected by config.
- `inspect`: read-only JSON report.
- `reindex`: rebuild the disposable RAM index from Markdown.

## Verification

```bash
npm run typecheck
npm run lint
npm test
npm run build
docker build -t universal-memory-mcp .
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for boundaries, schema, risks, and evolution rules, and [TOOL_CONTRACTS.md](./TOOL_CONTRACTS.md) for the public MCP surface.
For persistent multi-agent identity, Soul, roles, language policy, and runtime loading, see [AGENT_PROFILES_ARCHITECTURE.md](./AGENT_PROFILES_ARCHITECTURE.md).

## Known MVP boundaries

- Full-text search is deterministic local substring/metadata search; the index port is ready for FTS/vector/hybrid adapters, but embeddings are not required or implemented.
- Multi-file changesets validate all preconditions before writing, but POSIX filesystems cannot provide a single atomic rename across multiple files. Audit snapshots and recovery changesets limit impact; a future journal adapter can strengthen crash recovery.
- Exact semantic duplicate detection and content rewriting remain the caller LLM's job. The server only validates structured proposals.
- Multi-backend distributed transactions are a future port-level concern; the current guarantee is within the Markdown adapter.
