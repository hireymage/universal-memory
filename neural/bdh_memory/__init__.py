"""Experimental BDH associative memory for Universal Memory MCP.

The Hebbian synaptic state (sigma) and its linear readout are the Dragon
Hatchling working-memory rules. The sparse encoder and the persistent slow
weights are documented simplifications; see ``model.py``.
"""

from .model import Association, AssociativeBDH

__all__ = ["Association", "AssociativeBDH"]
