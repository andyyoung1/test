/**
 * UniFi Protect Integration API client.
 *
 * Base URL: https://{console}/proxy/protect/integration/v1/
 * Auth: X-API-KEY (same key as Network Integration — generated together on the UDM
 *       at Settings → Control Plane → Integrations).
 *
 * Two response modes:
 *   - JSON: cameras, events, NVR info
 *   - Binary: snapshots (JPEG)
 */

import { Agent, fetch as undiciFetch } from "undici";

const PROTECT_PATH = "/proxy/protect/integration/v1";
const DEFAULT_TIMEOUT_MS = 8_000;
// Snapshots can take longer to generate, particularly on dual-camera devices
const SNAPSHOT_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;

export class UnifiProtectAPIError extends Error {
  readonly transport = "protect" as const;
  readonly hostId?: string;
  readonly status?: number;
  constructor(message: string, opts: { hostId?: string; status?: number } = {}) {
    super(message);
    this.name = "UnifiProtectAPIError";
    this.hostId = opts.hostId;
    this.status = opts.status;
  }
}

export interface ProtectNvr {
  id?: string;
  name?: string;
  host?: string;
  version?: string;
  firmwareVersion?: string;
  hardwarePlatform?: string;
  hardwareRevision?: string;
  timezone?: string;
  storageInfo?: {
    totalSize?: number;
    totalSpaceUsed?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface ProtectCamera {
  id: string;
  name?: string;
  modelKey?: string;
  type?: string;
  mac?: string;
  host?: string;
  state?: string;
  isConnected?: boolean;
  isRecording?: boolean;
  isMotionDetected?: boolean;
  recordingSettings?: {
    mode?: string;
    [k: string]: unknown;
  };
  smartDetectSettings?: {
    objectTypes?: string[];
    [k: string]: unknown;
  };
  featureFlags?: {
    hasPackageCamera?: boolean;
    [k: string]: unknown;
  };
  lastMotion?: number; // unix ms
  lastSeen?: number;
  upSince?: number;
  [k: string]: unknown;
}

export interface ProtectEvent {
  id: string;
  type?: string;        // motion, smartDetectZone, ring, smartDetectLine, ...
  start?: number;       // unix ms
  end?: number;
  camera?: string;
  smartDetectTypes?: string[];
  score?: number;
  metadata?: unknown;
  [k: string]: unknown;
}

interface Page<T> {
  data?: T[];
  // Protect uses cursor-style pagination on some endpoints, page-style on others
  offset?: number;
  limit?: number;
  count?: number;
  totalCount?: number;
  next?: string;
}

export interface SnapshotResult {
  /** raw JPEG bytes */
  buffer: Buffer;
  mimeType: string;
  bytes: number;
}

export class UnifiProtectClient {
  readonly hostId: string;
  readonly name: string;
  private baseUrl: string;
  private apiKey: string;
  private dispatcher: Agent;
  private timeoutMs: number;

  constructor(opts: {
    hostId: string;
    name?: string;
    url: string;
    apiKey: string;
    allowSelfSigned?: boolean;
    timeoutMs?: number;
  }) {
    if (!opts.hostId) throw new UnifiProtectAPIError("hostId required");
    if (!opts.url) throw new UnifiProtectAPIError("url required", { hostId: opts.hostId });
    if (!opts.apiKey)
      throw new UnifiProtectAPIError("apiKey required", { hostId: opts.hostId });

    this.hostId = opts.hostId;
    this.name = opts.name ?? opts.hostId;
    this.baseUrl = normalizeBaseUrl(opts.url);
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    this.dispatcher = new Agent({
      connect: { rejectUnauthorized: opts.allowSelfSigned === false },
      keepAliveTimeout: 5 * 60 * 1000,
      keepAliveMaxTimeout: 10 * 60 * 1000,
      pipelining: 1,
    });
  }

  private buildUrl(path: string, query?: Record<string, string>): URL {
    const url = new URL(this.baseUrl + PROTECT_PATH + path);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url;
  }

  private async getJSON<T>(
    path: string,
    query?: Record<string, string>,
  ): Promise<T> {
    const url = this.buildUrl(path, query);
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const resp = await undiciFetch(url, {
          method: "GET",
          headers: { "X-API-KEY": this.apiKey, Accept: "application/json" },
          dispatcher: this.dispatcher,
          signal: ctrl.signal,
        });
        if (resp.status === 429) {
          const wait = Number(resp.headers.get("Retry-After") ?? "1");
          await sleep(Math.min(Math.max(wait, 1), 10) * 1000);
          continue;
        }
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          if (resp.status >= 400 && resp.status < 500) {
            throw new UnifiProtectAPIError(
              `${resp.status} from ${path} on ${this.name}: ${body.slice(0, 200)}`,
              { hostId: this.hostId, status: resp.status },
            );
          }
          lastErr = new Error(`${resp.status} ${resp.statusText}`);
        } else {
          return (await resp.json()) as T;
        }
      } catch (err) {
        if (err instanceof UnifiProtectAPIError) throw err;
        lastErr = err;
      } finally {
        clearTimeout(t);
      }
      if (attempt < MAX_RETRIES - 1) await sleep(500 * (attempt + 1));
    }
    throw new UnifiProtectAPIError(
      `GET ${path} on ${this.name} failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      { hostId: this.hostId },
    );
  }

  /** Reachability probe — doesn't throw. */
  async ping(): Promise<{ ok: boolean; error?: string; latencyMs?: number }> {
    const start = Date.now();
    try {
      // /meta/info is the cheapest endpoint that proves the Protect surface is up;
      // fall back to /cameras if not present on the user's UniFi OS version.
      try {
        await this.getJSON("/meta/info");
      } catch (e) {
        if (
          e instanceof UnifiProtectAPIError &&
          e.status &&
          e.status >= 400 &&
          e.status < 500 &&
          e.status !== 401 &&
          e.status !== 403
        ) {
          await this.getJSON("/cameras", { limit: "1" });
        } else {
          throw e;
        }
      }
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getNvrInfo(): Promise<ProtectNvr> {
    return await this.getJSON<ProtectNvr>("/nvrs").then((r: ProtectNvr | { data?: ProtectNvr[] }) => {
      // Some firmwares return a single object, some wrap in {data:[...]}
      if (Array.isArray((r as { data?: ProtectNvr[] }).data)) {
        const list = (r as { data: ProtectNvr[] }).data;
        return list[0] ?? {};
      }
      return r as ProtectNvr;
    });
  }

  async listCameras(): Promise<ProtectCamera[]> {
    return await this.paginate<ProtectCamera>("/cameras");
  }

  async getCamera(cameraId: string): Promise<ProtectCamera> {
    return await this.getJSON<ProtectCamera>(`/cameras/${encodeURIComponent(cameraId)}`);
  }

  /**
   * Recent events across the system. Filters supported:
   *  - types: filter to specific event types (motion, smartDetectZone, ring, ...)
   *  - sinceMs: oldest event in ms unix; tool layer typically derives this from "last N hours"
   *  - cameraId: scope to one camera
   */
  async listEvents(opts: {
    types?: string[];
    sinceMs?: number;
    untilMs?: number;
    cameraId?: string;
    limit?: number;
  } = {}): Promise<ProtectEvent[]> {
    const query: Record<string, string> = {};
    if (opts.types?.length) query.types = opts.types.join(",");
    if (opts.sinceMs !== undefined) query.start = String(opts.sinceMs);
    if (opts.untilMs !== undefined) query.end = String(opts.untilMs);
    if (opts.cameraId) query.camera = opts.cameraId;
    query.limit = String(opts.limit ?? 200);
    return await this.paginate<ProtectEvent>("/events", query);
  }

  async getSnapshot(opts: {
    cameraId: string;
    width?: number;
    height?: number;
    usePackageCamera?: boolean;
  }): Promise<SnapshotResult> {
    const path =
      `/cameras/${encodeURIComponent(opts.cameraId)}` +
      (opts.usePackageCamera ? "/package-snapshot" : "/snapshot");
    const query: Record<string, string> = {};
    if (opts.width) query.width = String(opts.width);
    if (opts.height) query.height = String(opts.height);

    const url = this.buildUrl(path, Object.keys(query).length ? query : undefined);

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), SNAPSHOT_TIMEOUT_MS);
    try {
      const resp = await undiciFetch(url, {
        method: "GET",
        headers: { "X-API-KEY": this.apiKey, Accept: "image/jpeg" },
        dispatcher: this.dispatcher,
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new UnifiProtectAPIError(
          `Snapshot ${opts.cameraId} on ${this.name}: ${resp.status} ${body.slice(0, 200)}`,
          { hostId: this.hostId, status: resp.status },
        );
      }
      const arr = new Uint8Array(await resp.arrayBuffer());
      const mimeType = resp.headers.get("content-type") ?? "image/jpeg";
      return { buffer: Buffer.from(arr), mimeType, bytes: arr.byteLength };
    } catch (err) {
      if (err instanceof UnifiProtectAPIError) throw err;
      throw new UnifiProtectAPIError(
        `Snapshot ${opts.cameraId} on ${this.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        { hostId: this.hostId },
      );
    } finally {
      clearTimeout(t);
    }
  }

  /** Handles both page-style and unwrapped-array endpoints. */
  private async paginate<T>(
    path: string,
    baseQuery: Record<string, string> = {},
    limit = 200,
  ): Promise<T[]> {
    const all: T[] = [];
    let offset = 0;
    for (let i = 0; i < 50; i++) {
      const query = { ...baseQuery, offset: String(offset), limit: String(limit) };
      const page = await this.getJSON<Page<T> | T[]>(path, query);

      // Array form
      if (Array.isArray(page)) {
        all.push(...page);
        if (page.length < limit) break;
        offset += page.length;
        continue;
      }

      // Page form
      const batch = page.data ?? [];
      all.push(...batch);
      const total = page.totalCount ?? page.count ?? all.length;
      offset += batch.length || limit;
      if (batch.length < limit || all.length >= total) break;
    }
    return all;
  }
}

function normalizeBaseUrl(url: string): string {
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  u = u.replace(/\/+$/, "");
  u = u.replace(/\/proxy\/protect\/integration(\/v\d+)?$/i, "");
  u = u.replace(/\/proxy\/network\/integration(\/v\d+)?$/i, "");
  return u;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
