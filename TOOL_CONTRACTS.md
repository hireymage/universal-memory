# MCP tool contracts

All tools use JSON Schema generated from strict Zod schemas. Unknown top-level fields are rejected where the schema is an object. Limits are bounded. Advertised input schemas omit the draft `$schema` keyword and the long ISO calendar regex; `format` is `date` or `date-time`, and the server still validates the real calendar. `outputSchema` is omitted unless `advertise_output_schema` / `MEMORY_OUTPUT_SCHEMA` is set. Which tools appear is selected by `toolset` / `MEMORY_TOOLSET` (`minimal`, `standard`, `full`; default `full`). Every successful result is:

```json
{"ok":true,"data":{},"meta":{"api_version":"1","request_id":"uuid"}}
```

Failures use `ok:false`, a stable `error.code`, message, optional details, and MCP `isError:true`. The same envelope is returned as `structuredContent` and serialized text for compatibility.

## Memory and generic entities

| Tool | Input | Output `data` |
|---|---|---|
| `remember` | `{title, content?, entity_type?, metadata?, client?}` | entity summary |
| `recall`, `get_entity` | `{id}` | full entity with Markdown, metadata, path, revision, wikilinks |
| `search_memory`, `search_entities` | `{query?, types?, status?, tags?, limit:1..200}` | entity summaries/full indexed entities |
| `retrieve_context` | `{query, subject_id?, limit:1..20, related_limit?:0..50}` | full matching entities immediately; relation expansion is opt-in through `related_limit` |
| `retrieve_relevant_memory` | `{query,limit?:1..20}` | compact ranked evidence: ID, type, deterministic relevance, optional stored `summary_en`, source path/title and update time |
| `update_memory`, `update_entity` | `{id, expected_revision, patch:{title?,content?,metadata?}, client?}` | updated entity |
| `archive_memory` | `{id, expected_revision, client?}` | archived entity; no deletion |
| `get_context` | `{id, limit:1..100}` | compatibility read of one selected entity and bounded relations |
| `find_related` | `{id, limit:1..100}` | related entities and deterministic reasons |
| `create_entity` | `{entity_type,title,content?,metadata?,client?}` | created entity |
| `link_entities` | `{source_id,target_id,relation,expected_revision,client?}` | updated source entity |

## Domain tools

Domain tools use a discriminating `action` enum, which gives small models one unambiguous entry point per domain without advertising dozens of near-duplicate tools.

| Tool | Actions | Action-specific required fields |
|---|---|---|
| `people` | `create`, `update`, `get`, `search`, `list`, `birthdays`, `name_days`, `context` | mutations use revision; date queries require inclusive `from` and `to` ISO dates |
| `projects` | `create`, `update`, `get`, `search`, `list`, `archive`, `add_note`, `context` | mutations use revision; project create routes to its folder |
| `inbox` | `add`, `list`, `process`, `move` | process/move prepare a changeset and do not mutate immediately |
| `notes` | `create`, `update`, `search`, `link`, `related` | link uses source/target IDs and source revision |

`link_entity_to_project` is represented by `link_entities` with the project as source or target. This prevents two implementations of relationship behavior. Older convenience names can be added later as aliases without changing semantics.

`find_name_days` returns `{people, from, to, calendar}` inside `data`. `from`, `to`, and `calendar` are not siblings of `data`.

## Agent profiles

`agent_profiles` is the additive management tool for persistent agent identity,
Soul, roles and language policy. Actions are `list`, `get`, `create`,
`update_identity`, `deactivate`, `get_soul`, `update_soul`, `get_language`,
`update_language`, `list_roles`, `get_role`, `create_role`, `update_role`,
`activate_role`, `translation_status`, and `validate`. For identity, Soul, and
role content, mutations always include both `machine_en` and `human_cs`.
English is canonical; the server stores/validates the paired Czech inspection
representation but does not perform a hidden translation.

`agent_bootstrap({agent_id,known_profile_hash?,session_role?})` is the compact
runtime loader. It returns only English `machine_context`, active role, language
policy and profile version/hash. With a matching known hash it returns an
`unchanged` marker without resending the context. `session_role` is temporary:
it never modifies the persistent default role, identity, or Soul.

## Graph: resolve, relations, claims, sources

Thirteen tools implementing `Entity → Relation → Claim → Source` on top of the
same Markdown entities. Relations and claims live in entity frontmatter
(`relations`, `claims`) with an optional visible `## Relations` body section;
nothing outside the touched file is required. All graph writes carry the
entity's current revision (`CONFLICT` on mismatch) and append an audit event;
a rollback is a normal `prepare_rollback` → `restore` changeset.

