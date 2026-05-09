"""
UniFi Protect API client.

Handles authentication, event polling, and thumbnail downloads.
The Protect API uses cookie-based auth (TOKEN cookie) obtained by POSTing
credentials to /api/auth/login on the controller.
"""

from __future__ import annotations

import base64
import logging
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# Protect event types we care about
INTERESTING_TYPES = {"motion", "ring", "smartDetectZone", "smartDetectLine"}


@dataclass
class ProtectEvent:
    id: str
    type: str
    camera_id: str
    camera_name: str
    start: int  # epoch ms
    end: int | None  # epoch ms, None if still in progress
    score: int
    smart_detect_types: list[str] = field(default_factory=list)
    thumbnail_b64: str | None = None  # base64-encoded JPEG, populated after fetch

    @property
    def start_iso(self) -> str:
        import datetime
        return datetime.datetime.fromtimestamp(self.start / 1000).isoformat(timespec="seconds")

    def __repr__(self) -> str:
        label = "/".join(self.smart_detect_types) if self.smart_detect_types else self.type
        return f"<ProtectEvent {self.id} {label} cam={self.camera_name} at={self.start_iso}>"


class ProtectClient:
    """Async client for the UniFi Protect local API."""

    def __init__(self, host: str, api_key: str) -> None:
        self._host = host.rstrip("/")
        # SSL verification is disabled because home controllers use self-signed certs.
        self._http = httpx.AsyncClient(
            base_url=f"https://{self._host}",
            headers={"X-API-KEY": api_key},
            verify=False,
            timeout=30,
            follow_redirects=True,
        )
        self._cameras: dict[str, str] = {}  # id -> display name

    # ------------------------------------------------------------------
    # Bootstrap — load camera names once
    # ------------------------------------------------------------------

    async def load_cameras(self) -> None:
        resp = await self._http.get("/proxy/protect/api/bootstrap")
        resp.raise_for_status()
        data = resp.json()
        self._cameras = {
            cam["id"]: cam.get("name") or cam.get("id")
            for cam in data.get("cameras", [])
        }
        logger.info("Loaded %d cameras", len(self._cameras))

    # ------------------------------------------------------------------
    # Events
    # ------------------------------------------------------------------

    async def fetch_events(self, since_ms: int, until_ms: int) -> list[ProtectEvent]:
        """Return completed events whose start time falls in [since_ms, until_ms)."""
        resp = await self._http.get(
            "/proxy/protect/api/events",
            params={"start": since_ms, "end": until_ms},
        )
        resp.raise_for_status()

        events: list[ProtectEvent] = []
        for raw in resp.json():
            if raw.get("type") not in INTERESTING_TYPES:
                continue
            if raw.get("end") is None:
                continue  # skip events still in progress

            camera_id = raw.get("camera", "")
            events.append(
                ProtectEvent(
                    id=raw["id"],
                    type=raw["type"],
                    camera_id=camera_id,
                    camera_name=self._cameras.get(camera_id, camera_id),
                    start=raw["start"],
                    end=raw.get("end"),
                    score=raw.get("score", 0),
                    smart_detect_types=raw.get("smartDetectTypes", []),
                )
            )
        return events

    # ------------------------------------------------------------------
    # Thumbnails
    # ------------------------------------------------------------------

    async def fetch_thumbnail_b64(self, event_id: str) -> str | None:
        """Return a base64-encoded JPEG thumbnail, or None on failure."""
        try:
            resp = await self._http.get(
                f"/proxy/protect/api/events/{event_id}/thumbnail",
                params={"width": 640},
            )
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            return base64.standard_b64encode(resp.content).decode()
        except httpx.HTTPError as exc:
            logger.warning("Could not fetch thumbnail for %s: %s", event_id, exc)
            return None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def close(self) -> None:
        await self._http.aclose()
