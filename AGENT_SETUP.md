# Kde co nastavit, aby agent paměť používal

Tři místa, tři hodnoty.

| Co | Kde | Hodnota |
|---|---|---|
| Token | `.env` v `/Users/hozzy/MCP/universal-memory` | `MEMORY_TOKEN=...` |
| Adresa serveru | konfigurace klienta (níže) | `http://127.0.0.1:8080/mcp` (lokálně) |
| Token pro klienta | hlavička `Authorization` v konfiguraci klienta | `Bearer <stejný token>` |

## Varianta A – HTTP (Docker)

Claude Code (`~/.claude.json` nebo `.mcp.json` v projektu):

```json
{
  "mcpServers": {
    "universal-memory": {
      "type": "http",
      "url": "http://127.0.0.1:8080/mcp",
      "headers": { "Authorization": "Bearer REPLACE_WITH_YOUR_TOKEN" }
    }
  }
}
```

Token sem vlož ručně nebo ho nech načíst z proměnné prostředí, pokud tvůj klient umí `${VAR}` expanzi. Soubor s tokenem nikdy necommituj.

## Varianta B – stdio (bez Dockeru)

Použij `claude_desktop_config.example.json`: nahraď cesty absolutními a zkopíruj do `claude_desktop_config.json` v Application Support/Claude. Nevyžaduje token ani Docker.

## Ověření v agentovi

Zavolej `list_keys`. Prázdný seznam = server běží a je prázdný, což je očekávaný stav.

## Co agent smí ukládat

Nástroj `remember` ukládá text. Agent by neměl ukládat hesla, tokeny ani citlivé údaje; tohle je pravidlo, které je dobré napsat do instrukcí agenta.
