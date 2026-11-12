# Experimentální neuronová paměť (BDH)

Tohle je **nadstavba**. Univerzální paměť dál stojí na Markdownu ve vaultu. Revize, `read_only`, changesety, audit a zákaz mazání se nemění. Neuronová vrstva je druhý odhazovatelný index, vedle toho, který už běží v paměti procesu. Když ji smažete, vault zůstane celý. Když sidecar neběží, zápis projde a nástroj `associate` vrátí prázdný poradní výsledek.

Velký jazykový model pořád mluví a uvažuje. Tahle vrstva jen nabízí naučené asociace. Výsledky **nejsou fakta**. Než něco tvrdíte, přečtěte si Markdown.

## Co to dělá

Při vytvoření nebo úpravě entity (a při `reindex`) se do sidecar pošle titulek, aliasy a tělo. Sidecar text přečte jako posloupnost slov a upraví synaptický stav. Dotaz `associate` vrátí seřazené id entit, které se s dotazem pojí naučenou vazbou, ne výskytem řetězce.

Příklad, který umí demo: poznámka „Ranní rituál“ obsahuje větu „Comandante mele a Lelit vaří.“ Poznámka „Dárek od Evy“ obsahuje „Lelit“, ale slovo Comandante v ní není. Obyčejné hledání podřetězce Comandante dárek nenajde. Po přečtení první poznámky synapse mezi těmi slovy zesílí a `associate` dárek vrátí.

```bash
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install -r neural/requirements.txt
python neural/demo_associate.py
python -m pytest neural/tests
```

## Co je skutečně BDH a co je zjednodušení

