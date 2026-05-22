/**
 * Protect-side summarization.
 * The cloud `camera_status` tool already covers basic online/offline.
 * Here we surface the richer Protect-only fields: recording mode, last motion,
 * smart-detect config, NVR storage health, event counts.
 */

import type { ProtectCamera, ProtectEvent, ProtectNvr } from "./client.js";

export interface CameraDetail {
  id: string;
  name?: string;
  model?: string;
  state?: string;
  isConnected?: boolean;
  isRecording?: boolean;
  recordingMode?: string;
  smartDetectTypes?: string[];
  hasPackageCamera?: boolean;
  lastMotion?: string;     // ISO string
  lastSeen?: string;
  upSince?: string;
}

export interface ProtectOverview {
  nvr: {
    name?: string;
    version?: string;
    firmwareVersion?: string;
    hardware?: string;
    timezone?: string;
    storage?: {
      totalBytes?: number;
      usedBytes?: number;
      percentUsed?: number;
    };
  };
  cameras: {
    total: number;
    connected: number;
    disconnected: number;
    recording: number;
    byRecordingMode: Record<string, number>;
    withPackageCamera: number;
    motionInLast24h: number;
  };
  cameraDetails: CameraDetail[];
}

export interface EventSummary {
  id: string;
  type?: string;
  smartDetectTypes?: string[];
  cameraId?: string;
  cameraName?: string;
  start?: string;
  end?: string;
  durationSec?: number;
  score?: number;
}

const NOW_MS = () => Date.now();
const TWENTY_FOUR_H_MS = 24 * 60 * 60 * 1000;

function toISO(ms?: number): string | undefined {
  return ms ? new Date(ms).toISOString() : undefined;
}

export function cameraDetail(c: ProtectCamera): CameraDetail {
  return {
    id: c.id,
    name: c.name,
    model: c.type ?? c.modelKey,
    state: c.state,
    isConnected: c.isConnected,
    isRecording: c.isRecording,
    recordingMode: c.recordingSettings?.mode,
    smartDetectTypes: c.smartDetectSettings?.objectTypes,
    hasPackageCamera: c.featureFlags?.hasPackageCamera,
    lastMotion: toISO(c.lastMotion),
    lastSeen: toISO(c.lastSeen),
    upSince: toISO(c.upSince),
  };
}

export function protectOverview(
  nvr: ProtectNvr,
  cameras: ProtectCamera[],
): ProtectOverview {
  const connected = cameras.filter((c) => c.isConnected !== false).length;
  const recording = cameras.filter((c) => c.isRecording).length;
  const byRecordingMode: Record<string, number> = {};
  for (const c of cameras) {
    const mode = c.recordingSettings?.mode ?? "unknown";
    byRecordingMode[mode] = (byRecordingMode[mode] ?? 0) + 1;
  }
  const withPackageCamera = cameras.filter((c) => c.featureFlags?.hasPackageCamera).length;

  const since = NOW_MS() - TWENTY_FOUR_H_MS;
  const motionInLast24h = cameras.filter((c) => c.lastMotion && c.lastMotion >= since).length;

  const storage = nvr.storageInfo
    ? {
        totalBytes: nvr.storageInfo.totalSize,
        usedBytes: nvr.storageInfo.totalSpaceUsed,
        percentUsed:
          nvr.storageInfo.totalSize && nvr.storageInfo.totalSpaceUsed
            ? Math.round(
                (nvr.storageInfo.totalSpaceUsed / nvr.storageInfo.totalSize) * 1000,
              ) / 10
            : undefined,
      }
    : undefined;

  return {
    nvr: {
      name: nvr.name,
      version: nvr.version,
      firmwareVersion: nvr.firmwareVersion,
      hardware: [nvr.hardwarePlatform, nvr.hardwareRevision].filter(Boolean).join(" "),
      timezone: nvr.timezone,
      storage,
    },
    cameras: {
      total: cameras.length,
      connected,
      disconnected: cameras.length - connected,
      recording,
      byRecordingMode,
      withPackageCamera,
      motionInLast24h,
    },
    cameraDetails: cameras.map(cameraDetail),
  };
}

/** Build a name lookup so events get camera names, not just IDs. */
export function cameraNameLookup(cameras: ProtectCamera[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of cameras) if (c.name) m.set(c.id, c.name);
  return m;
}

export function eventSummary(
  e: ProtectEvent,
  names?: Map<string, string>,
): EventSummary {
  const cameraName = e.camera && names?.get(e.camera);
  return {
    id: e.id,
    type: e.type,
    smartDetectTypes: e.smartDetectTypes,
    cameraId: e.camera,
    cameraName,
    start: toISO(e.start),
    end: toISO(e.end),
    durationSec:
      e.start && e.end ? Math.max(0, Math.round((e.end - e.start) / 1000)) : undefined,
    score: e.score,
  };
}
