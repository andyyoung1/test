/**
 * Latency log — persistent record of transport_status latency measurements.
 *
 * Append-only JSONL file with size-based trimming. Each line is a complete
 * record so a partial write at the end doesn't corrupt earlier history.
 *
 * Storage location:
 *   - Linux/macOS: ~/.cache/unifi-status/latency.jsonl
 *   - Windows: %LOCALAPPDATA%\unifi-status\latency.jsonl
 *   - Override with UNIFI_LATENCY_LOG env var (mostly for testing).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const MAX_BYTES = 1_048_576; // 1 MB cap — roughly 10k records
const TRIM_TO_BYTES = 838_860; // trim to ~80% of cap, leaving headroom
const FILE_NAME = "latency.jsonl";

export interface LatencyRecord {
  /** ISO 8601 timestamp */
  ts: string;
  /** Host ID of the local console (or "_cloud" for cloud-only) */
  hostId: string;
  /** Display name (best-effort) */
  name?: string;
  /** Probe surface — "network" | "protect" | "cloud" */
  surface: string;
  /** Whether the probe succeeded */
  ok: boolean;
  /** Round-trip in ms; only populated when ok */
  latencyMs?: number;
  /** Error message, if any (truncated) */
  error?: string;
}

function getLogDir(): string {
  if (process.env.UNIFI_LATENCY_LOG) {
    return path.dirname(process.env.UNIFI_LATENCY_LOG);
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "unifi-status");
  }
  // macOS and Linux both honor XDG_CACHE_HOME, falling back to ~/.cache
  const base = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(base, "unifi-status");
}

function getLogPath(): string {
  if (process.env.UNIFI_LATENCY_LOG) return process.env.UNIFI_LATENCY_LOG;
  return path.join(getLogDir(), FILE_NAME);
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(getLogDir(), { recursive: true });
}

/**
 * Append a batch of records as a single write — atomic enough for our needs.
 * Trims the file in-place when it crosses the cap.
 */
export async function appendRecords(records: LatencyRecord[]): Promise<void> {
  if (records.length === 0) return;
  await ensureDir();
  const logPath = getLogPath();

  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await fs.appendFile(logPath, lines, "utf8");

  // Cheap size check — only stat occasionally to amortize cost
  try {
    const stat = await fs.stat(logPath);
    if (stat.size > MAX_BYTES) {
      await trimToTarget(logPath, TRIM_TO_BYTES);
    }
  } catch {
    // If stat fails, the file's gone — append next time will recreate.
  }
}

/**
 * Trim the JSONL file from the front to roughly `targetBytes`, keeping the
 * newest records. Done in-place via a temp file + rename for atomicity.
 */
async function trimToTarget(logPath: string, targetBytes: number): Promise<void> {
  const tmpPath = logPath + ".tmp";
  try {
    const content = await fs.readFile(logPath, "utf8");
    if (content.length <= targetBytes) return;

    // Find a line boundary near (length - targetBytes) so we don't split a record
    const startOffset = content.length - targetBytes;
    const newlineIdx = content.indexOf("\n", startOffset);
    if (newlineIdx === -1) return; // shouldn't happen given the size, but be safe

    const kept = content.slice(newlineIdx + 1);
    await fs.writeFile(tmpPath, kept, "utf8");
    await fs.rename(tmpPath, logPath);
  } catch {
    // best-effort; failure to trim isn't fatal
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
  }
}

export interface ReadOpts {
  /** Maximum number of records to return (newest first) */
  limit?: number;
  /** Only records since this ISO timestamp */
  since?: string;
  /** Filter by surface */
  surface?: string;
  /** Filter by hostId */
  hostId?: string;
}

/**
 * Read records from the log. Returns oldest→newest within the filter.
 * Tolerates malformed lines by skipping them.
 */
export async function readRecords(opts: ReadOpts = {}): Promise<LatencyRecord[]> {
  const logPath = getLogPath();
  let content: string;
  try {
    content = await fs.readFile(logPath, "utf8");
  } catch {
    return [];
  }

  const sinceMs = opts.since ? Date.parse(opts.since) : 0;
  const out: LatencyRecord[] = [];
  // Iterate line by line, skipping malformed
  const lines = content.split("\n");
  for (const line of lines) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as LatencyRecord;
      if (opts.surface && r.surface !== opts.surface) continue;
      if (opts.hostId && r.hostId !== opts.hostId) continue;
      if (sinceMs && Date.parse(r.ts) < sinceMs) continue;
      out.push(r);
    } catch {
      // skip malformed line
    }
  }

  if (opts.limit && out.length > opts.limit) {
    return out.slice(-opts.limit);
  }
  return out;
}

/**
 * Stats helper — computes percentiles + simple change indicator on an
 * array of latency ms values. Used by the latency_trend tool.
 */
export function computeStats(values: number[]): {
  n: number;
  min?: number;
  p50?: number;
  p95?: number;
  p99?: number;
  max?: number;
  mean?: number;
} {
  if (values.length === 0) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p: number) => {
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
  };
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted[0],
    p50: pick(50),
    p95: pick(95),
    p99: pick(99),
    max: sorted[sorted.length - 1],
    mean: Math.round((sum / sorted.length) * 10) / 10,
  };
}

/**
 * Build a tiny inline sparkline from the most recent N points using Unicode
 * block chars. Returns "" for empty input.
 */
export function sparkline(values: number[], width = 24): string {
  if (values.length === 0) return "";
  const recent = values.slice(-width);
  const min = Math.min(...recent);
  const max = Math.max(...recent);
  const span = max - min || 1;
  const chars = "▁▂▃▄▅▆▇█";
  return recent
    .map((v) => chars[Math.min(chars.length - 1, Math.floor(((v - min) / span) * (chars.length - 1)))])
    .join("");
}
