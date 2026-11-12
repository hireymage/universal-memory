# Security

Markdown in the vault is the source of truth. The server does not execute Markdown. The default safety model is unchanged: `read_only` defaults to true, writes require the revision token, deletion is archive-only except the migration rollback path, changesets are dry-run until `apply_changeset`, and mutations are audited.

This note lists the issues found in the audit, what changed, and what is still an operator choice. Keep vault contents and tokens out of issue reports.

## Findings

| Severity | Issue | Status |
| --- | --- | --- |
| High | Vault reads and writes followed directory and file symlinks, so a path that looked inside the vault could read or write outside it (`move`, adopt, `collection_path`, `getByPath`). Scans already skipped symlinks. | Fixed. Symlinks are refused. `follow_symlinks: true` or `MEMORY_ALLOW_SYMLINKS=1` restores the old behaviour. |
| High | Changeset ids and audit event ids were joined onto filenames. `apply_changeset` with `../…` could read a JSON file outside the audit directory and, if it parsed as a prepared changeset, apply it. | Fixed. Ids must match `[A-Za-z0-9][A-Za-z0-9_-]{0,200}`, and the resolved path must stay inside the audit directory. Symlinks under the audit directory are refused. |
| High | `torch.load(..., weights_only=True)` is still exploitable before torch 2.10 (CVE-2025-32434, CVE-2026-24747). A replaced `bdh.pt` or `vectors.pt` could run code as the sidecar user. | Fixed. State files are refused below torch 2.10. The image installs `torch>=2.10.0`. `BDH_ALLOW_UNSAFE_TORCH=1` opts out. |
| High | ChatGPT and Claude zip imports inflated an entry with no output cap and read the whole export into memory. A small zip can expand to gigabytes. The central-directory offsets also did not match the ZIP spec, so size fields on a real archive were not the sizes. | Fixed. The archive cap is 2 GiB and one entry is 512 MiB (`maxOutputLength` on inflate), high enough for a multi-year export. `MEMORY_EXPORT_MAX_BYTES` and `MEMORY_EXPORT_ENTRY_MAX_BYTES` raise either cap. Entry names with `..`, absolute paths, or a local/central name mismatch are rejected. The parser follows the ZIP spec. |
| Medium | Binding HTTP to `0.0.0.0` (the container config) did not enable the MCP SDK host or Origin checks, so a browser could DNS-rebind onto the published port. Loopback binds were already protected. | Fixed. Loopback still requires a localhost Host. A published bind requires the bearer token and rejects a browser Origin that is not localhost or `http.allowed_origins`. Host is not forced to localhost, because a LAN client sends its own IP and an attacker who can set Host can send `localhost` anyway. Set `http.allowed_hosts` to restrict Host. `MEMORY_HTTP_ALLOW_ANY_HOST=1` turns both checks off. |
| Medium | The Python sidecar did not check `Host`. With neural memory on and no token, a browser could DNS-rebind to `127.0.0.1:8091` and read or poison the index. | Fixed for loopback binds. `BDH_ALLOW_ANY_HOST=1` opts out. A non-loopback bind still refuses to start without a bearer token. |
| Medium | `GET /readyz` was unauthenticated, scanned the whole vault, and returned `String(error)`, which can include absolute paths. | Fixed. Readiness is a `stat` of the vault root. Failures return a fixed message. |
| Medium | HTTP 500 responses and some conflict errors returned Node or absolute filesystem paths. | Fixed. Unknown errors are `Internal error` (details go to stderr). Conflict text uses the vault-relative path. |
| Medium | Frontmatter and config YAML allowed alias expansion (default 100). A crafted note could amplify memory during scan. `gray-matter` also depended on js-yaml 3.15.1 (GHSA-2883-xcg3-v3hh). The server parses frontmatter with the `yaml` package, not js-yaml. | Fixed. `maxAliasCount: 10`. js-yaml is overridden to 3.15.2. Non-mapping frontmatter is rejected. |
| Medium | Relation ids, entity titles, and index paths were interpolated into regular expressions and into `[[wikilinks]]`. A title or id with quantifiers could ReDoS a merge, a relation delete, or collection sync, and a title containing `]]` could inject Markdown into another note. | Fixed. Patterns are escaped. Newlines and brackets cannot close the link. `#` is kept, so `Issue #12` and a file named `C#` still resolve. |
| Medium | `POST /api/v1/health/run` and `POST /api/v1/reindex` had no rate limit. | Fixed. 6 requests per minute for those two routes together. `MEMORY_HTTP_RATE_LIMIT=0` disables it; a positive integer sets the cap. |
| Medium | The sidecar accepted a 64 MiB body, unbounded note text, and published `state_dir` on the unauthenticated `/health` response. `Content-Length` that was not an integer crashed the handler. | Fixed. 16 MiB body, 100k characters of content, 1000 entities per rebuild (the TypeScript client sends 40), 2k character queries. `/health` no longer includes the state path. |
| Medium | Turning the vector layer on could download an embedding model from Hugging Face. | Fixed. Downloads stay off unless `BDH_ALLOW_MODEL_DOWNLOAD=1`. The image already sets `HF_HUB_OFFLINE=1` and bakes the weights in. |
| Medium | Compose published the API on `0.0.0.0` by default. | Fixed. The default publish address is `127.0.0.1`. `UMM_BIND=0.0.0.0` publishes it on every interface. |
| Medium | Optimistic revision checks were not atomic with the write. Two overlapping updates with the same revision could both succeed. | Fixed. Vault mutations take a process-wide re-entrant lock. |
| Medium | Runtime dependencies had published advisories: MCP SDK request-body and cross-client issues, Zod memory use on large schemas, body-parser, `proxy-addr`, `qs`, `@hono/node-server` static-path decoding. | Fixed by the version pins in `package.json`. |
| Low | Bearer comparison was not constant-time, on both servers. Comparing the sidecar header as `str` also threw `TypeError` on a non-ASCII value. | Fixed. Both sides compare bytes (`timingSafeEqual`, `hmac.compare_digest`). |
| Low | `collection_path` treated only the literal segment `..` as a parent. NFKC lookalikes (`．．`, fullwidth slash) were accepted. On Linux they are ordinary names; they are rejected anyway. | Fixed. |
| Low | An entity type of `__proto__` was looked up on the prototype of the route map. | Fixed. Routes use an own-property check. |

