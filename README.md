# Universal Memory MCP

A vendor-neutral, local-first personal memory server. AI clients call semantic MCP tools; n8n and other automation can call the same application services through HTTP. Human-readable Markdown remains the source of truth, and the disposable in-memory index can always be rebuilt.

Current baseline: MCP `2026-07-28`, official TypeScript SDK `2.0.0`, stdio and Streamable HTTP. Legacy HTTP+SSE is intentionally absent.

## Safety defaults

- Existing vaults start with `read_only: true`.
- Writes use a temporary sibling file plus rename.
- Updates require the latest `revision`; stale writes fail with `CONFLICT`.
- Changing `metadata.type` through `update_memory` re-routes the file to that type's folder. The audit event records `rerouted`, `from_type`, `to_type`, `from_path`, and `to_path`. No other path moves a file because its folder looks wrong.
- Delete is not exposed. Archive is a metadata update.
- Maintenance prepares a dry-run changeset first; `apply_changeset` is separate.
- HTTP binds to `127.0.0.1` by default. Non-loopback bind refuses to start without a bearer token.
- Index and audit state live outside the vault content tree in the examples. The index is rebuilt in memory from Markdown; there is no `index.sqlite`.

## Tool catalogs

`MEMORY_TOOLSET` (or `toolset` in the config file) chooses which MCP tools are advertised. The default is **`full`**, so existing clients keep every current tool name. An unknown value refuses to start.

| Profile | What it advertises |
|---|---|
| `minimal` | `retrieve_context`, `search_memory`, `recall`, `remember`, `update_memory`, `archive_memory`, `find_related`, `search_people`, `find_name_days`, `resolve_entity`, `health_report` |
| `standard` | minimal, plus graph, claim, and source tools (`create_relation`, `create_claim`, `create_source`, `distill_next_chunk`, and the rest of that family) |
| `full` | every tool, including aliases (`people`, `notes`, …), maintenance (`apply_changeset`, `reindex`, `run_health_check`, …), and `agent_profiles` |

`standard` can prepare a merge changeset, but `apply_changeset` is maintenance and stays on `full`. The safety model does not change with the profile: `read_only` still defaults to true, writes still require `expected_revision`, nothing is deleted, and maintenance is still dry-run then `apply_changeset`.

`advertise_output_schema` (env `MEMORY_OUTPUT_SCHEMA`) repeats the same result envelope on every tool. It is off by default. Results are still returned as `structuredContent` and as a JSON text block. ISO dates are advertised as strings with `format: date` or `format: date-time`; the server still rejects invalid dates.

`npm run measure:tools` prints tools/list size per profile (js-tiktoken `o200k_base`).

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

Every title-create tool (`remember`, `create_entity`, `people` action=create, `projects` action=create, `record_project_decision`, `inbox` action=add, `notes` action=create) returns an optional additive `classification` block alongside `dedup`. It is computed locally by pure deterministic rules (no LLM, no I/O, no network). Hints are matched on an accent-stripped title with Unicode letter boundaries, so Czech words that end in a diacritic (`Rozhodnutí`, `Maminka`) match. The hint table covers task (`TODO`, `koupit`, `udělat`, `do pátku`, `- [ ]`), event (a date and a time), preference (`mám rád`, `nemám rád`, `preferuji`), idea (`nápad`), decision, person (kinship or `narozeniny`), and note. `suggested_type` is set when the chosen type is loose (`memory`, `note`, `knowledge`, `inbox`) or strongly mismatched. A type with no configured route still falls back to `memory`, and the block names the nearest known type (alias, otherwise similarity) instead of only warning. `suggested_collections` still advises pinning `People/family` for a person with kinship hints and no `metadata.member_of_collections`. `confidence` is `high`/`medium`/`low`. Strictly advisory: it never blocks a create, never mutates the draft, and never changes routing; any failure inside classification simply omits the key. Semantic/LLM classification remains an agent-side pattern. Details in [docs/classification.md](./docs/classification.md). Czech overview of types, routes, and the health check: [docs/typy-a-kontrola.md](./docs/typy-a-kontrola.md).

## Docker

