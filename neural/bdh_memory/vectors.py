"""Dense-vector index for semantic recall, kept beside the BDH synapses.

Each entity is embedded once per revision with a local multilingual encoder
(default ``intfloat/multilingual-e5-small``, 384 dimensions, CPU). Search is a
cosine similarity over all stored vectors. Nothing leaves the container: the
model weights are baked into the image at build time.

The index is disposable like the BDH state: deleting ``vectors.pt`` only drops
the vector layer, and the next reindex rebuilds it from Markdown.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Iterable, Protocol

import torch

DEFAULT_MODEL = "intfloat/multilingual-e5-small"
MAX_PASSAGE_CHARS = 2000
EMBED_BATCH = 32


class Encoder(Protocol):
    dim: int

    def encode(self, texts: list[str]) -> torch.Tensor:
        """Return an L2-normalised float32 tensor of shape [len(texts), dim]."""


class SentenceEncoder:
    """Wraps sentence-transformers. Imported lazily so tests run without it."""

    def __init__(self, model_name: str, cache_dir: str | None = None) -> None:
        from sentence_transformers import SentenceTransformer  # noqa: PLC0415

        self.model = SentenceTransformer(model_name, cache_folder=cache_dir, device="cpu")
        self.dim = int(self.model.get_sentence_embedding_dimension())

    def encode(self, texts: list[str]) -> torch.Tensor:
        vectors = self.model.encode(texts, normalize_embeddings=True, batch_size=EMBED_BATCH, convert_to_numpy=True)
        return torch.as_tensor(vectors, dtype=torch.float32)


def passage_text(title: str, aliases: list[str], content: str) -> str:
    # e5 models expect a "passage: " prefix on documents and "query: " on queries.
    head = " ".join(part for part in [title, *aliases] if part)
    body = content.strip()[:MAX_PASSAGE_CHARS]
    return f"passage: {head}\n{body}".strip()


def query_text(query: str) -> str:
    return f"query: {query.strip()}"


class VectorIndex:
    def __init__(self, encoder: Encoder, directory: Path) -> None:
        self.encoder = encoder
        self.directory = directory
        self.file = directory / "vectors.pt"
        self.revisions: dict[str, str] = {}
        self.vectors: dict[str, torch.Tensor] = {}
        self._matrix: torch.Tensor | None = None
        self._ids: list[str] = []

    def __len__(self) -> int:
        return len(self.vectors)

    def upsert(self, entity_id: str, title: str, aliases: list[str], content: str, revision: str) -> bool:
        """Embed one entity. Returns False when the stored revision already matches."""
        if revision and self.revisions.get(entity_id) == revision and entity_id in self.vectors:
            return False
        self.vectors[entity_id] = self.encoder.encode([passage_text(title, aliases, content)])[0]
        self.revisions[entity_id] = revision
        self._matrix = None
        return True

    def remove(self, entity_id: str) -> bool:
        self.revisions.pop(entity_id, None)
        removed = self.vectors.pop(entity_id, None) is not None
        self._matrix = None
        return removed

    def clear(self) -> None:
        self.vectors.clear()
        self.revisions.clear()
        self._matrix = None

    def upsert_many(self, documents: Iterable[dict[str, Any]]) -> int:
        batch = [d for d in documents]
        if not batch:
            return 0
        texts = [passage_text(d["title"], d["aliases"], d["content"]) for d in batch]
        embedded = self.encoder.encode(texts)
        for index, document in enumerate(batch):
            entity_id = document["id"]
            self.vectors[entity_id] = embedded[index]
            self.revisions[entity_id] = document.get("revision", "")
        self._matrix = None
        return len(batch)

    def search(self, query: str, limit: int) -> list[tuple[str, float]]:
        if not self.vectors:
            return []
        if self._matrix is None:
            self._ids = list(self.vectors.keys())
            self._matrix = torch.stack([self.vectors[i] for i in self._ids])
        q = self.encoder.encode([query_text(query)])[0]
        scores = self._matrix @ q
        k = min(limit, scores.shape[0])
        top = torch.topk(scores, k)
        return [(self._ids[int(i)], round(float(s), 6)) for s, i in zip(top.values, top.indices)]

    def save(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        temporary = self.file.with_suffix(".pt.tmp")
        torch.save({"revisions": self.revisions, "vectors": self.vectors}, temporary)
        os.replace(temporary, self.file)

    def load(self) -> None:
        if not self.file.is_file():
            return
        payload = torch.load(self.file, map_location="cpu", weights_only=True)
        self.revisions = dict(payload.get("revisions", {}))
        self.vectors = dict(payload.get("vectors", {}))
        self._matrix = None