## Still recommended

- The bearer token is a single shared secret. It matches a private single-user deployment. Internet-facing or multi-user deployments should terminate TLS at a proxy and use the MCP OAuth resource-server flow.
- The audit log is append-only JSONL. It is not hash-chained. Someone who can write the audit directory can edit history. Treat the directory like the vault: not writable by other users.
- The symlink check is not a full `openat`/`O_NOFOLLOW` transaction. A process that can race the server and swap a directory for a symlink between the check and the write can still redirect that one write. The default refusal stops the durable case, which is a symlink that is already in the vault.
- `read_only: false` in `config.docker.yml` is intentional for a vault you want the container to edit. Set it back to true when the container should only read.
- `npm audit --omit=dev` is clean. The test and lint tree still reports Vitest 3 advisories (`tinypool`, `@vitest/mocker`) and a `minimatch` issue inside typescript-eslint. They are not in the production image (`npm ci --omit=dev`). Fixing them means a major Vitest upgrade, which was left alone. js-yaml, `source-map-js`, Vite, and ESLint's `brace-expansion` are pinned to patched releases.
- The container already runs as uid 10001, with a read-only root filesystem, `cap_drop: ALL`, and `no-new-privileges`. Keep it that way. The sidecar port is not published; `docker-entrypoint.sh` binds it to `127.0.0.1`.

## Opt-outs

| Variable | Default | Effect when set |
| --- | --- | --- |
| `MEMORY_ALLOW_SYMLINKS=1` | off | Follow symlinks inside the vault. Same as `follow_symlinks: true`. |
| `MEMORY_HTTP_ALLOW_ANY_HOST=1` | off | Do not restrict Origin (or Host, when `allowed_hosts` is set) on a non-loopback bind. |
| `MEMORY_EXPORT_MAX_BYTES` | 2 GiB | Largest export file the importers will read. |
| `MEMORY_EXPORT_ENTRY_MAX_BYTES` | 512 MiB | Largest inflated `conversations.json` or plain JSON/JSONL import. |
| `MEMORY_HTTP_RATE_LIMIT` | `6` | Requests per minute for health-run and reindex. `0` disables. |
| `BDH_ALLOW_ANY_HOST=1` | off | Sidecar accepts any Host header. |
| `BDH_ALLOW_UNSAFE_TORCH=1` | off | Load neural state on torch older than 2.10. |
| `BDH_ALLOW_MODEL_DOWNLOAD=1` | off | Allow the embedding model to be downloaded. |
| `UMM_BIND=0.0.0.0` | `127.0.0.1` | Publish the container port on every host interface. |

Before enabling writes on an existing vault, make a filesystem backup and complete the documented inspection workflow.
