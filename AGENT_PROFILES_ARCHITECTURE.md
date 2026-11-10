# Agent profiles: extension design

## Scope and compatibility

This is an additive domain on top of Universal Memory MCP. It does not replace
the existing factual memory, `MemoryService`, Markdown adapter, search index,
audit trail, changesets, MCP transport, or REST transport.

The effective runtime configuration is deliberately composed as:

```text
Identity + Soul + selected role + language policy = agent runtime profile
Shared Universal Memory                         = facts and durable knowledge
Client-owned conversation/session               = temporary state
```

An agent profile never duplicates the shared factual memory. Existing entity
types and tools keep their current meanings.

## Markdown model

The profile is stored as normal managed Markdown entities under configurable
routes. The default routing is:

```text
Agents/{agent_id}/identity.en.md
Agents/{agent_id}/identity.cs.md
Agents/{agent_id}/soul.en.md
Agents/{agent_id}/soul.cs.md
Agents/{agent_id}/roles/{role_id}.en.md
Agents/{agent_id}/roles/{role_id}.cs.md
```

Every language pair has two independently readable Markdown files, but one
logical component. Both carry `agent_id`, `component_key`, `representation`,
`canonical_language: en`, `component_version`, and `canonical_hash` metadata.
The English entity is canonical. The Czech entity declares which English
component/hash/version it represents. Settings (enabled, default role, and
language policy) live in the identity metadata, not in a separate personality
document.

`profile_version` and `profile_hash` are computed from active identity, Soul,
and the effective default role. A client can send `known_profile_hash` to
`agent_bootstrap`; unchanged profiles return only a compact unchanged marker.

## Translation rule

MCP validates and persists supplied structured content; it is not an LLM or a
translation service. Mutating profile calls therefore require both `machine_en`
and `human_cs` when creating or changing a translatable component. This makes
the client/LLM that understood a Czech request provide its English canonical
representation and Czech inspection representation in one safe operation.

If a previously valid Czech representation becomes stale (for example after a
manual external edit or a partial recovery), `agent_profiles` with
`translation_status` and `validate` reports it. `prepare_translation_sync`
returns a dry-run proposal, including the exact English source that a caller
must translate; `apply_changeset` remains the explicit write step. An optional
future `TranslationProvider` can fill that proposal, but no core operation
depends on it.

## Service and API

`AgentProfileService` uses `MemoryService` and existing generic entity storage.
It owns profile invariants, not transports or filesystem code. MCP exposes a
single grouped `agent_profiles` tool for management actions and a discoverable,
small `agent_bootstrap` tool for runtime loading. REST mirrors the same service
under `/api/v1/agents` and `/api/v1/agents/:agentId/bootstrap`.

Persistent role activation changes only `default_role`. Passing `session_role`
to `agent_bootstrap` selects a role for that response only; it never writes the
identity or Soul.

## Runtime loop

1. A tiny client bootstrap identifies `agent_id` and calls `agent_bootstrap`.
2. The client injects only `machine_context` (English), never the Czech files.
3. For a user request, the client calls `retrieve_relevant_memory` when facts
   might be relevant; that call returns summaries/rank evidence, not the whole
   vault. It then reads full entities only when needed.
4. After a meaningful interaction, the client LLM decides `IGNORE`, `CREATE`,
   `UPDATE`, `MERGE`, or `SUPERSEDE`; existing `remember`, `update_memory`,
   `link_entities`, and changeset tools execute the structured choice.

The server never claims that it autonomously inferred relevance, translated a
document, or decided that a conversation deserves permanent storage.

## Safety

- Profile writes use the existing atomic Markdown write and per-file revision
  checks; each profile pair is preflighted before either file is changed.
- Existing audit events include `client` and snapshots for every profile entity.
- Deletion is archival/deactivation, never destructive file deletion.
- Validation detects missing components, duplicate agent IDs, invalid language
  codes, invalid/default roles, malformed metadata, and stale Czech pairs.
- Normal Markdown manual edits remain visible after reindex. They are detected
  as profile integrity diagnostics rather than silently accepted as a new
  canonical configuration.