Vycházíme z architektury Dragon Hatchling (Pathway, [arXiv:2509.26507](https://arxiv.org/abs/2509.26507), referenční kód [pathwaycom/bdh](https://github.com/pathwaycom/bdh)). Pracovní paměť BDH při inferenci je Hebbovská plasticita: synapse mezi neurony, které pálí společně, sílí. To v sidecar je.

| Kus | Vztah k článku |
|---|---|
| Rychlý stav σ při čtení jedné poznámky | Skutečné pravidlo z části 1.2. `Y(i), X(j) → σ(i,j)` se zvedne o `Y(i)·X(j)`. `Y` je stopa nedávno aktivních neuronů (kontext, ne jen sousední slovo). Po dopsání poznámky se tahle σ zahodí. |
| Vyvolání `A(j) = Σ_i X(i)·σ(i,j)` | Skutečné čtení synapsí. Skóre je kosinus mezi tímto obrazem a kódem slova v poznámce. |
| Kladné řídké aktivace a práh | Kvalitativně inhibiční obvod z článku. Není to oddělená spikující populace. Neurony pod čtvrtinou vrcholu se berou jako tiché. Slovo se uzná, jen když pálí většina jeho neuronů. Jeden společný neuron je srážka hashe, ne pojem. |
| Enkodér slov | **Není** naučená ReLU-lowrank matice `E` z BDH-GPU. Veřejný checkpoint neexistuje a tohle není jazykový model. Každé slovo dostane pevnou řídkou sadu neuronů z hashe (seed je číslo článku). Stejné slovo, stejné neurony, i po restartu. |
| RoPE, více vrstev, trénink dalšího tokenu | Nejsou. Hračka v repozitáři Pathway je jazykový model. My z ní bereme pravidlo pracovní paměti, ne generování textu. |
| Pomalé váhy na disku | **Rozšíření.** Původní BDH σ po konci kontextu zapomíná. Paměť přes poznámky potřebuje opak. Rychlá σ se po každé poznámce znormalizuje, zsymetrizuje a přičte do pomalé σ v souboru pod stavovým adresářem. Symetrie v článku není (pravidlo je směrové). Je tu proto, aby šla asociace oběma směry. |

Pomalá σ má pevnou velikost (výchozí 1024×1024, řádově 4 MB). S délkou vaultu neroste. Roste jen katalog slov uložených u entit, ze kterého se při mazání odečte jejich příspěvek. Celý soubor smí zmizet. `reindex` ho postaví znovu z Markdownu.

Stav leží v `BDH_STATE_DIR` (lokálně `./.state/neural`, v kontejneru `/state/neural`). Do vaultu se nezapisuje.

## Jak to zapnout lokálně

1. Sidecar, CPU, ve výchozím stavu jen loopback:

```bash
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install -r neural/requirements.txt
export BDH_STATE_DIR=./.state/neural
# volitelně, stejné jméno proměnné jako u HTTP serveru
export MEMORY_API_TOKEN='...dlouhý token...'
python -m bdh_memory --bind 127.0.0.1 --port 8091
```

Bez tokenu smí sidecar poslouchat jen na loopbacku. Na jiné adrese bez tokenu nenaběhne. Token bere v pořadí `BDH_TOKEN`, soubor `BDH_TOKEN_FILE` (nebo `MEMORY_API_TOKEN_FILE`), pak `MEMORY_API_TOKEN`.

2. V `config.yml`:

```yaml
neural:
  enabled: true
  base_url: http://127.0.0.1:8091
  bearer_token_env: MEMORY_API_TOKEN
  timeout_ms: 1500
```

Klíč `neural` může v konfiguraci chybět. Pak je vrstva vypnutá a proces se sidecar vůbec nebaví.

3. `reindex` (příkaz, MCP i `POST /api/v1/reindex`) znovu postaví oba indexy. Neuronový se plní po dávkách. Když sidecar neodpoví, lexikální reindex stejně doběhne a na stderr zůstane jedna věta.

Zápis entity (vytvoření, úprava, přesun, adopce, archivace, i zápis grafu, který jde přes index) pošle text do sidecar **až po** úspěšném zápisu Markdownu. Chyba, timeout nebo HTTP 500 se spolkne. Fyzické smazání entity (jen migrační rollback) synapse stáhne.

## Nástroj a REST

MCP `associate`:

```json
{ "query": "Comandante", "limit": 10, "mode": "neural" }
```

`mode` je `neural` (jen naučené vazby) nebo `hybrid` (k nim se přimíchají zásahy obyčejného hledání; lexikální složka je malý bonus, naučená asociace zůstává výš).

Odpověď má vždy `advisory: true` a větu, že nejde o ověřená fakta. Když je vrstva vypnutá: `enabled: false`, prázdné `results`. Když je zapnutá a sidecar mlčí: `degraded: true`. V hybridu se v tom případě vrátí jen lexikální zásahy a poznámka to říká.

REST je stejný kontrakt jako ostatní čtení:

```bash
curl -s 'http://127.0.0.1:3333/api/v1/associate?q=Comandante&mode=hybrid&limit=10' \
  -H "Authorization: Bearer $MEMORY_API_TOKEN"
```

Chybí `q`, `limit` není kladné celé číslo, nebo `mode` není `neural`/`hybrid` → `400 VALIDATION_ERROR`.

Sidecar samo má `GET /health` (bez tokenu, bez textu vaultu), `GET /v1/ids` (id → revize pro vrstvu BDH a, když běží, pro vektorovou vrstvu; bearer jako ostatní `/v1`, žádný text poznámek) a `POST /v1/upsert`, `/v1/remove`, `/v1/associate`, `/v1/rebuild`. POST chce bearer, pokud je token nastavený. Kontrola zdraví tyhle revize jen porovná s Markdownem a při rozdílu doporučí `reindex`. Sama ho nespouští.

## Docker

Služba `neural-memory` je v profilu `neural`. Compose jí **nepublikuje port**. Uvnitř své sítě poslouchá na `0.0.0.0` (jinak by na ni hlavní kontejner nedosáhl) a vyžaduje stejný soubor s tokenem jako hlavní server. Z hostitele ani z LAN na ni není vidět. Pro ladění jde v `docker-compose.yml` odkomentovat `127.0.0.1:8091:8091`.

```bash
# v config.docker.yml: neural.enabled: true
docker compose --profile neural up -d --build
```

Obraz je CPU PyTorch, jen pro čtení, uživatel 10001, stav ve svazku `umm-state` pod `/state/neural`.

## Limity, na rovinu

- Není to naučený jazykový model a nerozumí parafrázím, které spolu v žádné poznámce nestály. Synapse vznikne jen tam, kde slova (jejich neurony) pálila v jednom kontextu.
- Enkodér je hash, ne monosémantické neurony vypěstované tréninkem. Většinový práh srážky tlumí, ale není to interpretovatelnost z článku.
- Dlouhá poznámka se při konsolidaci normalizuje, aby nepřeválcovala krátkou. Pořadí slov v poznámce hraje roli: bližší slova se vážou silněji (rozpad stopy 0.9 na token).
- Katalog a σ se při opakovaných úpravách odečítají ve floatu. Občasný `reindex` je oprava, stejně jako u lexikálního indexu.
- Výchozí strop je 512 tokenů na entitu a v klientovi 80 000 znaků těla. Zbytek se do synapse nedostane.
- Vrstva nic nemaže, nic neslučuje a nic nepřepisuje. Archivovaná entita v indexu zůstává, dokud ji někdo fyzicky nesmaže migračním rollbackem nebo dokud `reindex` nepostaví stav znovu z toho, co ve vaultu je.
- Husté vektory (třetí seznam, `BDH_VECTOR=1`) se řadí kosinem. Výchozí práh je `min_score` 0: vrátí se jen zásahy **ostře nad** prahem, takže záporný kosinus nevyplňuje `limit`. Sidecar bere `BDH_VECTOR_MIN_SCORE`, a když požadavek pošle `min_score` (server ho posílá z `neural.vector_min_score`), platí hodnota z požadavku. Jeden jediný vektor se na průměr necentruje, jinak by sám na sebe vyšel nula a práh by ho schoval.
- Id, které aktuální paměťový index nezná (zastaralý stav sidecar, třeba po smazání vaultu dřív, než proběhne `reindex`), TypeScript adaptér z neuronových i vektorových výsledků vyhodí. `reindex` sidecar srovná s Markdownem.

## Soubory

```text
neural/bdh_memory/model.py     Hebbovské σ, pomalé váhy, asociace
neural/bdh_memory/server.py    HTTP
neural/bdh_memory/store.py     bdh.pt mimo vault
neural/demo_associate.py       ukázka, která má skončit kódem 0
neural/tests/                  pytest
src/adapters/neural/           klient a zrcadlení indexu
src/application/neural-memory-service.ts
```
