"""
Claude-powered summarizer for UniFi Protect camera events.

Uses claude-sonnet-4-6 with vision to describe what happened in each event.
The system prompt is marked with cache_control so it is cached across the
many per-event calls made during a polling session (the prompt never changes).
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

import anthropic

if TYPE_CHECKING:
    from .protect_client import ProtectEvent

logger = logging.getLogger(__name__)

MODEL = "claude-sonnet-4-6"

# Stable system prompt — cached after the first request.
_SYSTEM_PROMPT = """You are a home-security assistant that summarises camera events from a UniFi Protect system.

When given metadata and an optional thumbnail image for a single camera event, write a concise one-to-two sentence plain-English summary describing what happened. Focus on:
- Who or what was detected (person, vehicle, animal, package, etc.)
- Where in the frame they appeared, if discernible
- Any notable behaviour (walking, running, stationary, doorbell ring, etc.)

Keep the summary factual and neutral. Do not speculate beyond what is visible. If no image is provided, base the summary only on the metadata."""


def _event_text(event: "ProtectEvent") -> str:
    """Build a concise metadata block to include alongside the image."""
    parts = [
        f"Camera: {event.camera_name}",
        f"Time: {event.start_iso}",
        f"Event type: {event.type}",
    ]
    if event.smart_detect_types:
        parts.append(f"Smart detections: {', '.join(event.smart_detect_types)}")
    if event.score:
        parts.append(f"Confidence score: {event.score}%")
    return "\n".join(parts)


class ClaudeSummarizer:
    """Summarise Protect events using Claude's vision API."""

    def __init__(self, api_key: str | None = None) -> None:
        # api_key=None picks up ANTHROPIC_API_KEY from the environment.
        self._client = anthropic.AsyncAnthropic(api_key=api_key)

    async def summarise(self, event: "ProtectEvent") -> str:
        """Return a human-readable summary of the event."""
        user_content: list[dict] = []

        # Attach thumbnail when available.
        if event.thumbnail_b64:
            user_content.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/jpeg",
                        "data": event.thumbnail_b64,
                    },
                }
            )

        user_content.append(
            {"type": "text", "text": _event_text(event)}
        )

        response = await self._client.messages.create(
            model=MODEL,
            max_tokens=256,
            # Cache the system prompt — it never changes between calls.
            system=[
                {
                    "type": "text",
                    "text": _SYSTEM_PROMPT,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[{"role": "user", "content": user_content}],
        )

        text = next(
            (block.text for block in response.content if block.type == "text"), ""
        )
        logger.debug(
            "Claude usage for event %s — input: %d (cached: %d) output: %d",
            event.id,
            response.usage.input_tokens,
            response.usage.cache_read_input_tokens or 0,
            response.usage.output_tokens,
        )
        return text

    async def close(self) -> None:
        await self._client.close()
