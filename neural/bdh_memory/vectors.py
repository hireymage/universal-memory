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

    def search(self, query: str, limit: int, min_score: float | None = None) -> list[tuple[str, float]]:
        if not self.vectors or limit <= 0:
            return []
        floor = self.min_score if min_score is None else min_score
        if self._matrix is None:
            self._ids = list(self.vectors.keys())
            raw = torch.stack([self.vectors[i] for i in self._ids])
            if raw.shape[0] == 1:
                # Centring a single vector on itself yields zeros, so the only
                # note would never clear a positive floor. Compare it raw.
                self._mean = torch.zeros_like(raw[0])
                self._matrix = torch.nn.functional.normalize(raw, dim=1)
            else:
                # Sentence embeddings sit in a narrow cone, so every note looks alike
                # and generic short notes win. Centre on the corpus mean, then renormalise.
                self._mean = raw.mean(dim=0)
                self._matrix = torch.nn.functional.normalize(raw - self._mean, dim=1)
        q = self.encoder.encode([query_text(query)])[0]
        assert self._mean is not None and self._matrix is not None
        scores = self._matrix @ torch.nn.functional.normalize(q - self._mean, dim=0)
        ranked = sorted(
            (
                (float(scores[index]), index)
                for index in range(int(scores.shape[0]))
                if math.isfinite(float(scores[index])) and float(scores[index]) > floor
            ),
            key=lambda item: (-item[0], self._ids[item[1]]),
        )
        return [(self._ids[index], round(score, 6)) for score, index in ranked[:limit]]

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