Body representation of a structured relation (Obsidian-friendly, renders as nothing):

```markdown
## Relations
- [[Target Title]] <!-- rel:01JRELATIONULID -->
```

The marker comment is the link between the visible line and the structured
record. Lines without a marker are ordinary wikilinks and are never touched by
the graph API.

| Tool | Input | Output `data` | Behavior |
|---|---|---|---|
| `resolve_entity` | `{query, hint_id?, types?}` | `{resolved?, candidates[], ambiguous, hint?}` | Alias-index lookup: exact id/title (1.0) → normalized (0.9) → compact (0.8). Ambiguity never auto-selects; `hint_id` is only reported back as `hint_valid`, never used to pick. |
| `create_relation` | `{entity_id, relation_type, target_id, expected_revision, client?}` | `{source_id, target_id, relation, created, revision?}` | Idempotent by identity `(source, type, target)`: an existing identity returns unchanged without a write or audit event. First write collapses legacy `relationships` duplicates (reported as `legacy_collapsed`), writes the frontmatter record + marker line. |
| `get_entity_relations` | `{entity_id, limit:1..500}` | `{entity_id, entity_title, relations[] with resolved target}` | Reads through the legacy shim: legacy `relationships` entries appear with a deterministic `legacy-…` id and `legacy:true`; files are not rewritten. |
| `query_relations` | `{entity_id?, relation_type?, target_id?, direction? (outgoing/incoming/both), depth? (1..2), limit?}` | `{query, relations[]}` | Typed traversal over the edge store, cycle-safe. Without `entity_id` it scans the whole vault (use a `relation_type` filter). |
| `delete_relation` | `{entity_id, relation_id, expected_revision, client?}` | `{entity_id, relation_id, deleted}` | Removes the structured record and the marker line. Only structured ids can be deleted; legacy ids resolve to `NOT_FOUND` (rewrite through `create_relation` to collapse them first). |
| `create_claim` | `{entity_id, predicate, value, source_ids?, confidence?, valid_from?, close_existing?, expected_revision, client?}` | `{entity_id, claim, closed, conflicts[]}` | `source_ids` are validated against existing entities. Same-predicate open claims are reported as `conflicts`; with `close_existing` they are closed (`valid_to` = today, `status: superseded`) — old knowledge is kept, never destroyed. |
| `get_claims` | `{entity_id?, predicate?, source_id?, valid_at?, include_invalidated?, include_errors?, limit:1..500}` | claim list with entity info | Temporal filter: `valid_at` inside `[valid_from, valid_to]`; invalidated claims are hidden unless opened, and `recorded_in_error` claims are hidden unless `include_errors: true`. Without `entity_id` it scans the vault. |
| `update_claim` | `{entity_id, claim_id, patch, expected_revision, client?}` | `{entity_id, claim}` | Patched in place, history stays in the same file. |
| `invalidate_claim` | `{entity_id, claim_id, expected_revision, client?, reason?}` | `{entity_id, claim}` | `valid_to` = today, `status: invalidated`; the claim body stays (history is never destroyed). |
| `correct_claim` | `{entity_id, claim_id, value, reason, predicate?, source_ids?, valid_from?, confidence?, expected_revision, client?}` | `{entity_id, original, corrected}` | For a record that was wrong from the start: the original is kept verbatim, marked `status: recorded_in_error` with `error_reason`, `corrected_at`, `corrected_by`, and `valid_to` stays `null` (no invented close date); a new `current` claim is created in the same audited write, inheriting provenance and pointing back via `corrects`. Re-correcting an already erroneous claim is a `VALIDATION_ERROR`. |
| `find_suspect_claims` | `{source_id, predicate?, entity_id?, limit:1..1000}` | `{source_id, predicate, count, candidates[]}` | Read-only scan of claims sharing the provenance of a claim recorded in error; returns candidates with a `reason` and never writes, audits, or auto-fixes. The erroneous claim itself is never a candidate. |
| `create_source` | `{title, provider, conversation_id?, content_hash?, message_range?, original_file?, url?, if_exists? (error/return_existing)}` | `{created, id, path, existing?}` | Entity of `type: source`, routed to `Sources/{provider}/{date}-{slug}.md`. Exactly one of `conversation_id` / `content_hash` is required. `if_exists: return_existing` makes imports idempotent. |
| `get_source` | `{id}` | source entity | `NOT_FOUND` for non-`source` entities. |
| `find_source` | `{provider, conversation_id?} \| {provider, content_hash?}` | matching sources | Identity lookup over source entities. |

