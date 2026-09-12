"""Quota-aware task scheduling for Claude Code, driven over the Herdr socket.

Queue coding tasks; they run while the Claude subscription has usage left,
checkpoint when a window runs dry, and resume when the next one opens.

State lives alongside the gateway's other state so there is one thing to back
up and one service to run.
"""

import os
from pathlib import Path

STATE_DIR = Path(os.environ.get("SHEEPIT_STATE_DIR", Path.home() / ".config/sheepit"))
