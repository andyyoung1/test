/**
 * Local UniFi Network Integration API client.
 *
 * Base URL pattern: https://{console}/proxy/network/integration/v1/
 * Auth: X-API-KEY header (generated on each UDM: Settings → Control Plane → Integrations)
 *
 * UniFi OS ships a self-signed HTTPS cert by default, so this client opts in to
 * accepting self-signed certs PER-INSTANCE via a dispatcher — it never touches
 * the global TLS settings, which would compromise all other HTTPS in the process.
 */

import { Agent, fetch as undiciFetch } from "undici";

const INTEGRATION_PATH = "/proxy/network/integration/v1";
const DEFAULT_TIMEOUT_MS = 5_000; // short — local consoles should respond fast or be marked unreachable
const MAX_RETRIES = 2;

export class UnifiLocalAPIError extends Error {
  readonly transport = "local" as const;
  readonly hostId?: string;
  readonly status?: number;
  constructor(message: string, opts: { hostId?: string; status?: number } = {}) {
    super(message);
    this.name = "UnifiLocalAPIError";
    this.hostId = opts.hostId;
    this.status = opts.status;
  }
}

export interface LocalSite {
  id: string;
  internalReference?: string;
  name?: string;
  [k: string]: unknown;
}

/**
 * Rich type for a device as returned by the Network Integration API.
 * Fields below are the ones we've observed populated on UniFi OS 5.x / Network 10.3.
 * Most are optional because different device types (gateway, switch, AP, accessory)
 * surface different subsets.
 */
export interface LocalDevice {
  id: string;
  name?: string;
  model?: string;
  macAddress?: string;
  ipAddress?: string;
  state?: string; // ONLINE | OFFLINE | UPDATING | ADOPTING | ...
  firmwareVersion?: string;
  /** Object — keys vary by device. switching/routing/firewallSecurity/accessPoint subobjects, etc. */
  features?: Record<string, unknown>;
  /** Array of interfaces — ports for switches, radios for APs */
  interfaces?: unknown[] | Record<string, unknown>;
  /** Object describing how this device is uplinked to its parent (or undefined for gateways) */
  uplink?: Record<string, unknown>;
  adoptedAt?: string;
  startupAt?: string;
  [k: string]: unknown;
}

export interface LocalClient {
  id: string;
  name?: string;
  hostname?: string;
  macAddress?: string;
  ipAddress?: string;
  /** WIRED | WIRELESS */
  type?: string;
  /** ID of the AP/switch this client is connected to */
  uplinkDeviceId?: string;
  connectedAt?: string;
  /** For wireless: signal strength in dBm (typically -30 great … -80 poor) */
  signalStrength?: number;
  /** For wireless: SSID name and access info */
  access?: { ssidName?: string; [k: string]: unknown };
  /** Per-direction radio fields nested under `wireless` on some firmwares */
  wireless?: Record<string, unknown>;
  /** Per-direction throughput / link rate, when reported */
  txRate?: number;
  rxRate?: number;
  [k: string]: unknown;
}

export interface NetworkApplicationInfo {
  applicationVersion?: string;
  [k: string]: unknown;
}

interface Page<T> {
  data?: T[];
  offset?: number;
  limit?: number;
  count?: number;
  totalCount?: number;
}

export class UnifiLocalClient {
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
    if (!opts.hostId) throw new UnifiLocalAPIError("hostId required");
    if (!opts.url) throw new UnifiLocalAPIError("url required", { hostId: opts.hostId });
    if (!opts.apiKey) throw new UnifiLocalAPIError("apiKey required", { hostId: opts.hostId });

