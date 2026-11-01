"""Universal memory MCP server, compatible with the Obsidian vault layout.

Source of truth: Markdown files in MEMORY_VAULT_PATH (one note per file).
Frontmatter fields match the vault: id (ULID), type, title, created_at,
updated_at, aliases, tags, status, schema_version. Body follows after the
closing `---`, unchanged.
Index: SQLite cache in MEMORY_INDEX_PATH, rebuilt from the vault on start.
Transport: stdio (local) or streamable HTTP with a Bearer token (Docker).
"""
import hmac
import os
import re
import secrets
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

from mcp.server.fastmcp import FastMCP

VAULT = Path(os.environ.get("MEMORY_VAULT_PATH", "/data/vault"))
INDEX_PATH = os.environ.get("MEMORY_INDEX_PATH", "/data/index.db")
DEFAULT_FOLDER = os.environ.get("MEMORY_DEFAULT_FOLDER", "00 Inbox")
TRANSPORT = os.environ.get("MCP_TRANSPORT", "stdio")
HOST = os.environ.get("MCP_HOST", "0.0.0.0")
PORT = int(os.environ.get("MCP_PORT", "8080"))
TOKEN = os.environ.get("MEMORY_TOKEN", "")

mcp = FastMCP("universal-memory")

CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
FRONT = re.compile(r"^---\n(.*?)\n---\n?(.*)$", re.DOTALL)


def _ulid() -> str:
    """26-char ULID, same format as the vault ids (e.g. 01KZRCCAZ3PRW730FAWG11CJ6F)."""
    value = (int(time.time() * 1000) << 80) | secrets.randbits(80)
    out = []
    for _ in range(26):
        out.append(CROCKFORD[value & 31])
        value >>= 5
    return "".join(reversed(out))


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"


def _safe_name(title: str) -> str:
    name = re.sub(r'[\\/:*?"<>|]', "-", title).strip()
    if not name:
        raise ValueError("title must contain at least one character")
    return name


def _parse_tags(raw: str, lines: list[str]) -> list[str]:
    if raw.strip() in ("", "[]"):
        if raw.strip() == "":
            return [l.strip()[2:].strip() for l in lines if l.strip().startswith("- ")]
        return []
    return [t.strip() for t in raw.strip("[]").split(",") if t.strip()]


def _parse(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    m = FRONT.match(text)
    meta, body, tag_lines = {}, text, []
    if m:
        fm_lines = m.group(1).splitlines()
        body = m.group(2)
        i = 0
        while i < len(fm_lines):
            line = fm_lines[i]
            if ":" in line and not line.startswith(" "):
                k, v = line.split(":", 1)
                meta[k.strip()] = v.strip()
                if k.strip() == "tags" and v.strip() == "":
                    j = i + 1
                    while j < len(fm_lines) and fm_lines[j].startswith("  -"):
                        tag_lines.append(fm_lines[j])
                        j += 1
            i += 1
    return {
        "id": meta.get("id", ""),
        "type": meta.get("type", "note"),
        "title": meta.get("title", path.stem),
        "tags": _parse_tags(meta.get("tags", ""), tag_lines),
        "status": meta.get("status", "active"),
        "created_at": meta.get("created_at", ""),
        "updated_at": meta.get("updated_at", ""),
        "body": body,
        "path": path,
    }


def _render(entry: dict) -> str:
    tags = "tags: []\n" if not entry["tags"] else "tags:\n" + "".join(f"  - {t}\n" for t in entry["tags"])
    return (
        "---\n"
        f"id: {entry['id']}\n"
        f"type: {entry['type']}\n"
        f"title: {entry['title']}\n"
        f"created_at: {entry['created_at']}\n"
        f"updated_at: {entry['updated_at']}\n"
        "aliases: []\n"
        f"{tags}"
        f"status: {entry['status']}\n"
        "schema_version: 1\n"
        "---\n\n"
        f"{entry['body']}"
        + ("" if entry["body"].endswith("\n") else "\n")
    )


def _all_notes():
    for path in VAULT.rglob("*.md"):
        if ".obsidian" in path.parts:
            continue
        yield path


def _find(title: str) -> Path | None:
    for path in _all_notes():
        if path.stem == _safe_name(title):
            return path
    return None


def _db():
    os.makedirs(os.path.dirname(INDEX_PATH) or ".", exist_ok=True)
    conn = sqlite3.connect(INDEX_PATH)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, title TEXT, type TEXT, "
        "tags TEXT, status TEXT, updated_at TEXT, path TEXT, body TEXT)"
    )
    return conn


