"""Tracks whether the screen has delivered a frame since the last input action.

Used by the screen sidecar so a screenshot taken right after a click cannot
silently return the pre-click picture. Pure Python, no GStreamer, so it can be
tested anywhere.
"""

# How long a capture waits for a post-input frame before reporting it stale.
SETTLE_MS = 1000


class FreshnessGate:
    def __init__(self):
        self._frames = 0
        self._input_mark = None

    def note_frame(self):
        """Call once for every new frame the stream delivers."""
        self._frames += 1

    def mark_input(self):
        """Call after every action that can change what is on screen."""
        self._input_mark = self._frames

    def is_fresh(self):
        """True when no input is pending, or a frame has arrived since the last input."""
        return self._input_mark is None or self._frames > self._input_mark