`superseded` means the fact genuinely changed over time (a closed window, `valid_to` set); `recorded_in_error` means the record was wrong from the start, so it is kept verbatim with an error marker and replaced by a linked correction via `corrects` — `get_claims` hides those records unless `include_errors: true`, and `get_entity_timeline` reports them in a dedicated `errors` bucket (with `counts.errors`) instead of past/present/planned.

Two protection rules hold everywhere:

1. `metadata.relations` and `metadata.claims` are rejected by the generic
  `update_memory`/`update_entity`/`create_entity`/`remember` patches
  (`VALIDATION_ERROR`) — they must change through the graph API so dedup,
  source validation, and audit are enforced. Legacy `relationships` stays
  writable for old clients.
2. `merge_entities` is a changeset operation, not an immediate mutation: a
  `merge` op inside `prepare_normalization` (`{entity_id, expected_revision,
  target_id, expected_target_revision}`) prepares a dry-run; `apply_changeset`
  validates every affected revision before the first write, rewrites external
  wikilinks, transfers aliases/relations/claims with identity dedup
  (`conflicts` are reported, never dropped), archives the source, and appends
  ONE audit event with before/after snapshots of every touched file. Rollback
  of that event restores the whole bundle via a `restore` changeset.

## Maintenance

| Tool | Input | Output / mutation behavior |
|---|---|---|
| `inspect_memory` | `{scope}` | inventory and diagnostics, read-only |
| `validate_memory` | `{scope}` | validation diagnostics, read-only |
| `find_broken_links` | `{scope}` | unresolved source/link records |
| `find_duplicates` | `{scope}` | compact-title candidate groups (`Novák` with `Novak`, and also `RTX 2070` with `rtx2070`), never merges |
| `suggest_links` | `{scope,limit}` | shared-tag suggestions, never writes |
| `scan_external_files` | `{scope,include_content?,max_content_chars?}` | unmanaged Markdown paths, hashes and optional bounded content; read-only |
| `prepare_file_adoption` | `{path,expected_revision,entity_type,title,metadata?}` | dry-run changeset that preserves the file body and adds managed frontmatter in place |
| `prepare_normalization` | `{description,scope,operations[]}` | persisted dry-run changeset only |
| `apply_changeset` | `{changeset_id,client?}` | validates every revision, then applies and audits |
| `migrate_schema` | `{target_version,scope}` | dry-run changeset only |
| `repair_relation_links` | `{scope?}` | dry-run changeset only | Rewrites legacy `- [[Title]] <!-- rel:ID -->` bullets to `- [[basename|Title]] <!-- rel:ID -->` so Obsidian resolves them. One-time migration for vaults written before this change; apply with `apply_changeset`. Reindex only if the neural sidecar was down during apply. Idempotent. |
| `reindex` | `{}` | rebuilt derived index counts |
| `health_report` | `{detail?:false,page?,page_size?}` | latest report summary. Default is compact: `last_run_at`, counts by severity and code, top 5 findings, changeset ids. `detail:true` pages findings. Read-only; on `minimal`, `standard`, and `full` |
| `run_health_check` | `{}` | runs one health pass and returns the compact summary. Writes the report and dry-run changesets under `audit_dir` only. Does not modify the vault, apply changesets, or reindex. On `full` only. Allowed while `read_only`, same as `prepare_normalization` |
| `audit_history` | `{action:"list",entity_id?,limit}` or `{action:"prepare_rollback",event_id}` | events or inverse dry-run changeset |

Scopes are a tagged union: `file`, `folder`, `entity_type`, `project`, `changed_since`, or `vault`. Scope filtering is applied before inspection, link checks, duplicate/link suggestions, and migrations. Project scope includes the project entity and entities carrying its stable ID in `projects` metadata.

## Stable error codes

- `NOT_FOUND`
- `VALIDATION_ERROR`
- `CONFLICT`
- `READ_ONLY`
- `AUTH_REQUIRED`
- `PATH_ESCAPE`
- `INTERNAL_ERROR`

Adding fields and tools is allowed in API v1. Removing fields, repurposing meanings, or weakening safety preconditions requires a new API major version and migration documentation.

`retrieve_context` is the first-choice read operation for a new information request. Its `query` accepts a raw user phrase or client-selected salient terms. The server performs deterministic local normalization and ranking, but intentionally does not claim to infer meaning or generate an answer. `subject_id` is an explicit caller-provided context reference; identity such as “I” must be resolved by the authenticated client or a future configured principal mapping, never hard-coded into the public API.

External files are never adopted implicitly. A client scans, reads the bounded content if needed, chooses semantic metadata, prepares adoption, and explicitly applies the returned changeset. The content hash is an optimistic-concurrency token, so a file edited in Obsidian after scanning causes `CONFLICT` instead of being overwritten.