def _index_row(e: dict) -> tuple:
    return (e["id"], e["title"], e["type"], ", ".join(e["tags"]), e["status"],
            e["updated_at"], str(e["path"]), e["body"])


def _rebuild_index() -> None:
    conn = sqlite3.connect(INDEX_PATH)
    conn.execute("DROP TABLE IF EXISTS memories")
    conn.close()
    conn = _db()
    for path in _all_notes():
        conn.execute("INSERT OR REPLACE INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?)", _index_row(_parse(path)))
    conn.commit()
    conn.close()


@mcp.tool()
def remember(title: str, content: str, tags: str = "", folder: str = "") -> str:
    """Create or overwrite a note `<folder>/<title>.md` in the vault. tags: comma-separated."""
    name = _safe_name(title)
    existing = _find(title)
    now = _now()
    folder = folder or DEFAULT_FOLDER
    path = existing or (VAULT / folder / f"{name}.md")
    entry = {
        "id": _parse(existing)["id"] if existing else _ulid(),
        "type": "note",
        "title": name,
        "tags": [t.strip() for t in tags.split(",") if t.strip()],
        "status": "active",
        "created_at": _parse(existing)["created_at"] if existing else now,
        "updated_at": now,
        "body": content,
        "path": path,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_render(entry), encoding="utf-8")
    conn = _db()
    conn.execute("INSERT OR REPLACE INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?)", _index_row(entry))
    conn.commit()
    conn.close()
    return f"stored: {path.relative_to(VAULT)}"


@mcp.tool()
def recall(query: str, limit: int = 10) -> list[dict]:
    """Search notes whose title, tags or body contain the query (case-insensitive)."""
    like = f"%{query}%"
    conn = _db()
    rows = conn.execute(
        "SELECT id, title, tags, updated_at, path, body FROM memories "
        "WHERE title LIKE ? OR tags LIKE ? OR body LIKE ? ORDER BY updated_at DESC LIMIT ?",
        (like, like, like, limit),
    ).fetchall()
    conn.close()
    return [{"id": i, "title": t, "tags": tg, "updated_at": u, "path": p, "body": b}
            for i, t, tg, u, p, b in rows]


@mcp.tool()
def get_memory(title: str) -> dict | str:
    """Return one note by its title (file name without .md)."""
    path = _find(title)
    if path is None:
        return f"not found: {title}"
    e = _parse(path)
    return {k: e[k] for k in ("id", "title", "type", "tags", "status", "created_at", "updated_at", "body")}


@mcp.tool()
def forget(title: str) -> str:
    """Delete one note file from the vault and its index row."""
    path = _find(title)
    if path is None:
        return f"not found: {title}"
    e = _parse(path)
    path.unlink()
    conn = _db()
    conn.execute("DELETE FROM memories WHERE id = ?", (e["id"],))
    conn.commit()
    conn.close()
    return f"deleted: {path.relative_to(VAULT)}"


@mcp.tool()
def list_keys(limit: int = 100) -> list[str]:
    """List note titles, most recently updated first."""
    conn = _db()
    rows = conn.execute("SELECT title FROM memories ORDER BY updated_at DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    return [r[0] for r in rows]


def _with_bearer_auth(app):
    """Reject HTTP requests whose Authorization header does not match MEMORY_TOKEN."""

    async def wrapper(scope, receive, send):
        if scope["type"] == "http":
            headers = dict(scope.get("headers", []))
            auth = headers.get(b"authorization", b"").decode()
            if not hmac.compare_digest(auth, f"Bearer {TOKEN}"):
                await send({"type": "http.response.start", "status": 401,
                            "headers": [(b"content-type", b"text/plain")]})
                await send({"type": "http.response.body", "body": b"unauthorized"})
                return
        await app(scope, receive, send)

    return wrapper


if __name__ == "__main__":
    VAULT.mkdir(parents=True, exist_ok=True)
    _rebuild_index()
    if TRANSPORT == "http":
        if not TOKEN:
            raise SystemExit("MEMORY_TOKEN must be set for http transport")
        import uvicorn

        uvicorn.run(_with_bearer_auth(mcp.streamable_http_app()), host=HOST, port=PORT)
    else:
        mcp.run()
