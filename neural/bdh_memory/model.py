"""Small CPU associative memory built on Dragon Hatchling (BDH) synaptic rules.

What is genuinely BDH (Kosowski et al., arXiv:2509.26507, sections 1.2 and 6):

* Neuron activity is non-negative. Co-active neurons strengthen the synapse
  between them — Hebb's rule as used for BDH working memory:
  ``Y(i), X(j) -> sigma(i, j)`` increases by ``Y(i) * X(j)``.
* ``Y`` is an eligibility trace of neurons that fired earlier in the same
  context (the paper's fast weights, potentiation over the span of a context,
  not a single adjacent token).
* Recall propagates the query through those synapses:
  ``A(j) = sum_i X(i) * sigma(i, j)``. A stored word matches when a majority
  of its neurons fire in ``A`` (or in the query itself). One shared neuron is
  treated as a hash collision and ignored.
* Sigma lives at synapses, not in a growing token cache. Its size is fixed
  by the neuron count.

What is a deliberate simplification:

* Original BDH learns the encoder ``E`` (ReLU-lowrank projection into a large
  sparse neuron space) by next-token training. Pathway does not publish those
  weights, and this sidecar is a memory index, not a language model. Each
  distinct word is therefore placed on its own small set of excitatory neurons
  by a deterministic hash. Same word, same neurons, across notes and restarts.
  That stands in for the monosemantic sparse codes training would have grown.
* There is no inhibitory spiking population, no RoPE, no multi-layer stack,
  and no learned decoder. A subtractive threshold that keeps neurons near the
  peak of the readout is a stand-in for the inhibitory circuit.
* Original BDH forgets sigma when the context ends. Cross-document memory
  needs the opposite. Each note is read with a fresh fast sigma (faithful
  forgetting between contexts). A normalized, symmetrized copy is then added
  to a slow sigma that persists on disk. Symmetry is not in the paper's
  directional rule; it is there so "Lelit" recalls "Comandante" and the
  reverse. Slow weights are the extension, fast weights are the paper.
* The whole state is disposable. Markdown in the vault is the only source of
  truth; ``rebuild`` recomputes sigma from entity text.
"""

from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass

import torch
from torch import nn

# Letters, including Czech diacritics. Digits and punctuation are not neurons.
_TOKEN = re.compile(r"[^\W\d_]+", re.UNICODE)
FORMAT = "umm-bdh-1"
DEFAULT_NEURONS = 1024
DEFAULT_K = 4
DEFAULT_DECAY = 0.9
DEFAULT_SEED = 250926507  # arXiv id of the BDH paper, used only as a stable salt
MAX_TOKENS = 512


def tokenize(text: str, limit: int = MAX_TOKENS) -> list[str]:
    """Case-folded word tokens. Tokens shorter than 3 characters are dropped.

    The length cutoff is a tokenizer choice, not a BDH rule. It keeps function
    words ("na", "to", "a") from welding unrelated notes together.
    """
    words = [match.group(0).casefold() for match in _TOKEN.finditer(text)]
    return [word for word in words if len(word) >= 3][:limit]


def document_tokens(title: str, aliases: list[str], content: str) -> list[str]:
    parts = [title, *aliases, content]
    return tokenize("\n".join(part for part in parts if part))


def _indices(token: str, n: int, k: int, seed: int) -> list[int]:
    chosen: list[int] = []
    seen: set[int] = set()
    counter = 0
    while len(chosen) < k and counter < n * 8:
        digest = hashlib.blake2s(f"{seed}|{token}|{counter}".encode(), digest_size=8).digest()
        idx = int.from_bytes(digest, "little") % n
        counter += 1
        if idx not in seen:
            seen.add(idx)
            chosen.append(idx)
    return chosen


class SparseConceptEncoder(nn.Module):
    """Fixed sparse code standing in for BDH's trained ReLU-lowrank encoder.

    No parameters are learned. ``n``, ``k`` and ``seed`` fully determine the
    map, so a rebuilt index lands on the same neurons as the one it replaces.
    """

    def __init__(self, n: int, k: int, seed: int) -> None:
        super().__init__()
        if n < 8:
            raise ValueError("n must be at least 8")
        if not 1 <= k < n:
            raise ValueError("k must be in 1..n-1")
        self.n = n
        self.k = k
        self.seed = seed

    def codes(self, tokens: list[str]) -> torch.Tensor:
        if not tokens:
            return torch.zeros(0, self.n)
        scale = 1.0 / math.sqrt(self.k)
        out = torch.zeros(len(tokens), self.n)
        for row, token in enumerate(tokens):
            out[row, _indices(token, self.n, self.k, self.seed)] = scale
        return out