    this.hostId = opts.hostId;
    this.name = opts.name ?? opts.hostId;
    this.baseUrl = normalizeBaseUrl(opts.url);
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Per-instance dispatcher so self-signed-cert acceptance is scoped to
    // requests we explicitly make through this client. Keep-alive holds the
    // connection open across tool calls — eliminates TLS handshake cost on
    // warm calls, dropping local-call latency from ~300ms cold to ~10-40ms warm.
    this.dispatcher = new Agent({
      connect: {
        rejectUnauthorized: opts.allowSelfSigned === false,
      },
      keepAliveTimeout: 5 * 60 * 1000,
      keepAliveMaxTimeout: 10 * 60 * 1000,
      pipelining: 1,
    });
  }

  private async getJSON<T>(path: string, query?: Record<string, string>): Promise<T> {
    const url = new URL(this.baseUrl + INTEGRATION_PATH + path);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const resp = await undiciFetch(url, {
          method: "GET",
          headers: {
            "X-API-KEY": this.apiKey,
            Accept: "application/json",
          },
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
            throw new UnifiLocalAPIError(
              `${resp.status} from ${path} on ${this.name}: ${body.slice(0, 200)}`,
              { hostId: this.hostId, status: resp.status },
            );
          }
          lastErr = new Error(`${resp.status} ${resp.statusText}`);
        } else {
          return (await resp.json()) as T;
        }
      } catch (err) {
        if (err instanceof UnifiLocalAPIError) throw err;
        lastErr = err;
      } finally {
        clearTimeout(t);
      }
      if (attempt < MAX_RETRIES - 1) await sleep(500 * (attempt + 1));
    }
    throw new UnifiLocalAPIError(
      `GET ${path} on ${this.name} failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      { hostId: this.hostId },
    );
  }

  /** Probe reachability without throwing — for transport_status. */
  async ping(): Promise<{ ok: boolean; error?: string; latencyMs?: number }> {
    const start = Date.now();
    try {
      // /sites is the cheapest endpoint that proves auth works
      await this.getJSON("/sites", { limit: "1" });
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listSites(): Promise<LocalSite[]> {
    return await this.paginate<LocalSite>("/sites");
  }

  async listDevices(siteId: string): Promise<LocalDevice[]> {
    return await this.paginate<LocalDevice>(`/sites/${encodeURIComponent(siteId)}/devices`);
  }

  async getDevice(siteId: string, deviceId: string): Promise<LocalDevice> {
    return await this.getJSON<LocalDevice>(
      `/sites/${encodeURIComponent(siteId)}/devices/${encodeURIComponent(deviceId)}`,
    );
  }

  /**
   * Per-device latest statistics — throughput, error counters, etc.
   * Endpoint exists on Network Integration API >= 9.x; we expose it but tools
   * should handle the 404 case gracefully on older firmwares.
   */
  async getDeviceStats(siteId: string, deviceId: string): Promise<Record<string, unknown>> {
    return await this.getJSON<Record<string, unknown>>(
      `/sites/${encodeURIComponent(siteId)}/devices/${encodeURIComponent(deviceId)}/statistics/latest`,
    );
  }

  async listClients(siteId: string): Promise<LocalClient[]> {
    return await this.paginate<LocalClient>(`/sites/${encodeURIComponent(siteId)}/clients`);
  }

  async getClient(siteId: string, clientId: string): Promise<LocalClient> {
    return await this.getJSON<LocalClient>(
      `/sites/${encodeURIComponent(siteId)}/clients/${encodeURIComponent(clientId)}`,
    );
  }

  async getInfo(): Promise<NetworkApplicationInfo> {
    return await this.getJSON<NetworkApplicationInfo>("/info");
  }

  /**
   * Diagnostic helper for `network_info` tool — probes whether a given endpoint
   * is implemented on this firmware. Returns the HTTP status (or 0 for network error)
   * without throwing. Cheap and read-only.
   */
  async probeEndpoint(path: string): Promise<{ status: number; sample?: unknown }> {
    const url = new URL(this.baseUrl + INTEGRATION_PATH + path);
    url.searchParams.set("limit", "1");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const resp = await undiciFetch(url, {
        method: "GET",
        headers: { "X-API-KEY": this.apiKey, Accept: "application/json" },
        dispatcher: this.dispatcher,
        signal: ctrl.signal,
      });
      let sample: unknown = undefined;
      if (resp.ok) {
        try {
          sample = await resp.json();
        } catch {
          /* ignore */
        }
      }
      return { status: resp.status, sample };
    } catch {
      return { status: 0 };
    } finally {
      clearTimeout(t);
    }
  }

  /** Walk the offset/limit pagination the Network Integration API uses. */
  private async paginate<T>(path: string, limit = 200): Promise<T[]> {
    const all: T[] = [];
    let offset = 0;
    // safety cap so a buggy server can't make us spin forever
    for (let i = 0; i < 100; i++) {
      const page = await this.getJSON<Page<T>>(path, {
        offset: String(offset),
        limit: String(limit),
      });
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
  // Strip trailing slash; strip accidental /proxy/... if user pasted it
  u = u.replace(/\/+$/, "");
  u = u.replace(/\/proxy\/network\/integration(\/v\d+)?$/i, "");
  return u;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
