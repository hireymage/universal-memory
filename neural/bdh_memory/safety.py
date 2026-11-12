"""Load-time guards for neural state and model downloads.

``torch.load(..., weights_only=True)`` is not sufficient on its own.
CVE-2025-32434 (fixed in 2.6.0) and CVE-2026-24747 (fixed in 2.10.0) both
achieve code execution through that flag. State files are refused below 2.10
unless ``BDH_ALLOW_UNSAFE_TORCH=1`` is set.

Hub downloads of the embedding model are off unless
``BDH_ALLOW_MODEL_DOWNLOAD=1``. The container image bakes the weights in and
already sets ``HF_HUB_OFFLINE=1``.
"""

from __future__ import annotations

import os

MIN_TORCH = (2, 10, 0)


def torch_version_tuple(version: str) -> tuple[int, int, int]:
    head = version.split("+", 1)[0]
    parts: list[int] = []
    for piece in head.split("."):
        digits = ""
        for char in piece:
            if char.isdigit():
                digits += char
            else:
                break
        if not digits:
            break
        parts.append(int(digits))
    while len(parts) < 3:
        parts.append(0)
    return (parts[0], parts[1], parts[2])


def ensure_torch_load_allowed(version: str | None = None) -> None:
    if os.environ.get("BDH_ALLOW_UNSAFE_TORCH", "") == "1":
        return
    current = version if version is not None else __import__("torch").__version__
    if torch_version_tuple(current) < MIN_TORCH:
        raise RuntimeError(
            f"refusing to load neural state with torch {current}; "
            "weights_only=True is not sufficient before 2.10.0 "
            "(CVE-2025-32434, CVE-2026-24747). Upgrade torch or set BDH_ALLOW_UNSAFE_TORCH=1"
        )


def configure_model_download() -> None:
    """Keep Hugging Face offline unless the operator opts in."""
    if os.environ.get("BDH_ALLOW_MODEL_DOWNLOAD", "") == "1":
        return
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
