"""Dense-vector index for semantic recall, kept beside the BDH synapses.

Each entity is embedded once per revision with a local multilingual encoder
(default ``intfloat/multilingual-e5-small``, 384 dimensions, CPU). Search is a
cosine similarity over all stored vectors. Nothing leaves the container: the
model weights are baked into the image at build time.

The index is disposable like the BDH state: deleting ``vectors.pt`` only drops
the vector layer, and the next reindex rebuilds it from Markdown.
"""

from __future__ import annotations

import math
import os
import threading
from pathlib import Path
from typing import Any, Iterable, Protocol

import torch

DEFAULT_MODEL = "intfloat/multilingual-e5-base"
MAX_PASSAGE_CHARS = 2000
EMBED_BATCH = 32


class Encoder(Protocol):
    dim: int

    def encode(self, texts: list[str]) -> torch.Tensor:
        """Return an L2-normalised float32 tensor of shape [len(texts), dim]."""


class SentenceEncoder:
    """Wraps sentence-transformers. Imported lazily so tests run without it."""

    def __init__(self, model_name: str, cache_dir: str | None = None, pooling: str | None = None) -> None:
        from sentence_transformers import SentenceTransformer, models  # noqa: PLC0415

        if pooling == "cls":
            # Some checkpoints (e.g. Seznam SimCSE) have no sentence-transformers config and
            # are trained on the [CLS] token. The default mean pooling would silently mis-embed.
            word = models.Transformer(model_name, cache_dir=cache_dir)
            pool = models.Pooling(word.get_word_embedding_dimension(), pooling_mode="cls")
            self.model = SentenceTransformer(modules=[word, pool], device="cpu")
        else:
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
    def __init__(self, encoder: Encoder, directory: Path, min_score: float = 0.0) -> None:
        self.encoder = encoder
        self.directory = directory
        self.file = directory / "vectors.pt"
        # Hits must be strictly above this cosine. The default drops negatives
        # (and exact zeros) instead of using them to fill `limit`.
        self.min_score = min_score
        self.revisions: dict[str, str] = {}
        self.vectors: dict[str, torch.Tensor] = {}
        self._matrix: torch.Tensor | None = None
        self._mean: torch.Tensor | None = None
        self._ids: list[str] = []
        # The HTTP server is threaded. Search keeps a local snapshot so an
        # upsert cannot clear `_matrix` or swap `_ids` under an in-flight query.
        self._lock = threading.Lock()

    def __len__(self) -> int:
        with self._lock:
            return len(self.vectors)

    def upsert(self, entity_id: str, title: str, aliases: list[str], content: str, revision: str) -> bool:
        """Embed one entity. Returns False when the stored revision already matches."""
        with self._lock:
            if revision and self.revisions.get(entity_id) == revision and entity_id in self.vectors:
                return False
        vector = self.encoder.encode([passage_text(title, aliases, content)])[0]
        with self._lock:
            self.vectors[entity_id] = vector
            self.revisions[entity_id] = revision
            self._invalidate()
            return True

    def remove(self, entity_id: str) -> bool:
        with self._lock:
            self.revisions.pop(entity_id, None)
            removed = self.vectors.pop(entity_id, None) is not None
            self._invalidate()
            return removed

    def clear(self) -> None:
        with self._lock:
            self.vectors.clear()
            self.revisions.clear()
            self._invalidate()

    def upsert_many(self, documents: Iterable[dict[str, Any]]) -> int:
        batch = [d for d in documents]
        if not batch:
            return 0
        texts = [passage_text(d["title"], d["aliases"], d["content"]) for d in batch]
        embedded = self.encoder.encode(texts)
        with self._lock:
            for index, document in enumerate(batch):
                entity_id = document["id"]
                self.vectors[entity_id] = embedded[index]
                self.revisions[entity_id] = document.get("revision", "")
            self._invalidate()
            return len(batch)

    def search(self, query: str, limit: int, min_score: float | None = None) -> list[tuple[str, float]]:
        with self._lock:
            if limit <= 0:
                return []
            floor = self.min_score if min_score is None else min_score
            snapshot = self._snapshot()
        if snapshot is None:
            return []
        ids, mean, matrix = snapshot
        q = self.encoder.encode([query_text(query)])[0]
        scores = matrix @ torch.nn.functional.normalize(q - mean, dim=0)
        values = scores.detach().tolist()
        ranked = [
            (score, index)
            for index, score in enumerate(values)
            if isinstance(score, float) and math.isfinite(score) and score > floor
        ]
        ranked.sort(key=lambda item: (-item[0], ids[item[1]]))
        return [(ids[index], round(score, 6)) for score, index in ranked[:limit]]

    def save(self) -> None:
        with self._lock:
            payload = {"revisions": dict(self.revisions), "vectors": dict(self.vectors)}
        self.directory.mkdir(parents=True, exist_ok=True)
        temporary = self.file.with_suffix(".pt.tmp")
        torch.save(payload, temporary)
        os.replace(temporary, self.file)

    def load(self) -> None:
        if not self.file.is_file():
            return
        payload = torch.load(self.file, map_location="cpu", weights_only=True)
        with self._lock:
            self.revisions = dict(payload.get("revisions", {}))
            self.vectors = dict(payload.get("vectors", {}))
            self._invalidate()

    def _invalidate(self) -> None:
        """Caller holds `_lock`."""
        self._matrix = None
        self._mean = None
        self._ids = []

    def _snapshot(self) -> tuple[list[str], torch.Tensor, torch.Tensor] | None:
        """Caller holds `_lock`. The returned tensors stay valid after later invalidation."""
        if not self.vectors:
            return None
        if self._matrix is None or self._mean is None:
            ids = list(self.vectors.keys())
            raw = torch.stack([self.vectors[i] for i in ids])
            if raw.shape[0] == 1:
                # Centring a single vector on itself yields zeros, so the only
                # note would never clear a positive floor. Compare it raw.
                mean = torch.zeros_like(raw[0])
                matrix = torch.nn.functional.normalize(raw, dim=1)
            else:
                # Sentence embeddings sit in a narrow cone, so every note looks alike
                # and generic short notes win. Centre on the corpus mean, then renormalise.
                mean = raw.mean(dim=0)
                matrix = torch.nn.functional.normalize(raw - mean, dim=1)
            self._ids = ids
            self._mean = mean
            self._matrix = matrix
        return list(self._ids), self._mean, self._matrix
