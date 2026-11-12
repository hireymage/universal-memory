# Typy, routy a kontrola zdraví

Markdown ve vaultu je pořád jediný zdroj pravdy. Tahle stránka popisuje registr typů, kam se soubory ukládají, a periodickou kontrolu, která **nic neopravuje sama**.

## Registr typů

Známé typy jsou v `src/domain/entity-types.ts`. U každého je:

- výchozí cesta (`defaultRoute`),
- aliasy (bez ohledu na háčky a velikost písmen: `úkol` = `ukol` = `todo` → `task`),
- `required` — chybějící klíč je v kontrole zdraví chyba,
- `expected` — chybějící klíč je varování (soubor je platný, typ je neúplný),
- datová pole (`birth_date`, `name_day`, `decided_at`, `starts_at`, …).

`routing` v `config.yml` výchozí cestu přebíjí. Když typ v konfiguraci není, server ho pořád zapíše, ale spadne na routu `memory`. Klasifikace při vytváření v tom případě navrhne nejbližší známý typ (přesný alias, jinak podobnost) a **koncept nijak nezmění**.

Nové routy ve `config.example.yml`, `config.docker.yml` i ve výchozím registru:

| Typ | Význam | Kam (docker / plný vault) |
|---|---|---|
| `event` | událost s časem | `14 Events/{date}-{slug}.md` |
| `preference` | mám rád / nemám rád / preferuji | `15 Preferences/{slug}.md` |
| `fact` | trvalý fakt | `16 Facts/{slug}.md` |
| `topic` | téma | `04 Knowledge/Topics/{slug}.md` |
| `conversation` | rozhovor jako entita (není to `identity_type` zdroje) | `17 Conversations/{date}-{slug}.md` |

`config.example.yml` má u poznámek složku `03 Knowledge`, proto `topic` v příkladu leží pod ní. Stejný typ, jiná vaultová mapa.

`distill_next_chunk` v postupu pro zápis jmenuje jen routované typy: `fact`, `decision`, `topic`, `task`, `idea`, `preference`, `event`. Nevymýšlí typ, který nemá cestu.

## Vyhledání, zápis, schránka

`find` bere jeden dotaz. Filtry v textu jsou bez ohledu na háčky a velikost písmen: `typ:úkol` i `type:task`, `#znacka`, `osoba:`/`person:`, `projekt:`/`project:`, `do:týden`/`due:week`, `od:`/`since:`. `osoba:` a `projekt:` berou celé slovo v titulku, aliasech, wikilinku nebo příslušném poli, ne zmínku v textu. Archivované položky se nevrací. Neznámý typ (`typ:úkoly`) vrátí varování a žádný zásah. Výchozí zásah je krátký (id, titulek, typ, cesta, věta, skóre, důvod). `detail: true` přidá metadata.

Při zápisu server vrací `warnings`. Chybějící `required` a špatné datum mají závažnost `error` jako kontrola zdraví, zápis ale neblokují. Synonyma klíčů (`deadline` → `due`, `narozeniny` → `birth_date`, `svatek` → `name_day`) se přejmenují a změna je v odpovědi i v auditu. Když se hodnota neshoduje, zůstanou oba klíče.

Nízká jistota klasifikace (pod `classification.inbox_confidence_threshold`, výchozí 0.5, tedy jen `low`) uloží položku jako `inbox` s `suggested_type` a `classification_confidence`. `triage_inbox` je vypíše a připraví changeset; zapíše ho až `apply_changeset`.

Pořadí výsledků skládá shodu, stáří `updated`, počet odkazů a volitelně počet čtení (`ranking.track_usage`, soubor `usage.json` v audit adresáři, ne ve vaultu). Úkoly a události jdou s `order: due` od nejbližšího termínu, po termínu mají `overdue`.

## Klasifikace při vytvoření

Pořád jen rada. Pravidla běží na titulku bez diakritiky a s hranicí písmene `(?<!\p{L})…(?!\p{L})`. Dřív `\b` v JavaScriptu vidělo jen ASCII, takže `Rozhodnutí` ani jiné slovo končící háčkem nebo čárkou nespárovalo.

