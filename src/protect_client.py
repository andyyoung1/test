"""
UniFi Protect API client — routed through the UniFi Site Manager cloud API.

All requests go to api.ui.com using the X-API-KEY header.  On first use,
the client discovers the console host ID automatically; set PROTECT_HOST_ID
in .env to pin a specific console when you have more than one.
"""

from __future__ import annotations

import base64
import logging
from dataclasses import dataclass, field

import httpx

logger = logging.getLogger(__name__)

CLOUD_BASE = "https://api.ui.com"

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
    """Async client for UniFi Protect, proxied through the Site Manager cloud API."""

    def __init__(self, api_key: str, host_id: str | None = None) -> None:
        self._host_id = host_id
        self._http = httpx.AsyncClient(
            base_url=CLOUD_BASE,
            headers={"X-API-KEY": api_key},
            timeout=60,  # cloud proxy adds ~800 ms latency
            follow_redirects=True,
        )
        self._cameras: dict[str, str] = {}  # id -> display name

    # ------------------------------------------------------------------
    # Host discovery
    # ------------------------------------------------------------------

    async def _resolve_host_id(self) -> None:
        """Auto-discover the console host ID from GET /v1/hosts."""
        resp = await self._http.get("/v1/hosts")
        resp.raise_for_status()
        hosts = resp.json().get("data", resp.json())  # handle both envelope shapes
        if not hosts:
            raise RuntimeError("No UniFi consoles found under this API key.")
        if len(hosts) > 1:
            ids = [h["id"] for h in hosts]
            raise RuntimeError(
                f"Multiple consoles found: {ids}\n"
                "Set PROTECT_HOST_ID in .env to choose one."
            )
        self._host_id = hosts[0]["id"]
        logger.info("Auto-discovered console host ID: %s", self._host_id)

    def _protect(self, path: str) -> str:
        """Build the cloud proxy path for a Protect API endpoint."""
        return f"/v1/connector/consoles/{self._host_id}/proxy/protect/api{path}"

    # ------------------------------------------------------------------
    # Bootstrap — load camera names once
    # ------------------------------------------------------------------

    async def load_cameras(self) -> None:
        if not self._host_id:
            await self._resolve_host_id()
        resp = await self._http.get(self._protect("/bootstrap"))
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
            self._protect("/events"),
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
                self._protect(f"/events/{event_id}/thumbnail"),
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
