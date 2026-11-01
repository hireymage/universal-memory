# Instalace – Universal Memory v Dockeru

Předpoklady: Docker Desktop (macOS) spuštěný, `openssl` v terminálu.

## 1. Vytvoř token a `.env`

```bash
cd ~/MCP/universal-memory
cp .env.example .env
openssl rand -hex 32
```

Vlož vygenerovaný řetězec do `.env` za `MEMORY_TOKEN=`. Token si ulož do správce hesel, do chatu ho nikam nepiš.

## 2. Spusť kontejner

```bash
docker compose up -d --build
```

## 3. Ověř běh

```bash
docker compose ps
docker compose logs --tail=50 universal-memory
curl -i http://127.0.0.1:8080/mcp        # bez tokenu musí vrátit 401
```

Požadavek s tokenem (nahraď `TVUJ_TOKEN`) by neměl vrátit 401:

```bash
curl -i -H "Authorization: Bearer TVUJ_TOKEN" http://127.0.0.1:8080/mcp
```

## 4. Připoj klienta

Viz [AGENT_SETUP.md](AGENT_SETUP.md) – tam je, kam přesně vložit URL a token.

## Aktualizace a zastavení

```bash
docker compose down            # zastaví, data zůstanou v ./data
docker compose up -d --build   # znovu sestaví a spustí
```

## Odinstalace

```bash
docker compose down -v
rm -rf data .env
```

Pozor: `rm -rf data` smaže všechny uložené paměti. Před tím udělej zálohu `data/vault/`.

## Poznámka k ověření

Tato složka byla připravena bez spuštěného Docker daemonu, takže image ještě nebyla sestavena. Před prvním použitím spusť kroky 2 a 3.
