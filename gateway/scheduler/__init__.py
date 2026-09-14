"""Quota-aware prompt delivery for Claude Code, driven over the Herdr socket.

Queue prompts for a chat you already have open; they are delivered while the
Claude subscription has usage left, halt when a window runs dry, and pick up
where they left off when the next one opens.

State lives alongside the gateway's other state so there is one thing to back
up and one service to run.
"""

import os
from pathlib import Path

STATE_DIR = Path(os.environ.get("SHEEPIT_STATE_DIR", Path.home() / ".config/sheepit"))
