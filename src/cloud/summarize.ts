/**
 * Camera detection + status summarization.
 * Ported from the Python reference; keeps the same field names so existing
 * callers/tests stay compatible.
 */

import type { RawDevice } from "./client.js";

const CAMERA_PRODUCT_LINES = new Set(["protect", "unifi-protect", "camera"]);
const CAMERA_MODEL_HINTS = ["UVC", "G3", "G4", "G5", "G6", "AI", "CAMERA"];

export interface DeviceSummary {
  id?: string;
  name?: string;
  model?: string;
  mac?: string;
  ip?: string;
  status?: string;
  isManaged?: boolean;
  firmwareVersion?: string;
  firmwareStatus?: string;
  adoptionTime?: string;
  lastSeen?: string;
  uptime?: number;
  host: {
    id?: string;
    name?: string;
  };
}

export interface CameraStatusSummary {
  overview: {
    totalCameras: number;
    online: number;
    offline: number;
    unknownState: number;
    firmwareUpdatesAvailable: number;
  };
  offline: DeviceSummary[];
  needsFirmwareUpdate: DeviceSummary[];
  allCameras: DeviceSummary[];
}

export function isCamera(d: RawDevice): boolean {
  const pl = (d.productLine ?? "").toLowerCase();
  if (CAMERA_PRODUCT_LINES.has(pl)) return true;
  if (pl.includes("camera")) return true;
  const text = `${d.name ?? ""} ${d.shortname ?? d.model ?? ""}`.toUpperCase();
  return CAMERA_MODEL_HINTS.some((hint) => text.includes(hint));
}

export function deviceSummary(d: RawDevice): DeviceSummary {
  return {
    id: d.id,
    name: d.name,
    model: d.shortname ?? d.model,
    mac: d.mac,
    ip: d.ip,
    status: d.status,
    isManaged: d.isManaged,
    firmwareVersion: d.firmwareVersion,
    firmwareStatus: d.firmwareStatus,
    adoptionTime: d.adoptionTime,
    lastSeen: d.lastSeen ?? d.startupTimestamp,
    uptime: d.uptime,
    host: {
      id: d._hostId,
      name: d._hostName,
    },
  };
}

const FW_UPDATE_STATES = new Set(["outdated", "update-available", "upgradable"]);

export function cameraStatusSummary(devices: RawDevice[]): CameraStatusSummary {
  const cameras = devices.filter(isCamera);

  const online: RawDevice[] = [];
  const offline: RawDevice[] = [];
  const other: RawDevice[] = [];

  for (const c of cameras) {
    const s = (c.status ?? "").toLowerCase();
    if (s === "online") online.push(c);
    else if (s === "offline") offline.push(c);
    else other.push(c);
  }

  const needsUpdate = cameras.filter((c) =>
    FW_UPDATE_STATES.has((c.firmwareStatus ?? "").toLowerCase()),
  );

  return {
    overview: {
      totalCameras: cameras.length,
      online: online.length,
      offline: offline.length,
      unknownState: other.length,
      firmwareUpdatesAvailable: needsUpdate.length,
    },
    offline: offline.map(deviceSummary),
    needsFirmwareUpdate: needsUpdate.map(deviceSummary),
    allCameras: cameras.map(deviceSummary),
  };
}
