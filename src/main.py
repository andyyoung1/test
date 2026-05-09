"""
UniFi Protect + Claude event summarizer.

Polls the Protect controller for new camera events on a configurable interval,
downloads thumbnails, and uses Claude to generate plain-English summaries.

Usage:
    cp .env.example .env          # fill in your credentials
    pip install -r requirements.txt
    python -m src.main
"""

from __future__ import annotations

import asyncio
import logging
import os
import time

from dotenv import load_dotenv

from .protect_client import ProtectClient
from .claude_summarizer import ClaudeSummarizer

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger(__name__)


def _require(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Environment variable {name!r} is required but not set.")
    return value


async def run() -> None:
    host = _require("PROTECT_HOST")
    username = _require("PROTECT_USERNAME")
    password = _require("PROTECT_PASSWORD")
    poll_interval = int(os.getenv("POLL_INTERVAL", "30"))

    protect = ProtectClient(host, username, password)
    summarizer = ClaudeSummarizer()

    try:
        await protect.login()
        await protect.load_cameras()

        # Start polling from now; on the first tick we look back one interval
        # so we don't miss events that arrived right before startup.
        last_poll_ms = int(time.time() * 1000) - poll_interval * 1000

        logger.info(
            "Polling every %ds — press Ctrl-C to stop", poll_interval
        )

        while True:
            now_ms = int(time.time() * 1000)
            events = await protect.fetch_events(last_poll_ms, now_ms)
            last_poll_ms = now_ms

            if events:
                logger.info("Found %d new event(s)", len(events))
            else:
                logger.debug("No new events")

            for event in events:
                # Fetch thumbnail (best-effort; Claude falls back to metadata only)
                event.thumbnail_b64 = await protect.fetch_thumbnail_b64(event.id)

                summary = await summarizer.summarise(event)

                has_image = "📷" if event.thumbnail_b64 else "  "
                print(
                    f"\n{has_image} [{event.start_iso}] {event.camera_name}\n"
                    f"   {event}\n"
                    f"   → {summary}"
                )

            await asyncio.sleep(poll_interval)

    except asyncio.CancelledError:
        pass
    finally:
        await protect.close()
        await summarizer.close()
        logger.info("Shutdown complete.")


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