```bash
cp config.docker.example.yml config.docker.yml
export MEMORY_VAULT_PATH=/absolute/path/to/vault
export MEMORY_API_TOKEN='replace-with-a-long-random-token'
docker compose up --build
```

The image is read-only; `/vault` and `/state` are mounts. Change `read_only` in the mounted config only after inspection and backup. The Compose port remains loopback-published.

## Entity types and routes

`src/domain/entity-types.ts` is the registry: canonical type, default route, aliases, and the frontmatter keys that are required or expected. `config.example.yml` and `config.docker.yml` route every type the server actually creates, including `event`, `preference`, `fact`, `topic`, and `conversation`. A vault's `routing` block overrides the default path. Creating an unknown type still lands on the `memory` route; the classification block suggests the nearest registry type and does not rewrite the draft.

## Health check

`HealthService` reads `storage.inspectFiles()` once and reports type/folder mismatches, unknown or unrouted types, missing required frontmatter, invalid dates (`birth_date`, `name_day`, and the other registered date keys), tag casing and duplicates, broken wikilinks, accent-insensitive duplicate titles, orphans, alias collisions, index drift, and (when `neural.enabled`) sidecar revision drift via `GET /v1/ids`.

The report is `${audit_dir}/health/latest.json` plus a dated history file. One audit event uses `operation: "health_check"` and the counts. Fixable issues become at most `health.max_changesets` dry-run changesets (about 50 operations each): a move or retype for a type/folder mismatch, a tag normalization update, or a relation-link repair. Nothing is applied. Index or sidecar drift adds `recommend_reindex`; reindex is not started.

`health.enabled` defaults to false. `health.interval_hours`, `startup_delay_s`, and `max_changesets` configure the timer. `MEMORY_HEALTH_INTERVAL_HOURS` overrides the interval. The timer uses `setInterval().unref()`, a single-flight lock, and a small jitter, and it starts only from `serve` when `transport` is `http` (not stdio, not one-shot commands).

- REST: `POST /api/v1/health/run` and `GET /api/v1/health/latest` (same bearer auth as the other `/api/v1` routes).
- CLI: `health`.
- MCP: `health_report` on `minimal`, `standard`, and `full` (compact summary; `detail: true` pages findings). `run_health_check` is on `full` only. Both are allowed while `read_only`, because they write under `audit_dir` the same way `prepare_normalization` does.

## Commands

- `serve`: stdio MCP or HTTP MCP + REST, selected by config. The health timer starts only for HTTP when `health.enabled` is true.
- `inspect`: read-only JSON report.
- `health`: one health pass. Writes the report and dry-run changesets under `audit_dir`. Does not modify the vault.
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

## Neural associative memory (experimental)

Optional add-on, disabled unless `neural.enabled` is true. A small CPU PyTorch sidecar (`neural/`) keeps a Dragon Hatchling-style Hebbian synaptic state under the state directory and answers `associate` (MCP and `GET /api/v1/associate`). The classic model still does the talking. Markdown, revisions, audit, and the read-only default are unchanged. If the sidecar is not running, writes succeed and `associate` returns an empty advisory result. Docker Compose starts it only with `--profile neural`. Czech write-up: [docs/neural-memory.md](./docs/neural-memory.md).

```bash
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install -r neural/requirements.txt
python neural/demo_associate.py
python -m pytest neural/tests
```

## Known MVP boundaries

- Full-text search is deterministic local substring/metadata search over the in-memory index rebuilt from Markdown. Embeddings are not required. An optional dense-vector list lives in the BDH sidecar (`BDH_VECTOR=1`) and drops hits at or below `neural.vector_min_score` (default 0).
- An experimental BDH associative-memory sidecar can be turned on beside the substring index. It is off by default, stores nothing in the vault, and the server keeps working if it is down. Learned hits are advisory. See [docs/neural-memory.md](./docs/neural-memory.md).
- Multi-file changesets validate all preconditions before writing, but POSIX filesystems cannot provide a single atomic rename across multiple files. Audit snapshots and recovery changesets limit impact; a future journal adapter can strengthen crash recovery.
- Exact semantic duplicate detection and content rewriting remain the caller LLM's job. The server only validates structured proposals.
- Multi-backend distributed transactions are a future port-level concern; the current guarantee is within the Markdown adapter.