Pořadí (vyhraje první zásah): událost (datum a čas), preference, úkol (`TODO`, `koupit`, `udělat`, `do pátku`, `- [ ]`), nápad, rozhodnutí, osoba (příbuzenství nebo `narozeniny`), poznámka. Podrobnosti anglicky v [classification.md](./classification.md).

## Když se změní `type`

`update_memory` s platnou `expected_revision`, které ve frontmatter změní `type`, soubor přejmenuje na cestu nového typu. To je záměrný zápis, ne tichý přesun. Audit k události `update` přidá `rerouted`, `from_type`, `to_type`, `from_path`, `to_path`. Kontrola zdraví takový přesun **nedělá**. Jen připraví changeset.

## Kontrola zdraví

Jeden průchod přes `storage.inspectFiles()`. Žádné párové porovnávání každé poznámky s každou.

| Kód | Co to je |
|---|---|
| `MALFORMED_MARKDOWN` | soubor neprojde parsováním |
| `DUPLICATE_ID` | stejné stabilní id ve dvou souborech |
| `MISSING_FRONTMATTER` | chybí `required` (chyba) nebo `expected` (varování) |
| `INVALID_DATE` | `birth_date`, `name_day` a další registrovaná data nejsou ISO |
| `TYPE_FOLDER_MISMATCH` | složka nesedí na routu typu |
| `UNKNOWN_TYPE` / `UNROUTED_TYPE` | typ není v registru, nebo je, ale nemá routu |
| `TAG_NORMALIZATION` | velikost písmen nebo duplicitní tagy |
| `BROKEN_LINK` | wikilink nikam nevede |
| `DUPLICATE_TITLE` | stejný titul po `compactForm` (`Novák` = `Novak`) |
| `ORPHAN` | žádný odkaz, zpětný odkaz ani relace (archivované se nehlásí) |
| `ALIAS_COLLISION` | jeden alias patří víc entitám |
| `INDEX_DRIFT` | revize v paměťovém indexu nesedí na Markdown |
| `SIDECAR_DRIFT` | revize v BDH nebo ve vektorové vrstvě nesedí (`GET /v1/ids`) |
| `SIDECAR_UNAVAILABLE` | sidecar nejde přečíst; reindex se nespouští |

Výstup:

- `${audit_dir}/health/latest.json` a datovaný soubor historie (mimo vault, funguje i při `read_only: true`),
- jeden auditní záznam `operation: "health_check"` s počty,
- nanejvýš `health.max_changesets` changesetů (výchozí 5, zhruba 50 operací každý).

Opravitelné věci v changesetu, pořád jen návrh:

- přesun nebo změna typu, když složka nesedí na typ,
- sjednocení tagů,
- oprava relačního odkazu (`- [[název]] <!-- rel:ID -->` → odkaz na basename).

Rozdíl indexu nebo sidecar přidá doporučení `reindex`. Kontrola ho nespustí a changeset neaplikuje. Mazání v návrhu není.

### Kdy to běží

Ve výchozím stavu je `health.enabled: false`.

```yaml
health:
  enabled: false
  interval_hours: 24
  startup_delay_s: 60
  max_changesets: 5
```

`MEMORY_HEALTH_INTERVAL_HOURS` přepíše interval. Časovač je `setInterval().unref()` s malým rozptylem a zámkem, aby dva běhy neběžely přes sebe. Startuje jen dlouhý HTTP `serve`. Stdio a jednorázové příkazy ho nespouští.

Spuštění rukou:

- `POST /api/v1/health/run` a `GET /api/v1/health/latest` (stejné bearer přihlášení jako ostatní `/api/v1`),
- CLI `health`,
- MCP `health_report` v profilech `minimal`, `standard` i `full`. Ve výchozím tvaru je odpověď krátká: `last_run_at`, počty podle závažnosti a kódu, pět nálezů, id changesetů. `detail: true` stránkuje zbytek.
- MCP `run_health_check` jen ve `full`. Smí zapsat report a changesety do `audit_dir` i když je server `read_only`, stejně jako `prepare`. Vault nesahe.
