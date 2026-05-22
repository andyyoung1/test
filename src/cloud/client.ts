/**
 * UniFi Site Manager API client.
 *
 * Wraps https://api.ui.com/v1/ — read-only, X-API-KEY auth.
 *
 * Uses undici directly (not Node's built-in fetch) so we can configure an
 * explicit keep-alive Agent. The connection is held open for up to 5 minutes
 * between calls, which eliminates the TCP+TLS handshake cost on warm calls.
 * Cold-call latency drops by 100-200ms once warm.
 */

import { Agent, fetch as undiciFetch } from "undici";

const API_BASE = "https://api.ui.com/v1";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const KEEPALIVE_MS = 5 * 60 * 1000;       // 5 minutes
const KEEPALIVE_MAX_TIMEOUT = 10 * 60 * 1000; // hard cap

export class UnifiAPIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnifiAPIError";
  }
}

export interface RawDevice {
  id?: string;
  name?: string;
  shortname?: string;
  model?: string;
  mac?: string;
  ip?: string;
  status?: string;
  isManaged?: boolean;
  productLine?: string;
  firmwareVersion?: string;
  firmwareStatus?: string;
  adoptionTime?: string;
  lastSeen?: string;
  startupTimestamp?: string;
  uptime?: number;
  /** Injected by the client when flattening the per-host response */
  _hostId?: string;
  _hostName?: string;
  [key: string]: unknown;
}

export interface Host {
  id?: string;
  reportedState?: { name?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface Site {
  siteId?: string;
  meta?: { name?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface PagedDevicesResponse {
  data?: Array<{
    hostId?: string;
    hostName?: string;
    devices?: RawDevice[];
  }>;
  nextToken?: string;
}

interface ListResponse<T> {
  data?: T[];
}

export class UnifiClient {
  private apiKey: string;
  private timeoutMs: number;
  private dispatcher: Agent;

  constructor(apiKey?: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    const key = apiKey ?? process.env.UNIFI_API_KEY;
    if (!key) {
      throw new UnifiAPIError(
        "UNIFI_API_KEY not set. Generate a key at unifi.ui.com → API and " +
          "configure it in the extension's settings.",
      );
    }
    this.apiKey = key;
    this.timeoutMs = timeoutMs;
    // Explicit keep-alive — undici defaults are short. We want connection reuse
    // across tool calls within a session, but not so long that connections
    // pile up if the server idles for hours.
    this.dispatcher = new Agent({
      keepAliveTimeout: KEEPALIVE_MS,
      keepAliveMaxTimeout: KEEPALIVE_MAX_TIMEOUT,
      pipelining: 1,
    });
  }

  private async getJSON<T>(
    path: string,
    params?: Record<string, string | string[]>,
  ): Promise<T> {
    const url = new URL(API_BASE + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (Array.isArray(v)) {
          for (const item of v) url.searchParams.append(k, item);
        } else {
          url.searchParams.set(k, v);
        }
      }
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const resp = await undiciFetch(url.toString(), {
          method: "GET",
          headers: {
            "X-API-KEY": this.apiKey,
            Accept: "application/json",
          },
          dispatcher: this.dispatcher,
          signal: controller.signal,
        });

        if (resp.status === 429) {
          const retryAfter = Number(resp.headers.get("Retry-After") ?? "1");
          const wait = Math.min(Math.max(retryAfter, 1), 30);
          await sleep(wait * 1000);
          continue;
        }

        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          // 4xx (except 429 above) won't get better with retries — bail.
          if (resp.status >= 400 && resp.status < 500) {
            throw new UnifiAPIError(
              `${resp.status} from ${path}: ${body.slice(0, 200)}`,
            );
          }
          lastErr = new Error(`${resp.status} ${resp.statusText}: ${body.slice(0, 200)}`);
        } else {
          return (await resp.json()) as T;
        }
      } catch (err) {
        if (err instanceof UnifiAPIError) throw err;
        lastErr = err;
      } finally {
        clearTimeout(timeout);
      }
      await sleep(2 ** attempt * 1000);
    }
    throw new UnifiAPIError(
      `GET ${path} failed after ${MAX_RETRIES} attempts: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    );
  }

  async listHosts(): Promise<Host[]> {
    const data = await this.getJSON<ListResponse<Host>>("/hosts");
    return data.data ?? [];
  }

  async listSites(): Promise<Site[]> {
    const data = await this.getJSON<ListResponse<Site>>("/sites");
    return data.data ?? [];
  }

  async listDevices(hostIds?: string[], pageSize = 100): Promise<RawDevice[]> {
    const all: RawDevice[] = [];
    let nextToken: string | undefined;

    do {
      const params: Record<string, string | string[]> = {
        pageSize: String(pageSize),
      };
      if (hostIds?.length) params["hostIds[]"] = hostIds;
      if (nextToken) params.nextToken = nextToken;

      const page = await this.getJSON<PagedDevicesResponse>("/devices", params);
      for (const entry of page.data ?? []) {
        for (const dev of entry.devices ?? []) {
          dev._hostId = entry.hostId;
          dev._hostName = entry.hostName;
          all.push(dev);
        }
      }
      nextToken = page.nextToken;
    } while (nextToken);

    return all;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