class HebbianSynapse(nn.Module):
    """Persistent slow synaptic state. ``sigma[i, j]`` is the synapse i -> j."""

    def __init__(self, n: int) -> None:
        super().__init__()
        self.register_buffer("sigma", torch.zeros(n, n))

    def add_delta(self, delta: torch.Tensor) -> None:
        self.sigma.add_(delta)

    def sub_delta(self, delta: torch.Tensor) -> None:
        self.sigma.sub_(delta)

    def reset(self) -> None:
        self.sigma.zero_()

    def readout(self, activity: torch.Tensor) -> torch.Tensor:
        # A(j) = sum_i X(i) * sigma(i, j). Sigma is stored symmetric, so
        # sigma @ x and sigma.T @ x agree; the directional form is sigma.T @ x
        # when rows are presynaptic.
        return torch.mv(self.sigma, activity)


def fast_sigma(codes: torch.Tensor, decay: float) -> torch.Tensor:
    """Within-context Hebbian state. Discarded after the note is consolidated.

    Online rule, one token at a time (BDH inference):

        sigma += outer(Y, x)     # Y(i) * X(j)
        Y = decay * Y + x

    Computed in closed form: the eligibility trace before token t is
    Y_t = sum_{s<t} decay^(t-1-s) x_s, so sigma = Y^T X. This is the same sum as
    the loop, but one matrix product per note instead of one outer product per
    token, which keeps rebuilds fast for large neuron counts.
    """
    tokens, n = codes.shape
    if tokens == 0:
        return torch.zeros(n, n)
    positions = torch.arange(tokens, dtype=codes.dtype)
    gap = positions[:, None] - positions[None, :] - 1  # t - s - 1
    weights = torch.where(gap >= 0, torch.pow(torch.tensor(decay, dtype=codes.dtype), gap.clamp(min=0)), torch.zeros(()))
    trace = weights @ codes
    return trace.transpose(0, 1) @ codes


def slow_delta(codes: torch.Tensor, decay: float) -> torch.Tensor:
    """Consolidate one context into a unit-scale symmetric slow update.

    Fast sigma is directional and dies with the context. The copy written into
    long-term memory is symmetrized so association works in both directions,
    then Frobenius-normalized so a long note cannot drown a short one.
    """
    if codes.shape[0] < 2:
        return torch.zeros(codes.shape[-1], codes.shape[-1]) if codes.ndim == 2 else torch.zeros(0)
    sigma = fast_sigma(codes, decay)
    sym = sigma + sigma.transpose(0, 1)
    norm = torch.linalg.norm(sym)
    if float(norm) == 0.0:
        return sym
    return sym / norm


def inhibit(activity: torch.Tensor, peak_fraction: float = 0.25) -> torch.Tensor:
    """Crude inhibitory circuit: subtract the mean, keep neurons near the peak.

    BDH uses a separate inhibitory population and integrate-and-fire
    thresholding. This keeps the same qualitative effect (sparse positive
    recall) without simulating spikes. Neurons below ``peak_fraction`` of the
    strongest firing are treated as not having fired.
    """
    if activity.numel() == 0 or float(activity.sum()) <= 0.0:
        return torch.zeros_like(activity)
    fired = torch.relu(activity - activity.mean())
    peak = float(fired.max())
    if peak <= 0.0:
        return fired
    return torch.where(fired >= peak_fraction * peak, fired, torch.zeros_like(fired))


def index_matrix(tokens: list[str], n: int, k: int, seed: int) -> torch.Tensor:
    if not tokens:
        return torch.zeros(0, k, dtype=torch.long)
    return torch.tensor([_indices(token, n, k, seed) for token in tokens], dtype=torch.long)


@dataclass
class Association:
    id: str
    score: float


@dataclass
class _Entity:
    tokens: list[str]
    revision: str
    indices: torch.Tensor


