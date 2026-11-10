# Universal Memory MCP v Dockeru

Universal Memory MCP zabalený do kontejneru.
`config.docker.yml` obsahuje plný routing typů do složek (People, Companies, 02 Projects, 05 Systems, 06 Access, 11 Tasks …); uprav ho podle struktury svého vaultu. `config.example.yml` je minimální konfigurace pro běh bez Dockeru.

## Soubory
- `Dockerfile` – vícefázový build (Node 24): `deps` → `build` → `test` (vitest) → `runtime` (bez dev závislostí, uživatel 10001, healthcheck `/healthz`).
- `docker-entrypoint.sh` – načte token ze souboru `MEMORY_API_TOKEN_FILE` (Docker secret), takže není vidět v `docker inspect`.
- `config.docker.yml` – vault `/vault`, audit/changesety `/state/audit`, HTTP `0.0.0.0:27123`.
- `docker-compose.yml` + `.env.example` – vault jako bind mount, stav v pojmenovaném svazku, read-only kontejner, `cap_drop: ALL`.
- `config.strata.yml` – varianta s interním portem 8080 (např. náhrada staršího serveru na stejném portu); připojuje se jako `/config/config.yml:ro`, v compose pak `ports: "8796:8080"` a `environment: UMM_HEALTH_PORT=8080` (jinak healthcheck testuje 27123 a kontejner hlásí `unhealthy`).

## Spuštění
1. `cp .env.example .env`, nastavit `UMM_VAULT_PATH` (složka s Markdown vaultem; může být prázdná).
2. Token (1 řádek, ≥ 32 znaků): `mkdir -p secrets && openssl rand -hex 32 > secrets/memory_api_token`
   (nebo nastavit `UMM_TOKEN_FILE` na existující soubor s tokenem).
3. `docker compose up -d --build`
4. Kontrola: `curl http://127.0.0.1:27123/healthz`, MCP endpoint `http://<host>:27123/mcp` s `Authorization: Bearer <token>`.

Vault na hostiteli musí být zapisovatelný pro UID 10001 (Linux: `sudo chown -R 10001:10001 <vault>`; Docker Desktop na Windows/macOS to řeší sám).

Testy: `docker build --target test .`

## Experimentální neuronová paměť (volitelně)

Sidecar s Hebbovskou asociativní pamětí se nespouští sám. Je ve profilu `neural`, nepublikuje port na hostitele a čte stejný bearer token jako hlavní server. Stav si píše do `/state/neural` (mimo vault). Zapnutí:

1. V `config.docker.yml` nastav `neural.enabled: true` (adresa `http://neural-memory:8091` už tam je).
2. `docker compose --profile neural up -d --build`

Když profil neběží a vrstva je přesto zapnutá, zápis do Markdownu projde a `associate` vrátí prázdný poradní výsledek. Podrobněji [docs/neural-memory.md](./docs/neural-memory.md).

## Windows: build přes SSH
Docker Desktop ve SSH relaci nemá přístup ke správci pověření Windows (`A specified logon session does not exist`).
Build proto běží s anonymní konfigurací a klasickým builderem (base image `node:24-bookworm-slim` už je stažený):

```
set DOCKER_CONFIG=C:\temp\docker-anon
set DOCKER_BUILDKIT=0
docker build --target runtime -t universal-memory-mcp:local .
```

`C:\temp\docker-anon\config.json` obsahuje jen `currentContext` a `cliPluginsExtraDirs` (bez `credsStore`).
Na lokální konzoli Windows funguje normální `docker compose up -d --build`.
