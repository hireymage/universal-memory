# Universal Memory (MCP, Docker)

Prázdný, samostatně hostovaný paměťový MCP server. Ukládá poznámky pod klíči
jako Markdown poznámky ve složce `data/vault/` se stejným YAML frontmatterem jako tvůj Obsidian trezor (`id` ULID, `type`, `title`, `created_at`, `updated_at`, `aliases`, `tags`, `status`, `schema_version`). SQLite je jen index, který se přegeneruje z `.md`. Nic v této složce neobsahuje tvá data, tokeny ani paměť;
databáze vzniká až při prvním použití v `data/` (ignorováno gitem i Dockerem).

## Co obsahuje

| Soubor | Popis |
|---|---|
| `server.py` | MCP server (FastMCP) s nástroji `remember`, `recall`, `get_memory`, `forget`, `list_keys`. Režim `stdio` pro lokální klienty, režim `http` s Bearer tokenem pro Docker. |
| `Dockerfile` | Image na `python:3.12-slim`, běží jako neprivilegovaný uživatel, data v `/data`. |
| `docker-compose.yml` | Spuštění jedním příkazem, port jen na `127.0.0.1:8080`, volume `./data`. |
| `requirements.txt` | Připnuté verze `mcp` a `uvicorn`. |
| `.env.example` | Šablona pro `.env` s proměnnou `MEMORY_TOKEN`. Kopíruj jako `.env`. |
| `claude_desktop_config.example.json` | Příklad konfigurace pro lokální režim `stdio`. |
| `INSTALL.md` | Krok za krokem instalace v Dockeru. |
| `AGENT_SETUP.md` | Kde co nastavit, aby agent server našel a používal. |

## Nástroje serveru

- `remember(key, content, tags="")` – uloží nebo přepíše paměť.
- `recall(query, limit=10)` – hledá v klíči, obsahu i štítcích.
- `get_memory(key)` – vrátí jednu paměť podle přesného klíče.
- `forget(key)` – smaže paměť.
- `list_keys(limit=100)` – vypíše klíče, nejnovější první.

## Bezpečnostní poznámky

- Token nikdy nepatří do image ani do gitu; předává se přes `.env`.
- HTTP režim bez `MEMORY_TOKEN` se nespustí.
- Port je navázán jen na localhost. Pro vzdálený přístup použij reverzní proxy s TLS.
- Záloha = kopie složky `data/vault/` (jsou tam všechny poznámky; `index.db` jde přegenerovat).