class AssociativeBDH(nn.Module):
    """In-process associative index. Callers persist ``state_dict`` themselves."""

    def __init__(
        self,
        n: int = DEFAULT_NEURONS,
        k: int = DEFAULT_K,
        decay: float = DEFAULT_DECAY,
        seed: int = DEFAULT_SEED,
    ) -> None:
        super().__init__()
        if not 0.0 < decay < 1.0:
            raise ValueError("decay must be in (0, 1)")
        self.n = n
        self.k = k
        self.decay = decay
        self.seed = seed
        # A concept is its whole code, not one neuron. Majority rejects collisions.
        self.min_overlap = (k // 2) + 1
        self.encoder = SparseConceptEncoder(n, k, seed)
        self.synapse = HebbianSynapse(n)
        self.entities: dict[str, _Entity] = {}
        self.eval()

    @torch.inference_mode()
    def upsert(self, entity_id: str, title: str, aliases: list[str], content: str, revision: str = "") -> dict[str, int | bool | str]:
        tokens = document_tokens(title, aliases, content)
        current = self.entities.get(entity_id)
        if current is not None and current.tokens == tokens:
            current.revision = revision
            return {"id": entity_id, "tokens": len(tokens), "replaced": True, "unchanged": True}
        if current is not None:
            self.synapse.sub_delta(self._delta(current.tokens))
        delta = self._delta(tokens)
        self.synapse.add_delta(delta)
        self.entities[entity_id] = _Entity(tokens=tokens, revision=revision, indices=index_matrix(tokens, self.n, self.k, self.seed))
        return {"id": entity_id, "tokens": len(tokens), "replaced": current is not None, "unchanged": False}

    @torch.inference_mode()
    def remove(self, entity_id: str) -> bool:
        current = self.entities.pop(entity_id, None)
        if current is None:
            return False
        self.synapse.sub_delta(self._delta(current.tokens))
        return True

    @torch.inference_mode()
    def rebuild(self, documents: list[dict[str, object]], reset: bool = True) -> int:
        if reset:
            self.synapse.reset()
            self.entities.clear()
        for document in documents:
            entity_id = str(document.get("id", "")).strip()
            if not entity_id:
                continue
            aliases = document.get("aliases") or []
            alias_list = [str(item) for item in aliases] if isinstance(aliases, list) else []
            self.upsert(
                entity_id,
                str(document.get("title") or ""),
                alias_list,
                str(document.get("content") or ""),
                str(document.get("revision") or ""),
            )
        return len(self.entities)

    @torch.inference_mode()
    def associate(self, query: str, limit: int = 10) -> list[Association]:
        tokens = tokenize(query)
        if not tokens or not self.entities or limit <= 0:
            return []
        query_activity = self.encoder.codes(tokens).sum(dim=0)
        norm = torch.linalg.norm(query_activity)
        if float(norm) == 0.0:
            return []
        query_activity = query_activity / norm
        recalled = inhibit(self.synapse.readout(query_activity))
        scored: list[Association] = []
        for entity_id, entity in self.entities.items():
            # Direct: the note literally uses a query word. Synaptic: a word in
            # the note was wired to the query by co-activation in some context.
            # max keeps the score on the cosine scale.
            score = max(self._best_word(query_activity, entity.indices), self._best_word(recalled, entity.indices))
            if score > 0.0:
                scored.append(Association(id=entity_id, score=round(score, 6)))
        scored.sort(key=lambda item: (-item.score, item.id))
        return scored[:limit]

    def _best_word(self, pattern: torch.Tensor, indices: torch.Tensor) -> float:
        if indices.numel() == 0:
            return 0.0
        norm = torch.linalg.norm(pattern)
        if float(norm) == 0.0:
            return 0.0
        support = pattern > 0
        counts = support[indices].sum(dim=1)
        eligible = counts >= self.min_overlap
        if not bool(eligible.any()):
            return 0.0
        unit = pattern / norm
        dots = unit[indices].sum(dim=1) / math.sqrt(self.k)
        return float(dots[eligible].max())

    def state_dict_payload(self) -> dict[str, object]:
        return {
            "format": FORMAT,
            "n": self.n,
            "k": self.k,
            "decay": self.decay,
            "seed": self.seed,
            "sigma": self.synapse.sigma.detach().cpu().clone(),
            "entities": {
                entity_id: {"tokens": entity.tokens, "revision": entity.revision}
                for entity_id, entity in self.entities.items()
            },
        }

    @torch.inference_mode()
    def load_payload(self, payload: dict[str, object]) -> None:
        if payload.get("format") != FORMAT:
            raise ValueError("unsupported neural state format")
        if int(payload["n"]) != self.n or int(payload["k"]) != self.k or int(payload["seed"]) != self.seed or float(payload["decay"]) != self.decay:
            raise ValueError("neural state was built with different encoder settings; rebuild from Markdown")
        sigma = payload["sigma"]
        if not isinstance(sigma, torch.Tensor) or tuple(sigma.shape) != (self.n, self.n):
            raise ValueError("neural state sigma has an unexpected shape")
        self.synapse.sigma.copy_(sigma.to(dtype=self.synapse.sigma.dtype))
        self.entities.clear()
        raw_entities = payload.get("entities") or {}
        if not isinstance(raw_entities, dict):
            raise ValueError("neural state entities are malformed")
        for entity_id, record in raw_entities.items():
            if not isinstance(record, dict):
                continue
            tokens = [str(token) for token in record.get("tokens") or []]
            self.entities[str(entity_id)] = _Entity(
                tokens=tokens,
                revision=str(record.get("revision") or ""),
                indices=index_matrix(tokens, self.n, self.k, self.seed),
            )

    def _delta(self, tokens: list[str]) -> torch.Tensor:
        if len(tokens) < 2:
            return torch.zeros(self.n, self.n)
        return slow_delta(self.encoder.codes(tokens), self.decay)
