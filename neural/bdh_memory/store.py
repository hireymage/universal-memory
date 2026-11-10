"""Disk persistence for the slow synaptic state.

The file lives under the server state directory, never inside the vault.
Deleting it drops the neural index only. The next reindex rebuilds it from
Markdown.
"""

from __future__ import annotations

import os
from pathlib import Path

import torch

from .model import AssociativeBDH


class StateStore:
    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.file = directory / "bdh.pt"

    def exists(self) -> bool:
        return self.file.is_file()

    def load(self) -> dict[str, object]:
        payload = torch.load(self.file, map_location="cpu", weights_only=True)
        if not isinstance(payload, dict):
            raise ValueError("neural state file is not a dictionary")
        return payload

    def save(self, model: AssociativeBDH) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        temporary = self.file.with_suffix(".pt.tmp")
        torch.save(model.state_dict_payload(), temporary)
        os.replace(temporary, self.file)
