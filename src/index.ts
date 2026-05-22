/**
 * UniFi Status MCP server v0.3 — cloud + local Network + local Protect.
 *
 * stdio transport. NEVER write to stdout — use console.error / stderr only,
 * or JSON-RPC framing breaks.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { UnifiAPIError, UnifiClient, type RawDevice } from "./cloud/client.js";
import {
  cameraStatusSummary,
  deviceSummary,
  isCamera,
  type DeviceSummary,
} from "./cloud/summarize.js";
import { UnifiLocalAPIError, type LocalDevice } from "./local/client.js";
import { summarizeSite } from "./local/summarize.js";
import { UnifiProtectAPIError } from "./protect/client.js";
import {
  appendRecords,
  computeStats,
  readRecords,
  sparkline,
  type LatencyRecord,
} from "./diagnostics/latency-log.js";
import {
  cameraDetail,
  cameraNameLookup,
  eventSummary,
  protectOverview,
} from "./protect/summarize.js";
import {
  loadRegistryFromEnv,
  safeConsoleSummary,
  type RegistryEntry,
} from "./registry.js";

const log = (msg: string, ...rest: unknown[]) => {
  console.error(`[unifi-status] ${msg}`, ...rest);
};

const server = new McpServer({ name: "unifi-status", version: "0.3.3" });

// ---- Startup ----
const { entries: localRegistry, errors: registryErrors } = loadRegistryFromEnv();
for (const err of registryErrors) log("config error:", err);
log(
  `started. cloud: required. local consoles: ${localRegistry.size}` +
    (registryErrors.length ? ` (${registryErrors.length} config error(s))` : ""),
);

// ---- Helpers ----
// Singleton cloud client — must be a single instance so the undici Agent's
// keep-alive pool persists across tool calls. Creating a fresh client per call
// would discard the connection pool every time and defeat the optimization.
let _cloudClient: UnifiClient | undefined;
function cloudClient(): UnifiClient {
  if (!_cloudClient) _cloudClient = new UnifiClient();
  return _cloudClient;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function toolError(label: string, err: unknown) {
  const msg =
    err instanceof UnifiAPIError ||
    err instanceof UnifiLocalAPIError ||
    err instanceof UnifiProtectAPIError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  log(`${label} failed:`, msg);
  return {
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
    isError: true as const,
  };
}

function resolveHostId(input: string): string | undefined {
  if (localRegistry.has(input)) return input;
  const matches: string[] = [];
  for (const id of localRegistry.keys()) {
    if (id.startsWith(input) || id.includes(input)) matches.push(id);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function pickEntry(hostIdInput: string | undefined):
  | { ok: true; entry: RegistryEntry }
  | { ok: false; message: string } {
  if (hostIdInput) {
    const id = resolveHostId(hostIdInput);
    if (!id) {
      return {
        ok: false,
        message: localRegistry.size
          ? `No local console matches "${hostIdInput}". Configured: ${[...localRegistry.values()]
              .map((e) => `${e.config.name ?? e.config.hostId} (${e.config.hostId.slice(0, 8)}…)`)
              .join(", ")}`
          : `No local consoles configured.`,
      };
    }
    return { ok: true, entry: localRegistry.get(id)! };
  }
  if (localRegistry.size === 0) {
    return {
      ok: false,
      message:
        'No local consoles configured. Add them via the extension\'s "Local consoles" setting.',
    };
  }
  if (localRegistry.size === 1) {
    return { ok: true, entry: [...localRegistry.values()][0] };
  }
  return {
    ok: false,
    message: `Multiple local consoles configured (${localRegistry.size}). Specify host_id. Configured: ${[
      ...localRegistry.values(),
    ]
      .map((e) => `${e.config.name ?? e.config.hostId} (${e.config.hostId.slice(0, 8)}…)`)
      .join(", ")}`,
  };
}

// ============== CLOUD tools (unchanged from v0.2) ==============

server.registerTool(
  "list_hosts",
  {
    title: "List UniFi Hosts",
    description: "List all UniFi consoles on the account (cloud).",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await cloudClient().listHosts());
    } catch (err) {
      return toolError("list_hosts", err);
    }
  },
);

server.registerTool(
  "list_sites",
  {
    title: "List UniFi Sites",
    description: "List all UniFi sites across all hosts (cloud).",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await cloudClient().listSites());
    } catch (err) {
      return toolError("list_sites", err);
    }
  },
);

server.registerTool(
  "list_devices",
  {
    title: "List UniFi Devices",
    description: "List devices across hosts. Optional filters: host_ids, cameras_only.",
    inputSchema: {
      host_ids: z.array(z.string()).optional(),
      cameras_only: z.boolean().optional(),
    },
  },
  async ({ host_ids, cameras_only }) => {
    try {
      const raw: RawDevice[] = await cloudClient().listDevices(host_ids);
      const filtered = cameras_only ? raw.filter(isCamera) : raw;
      const summaries: DeviceSummary[] = filtered.map(deviceSummary);
      return ok({ transport: "cloud", count: summaries.length, devices: summaries });
    } catch (err) {
      return toolError("list_devices", err);
    }
  },
);

server.registerTool(
  "camera_status",
  {
    title: "Camera Status Summary",
    description: "Aggregate camera status — totals, offline list, pending firmware updates (cloud).",
    inputSchema: { host_ids: z.array(z.string()).optional() },
  },
  async ({ host_ids }) => {
    try {
      const raw = await cloudClient().listDevices(host_ids);
      return ok({ transport: "cloud", ...cameraStatusSummary(raw) });
    } catch (err) {
      return toolError("camera_status", err);
    }
  },
);

// ============== LOCAL NETWORK tools (v0.2 + v0.3.1) ==============

server.registerTool(
  "network_status",
  {
    title: "Network Status (local)",
    description:
      "Rich network status from local Network Integration API: sites, device roles " +
      "(now correctly classified for UniFi OS 5.x firmwares), online/offline split, " +
      "AP/switch/gateway/camera/accessory counts, wired vs wireless client counts, " +
      "wireless signal-strength distribution, and clients-per-AP breakdown.",
    inputSchema: { host_id: z.string().optional() },
  },
  async ({ host_id }) => {
    try {
      const sel = pickEntry(host_id);
      if (!sel.ok) return toolError("network_status", new Error(sel.message));
      const client = sel.entry.network;

      const sites = await client.listSites();
      const sitesOut = await Promise.all(
        sites.map(async (s) => {
          const [devices, clients] = await Promise.all([
            client.listDevices(s.id).catch((e: unknown) => {
              log(`devices fetch failed for site ${s.id}:`, e);
              return [] as LocalDevice[];
            }),
            client.listClients(s.id).catch((e: unknown) => {
              log(`clients fetch failed for site ${s.id}:`, e);
              return [];
            }),
          ]);
          return summarizeSite(s, devices, clients);
        }),
      );

      return ok({
        transport: "local-network",
        console: safeConsoleSummary(sel.entry),
        sites: sitesOut,
      });
    } catch (err) {
      return toolError("network_status", err);
    }
  },
);

server.registerTool(
  "network_info",
  {
    title: "Network Controller Info & Capability Probe",
    description:
      "Returns the local Network Controller version plus a probe of which Integration API " +
      "endpoints are actually available on this firmware. Useful for diagnosing 'why does X tool " +
      "return no data' — if an endpoint returns 404 here, the firmware doesn't expose it yet.",
    inputSchema: { host_id: z.string().optional() },
  },
  async ({ host_id }) => {
    try {
      const sel = pickEntry(host_id);
      if (!sel.ok) return toolError("network_info", new Error(sel.message));
      const client = sel.entry.network;

      const info = await client.getInfo().catch((e: unknown) => ({
        error: e instanceof Error ? e.message : String(e),
      }));

      // Probe each interesting endpoint to see what works on this firmware
      const sites = await client.listSites().catch(() => []);
      const firstSiteId = sites[0]?.id;

      const probes: Record<string, { status: number; ok: boolean }> = {};
      const endpointsToProbe = [
        "/info",
        "/sites",
        firstSiteId ? `/sites/${firstSiteId}/devices` : null,
        firstSiteId ? `/sites/${firstSiteId}/clients` : null,
      ].filter((x): x is string => x !== null);

      for (const path of endpointsToProbe) {
        const r = await client.probeEndpoint(path);
        probes[path] = { status: r.status, ok: r.status >= 200 && r.status < 300 };
      }

      return ok({
        transport: "local-network",
        console: safeConsoleSummary(sel.entry),
        info,
        endpointProbes: probes,
      });
    } catch (err) {
      return toolError("network_info", err);
    }
  },
);

server.registerTool(
  "device_detail",
  {
    title: "Network Device Detail",
    description:
      "Full per-device JSON from the Network Integration API — radios for APs, port state for switches, " +
      "WAN config for gateways. Plus an attempt at latest device statistics (throughput, errors) — those " +
      "may 404 on firmwares that haven't shipped that endpoint yet.",
    inputSchema: {
      device_id: z
        .string()
        .describe(
          "Device ID — get from `network_status` results or `list_devices`. For UniFi devices this is typically the MAC without separators.",
        ),
      site_id: z
        .string()
        .optional()
        .describe("Optional site ID. If omitted, uses the first site on the console."),
      host_id: z.string().optional(),
    },
  },
  async ({ device_id, site_id, host_id }) => {
    try {
      const sel = pickEntry(host_id);
      if (!sel.ok) return toolError("device_detail", new Error(sel.message));
      const client = sel.entry.network;

      let resolvedSiteId = site_id;
      if (!resolvedSiteId) {
        const sites = await client.listSites();
        resolvedSiteId = sites[0]?.id;
        if (!resolvedSiteId)
          return toolError("device_detail", new Error("No sites available on this console."));
      }

      const device = await client.getDevice(resolvedSiteId, device_id);
      const stats = await client
        .getDeviceStats(resolvedSiteId, device_id)
        .catch((e: unknown) => ({
          unavailable: true,
          reason: e instanceof Error ? e.message : String(e),
        }));

      return ok({
        transport: "local-network",
        console: safeConsoleSummary(sel.entry),
        siteId: resolvedSiteId,
        device,
        statistics: stats,
      });
    } catch (err) {
      return toolError("device_detail", err);
    }
  },
);

server.registerTool(
  "client_detail",
  {
    title: "Network Clients (detail)",
    description:
      "Per-client list with the rich fields the local API exposes: signal strength (wireless), " +
      "AP uplink, link rate, IP, hostname. Returns clients ranked by signal strength (weakest first) " +
      "for wireless clients — fast way to spot 'this device is at -78 dBm and 6 Mbps, time to move it'. " +
      "Use `wireless_only` to filter, or `weak_only` to return just clients at -70 dBm or worse.",
    inputSchema: {
      host_id: z.string().optional(),
      site_id: z
        .string()
        .optional()
        .describe("Optional site ID. If omitted, uses the first site on the console."),
      wireless_only: z.boolean().optional(),
      weak_only: z
        .boolean()
        .optional()
        .describe("Return only wireless clients at -70 dBm or worse (fair/poor signal)."),
      limit: z.number().min(1).max(500).default(100),
    },
  },
  async ({ host_id, site_id, wireless_only, weak_only, limit }) => {
    try {
      const sel = pickEntry(host_id);
      if (!sel.ok) return toolError("client_detail", new Error(sel.message));
      const client = sel.entry.network;

      let resolvedSiteId = site_id;
      if (!resolvedSiteId) {
        const sites = await client.listSites();
        resolvedSiteId = sites[0]?.id;
        if (!resolvedSiteId)
          return toolError("client_detail", new Error("No sites available on this console."));
      }

      const [clients, devices] = await Promise.all([
        client.listClients(resolvedSiteId),
        client.listDevices(resolvedSiteId).catch(() => []),
      ]);

      // Build a uplinkDeviceId → device name lookup so callers see "G6 Pro Dome" not the MAC
      const deviceNameById = new Map<string, string | undefined>();
      for (const d of devices) deviceNameById.set(d.id, d.name);

      let filtered = clients;
      if (wireless_only || weak_only) {
        filtered = filtered.filter((c) => (c.type ?? "").toUpperCase() === "WIRELESS");
      }
      if (weak_only) {
        filtered = filtered.filter(
          (c) => typeof c.signalStrength === "number" && c.signalStrength <= -70,
        );
      }

      // Sort: wireless first, weakest signal first within wireless; wired after, by IP
      filtered.sort((a, b) => {
        const aw = (a.type ?? "").toUpperCase() === "WIRELESS";
        const bw = (b.type ?? "").toUpperCase() === "WIRELESS";
        if (aw && !bw) return -1;
        if (bw && !aw) return 1;
        if (aw && bw) {
          const as = a.signalStrength ?? 0;
          const bs = b.signalStrength ?? 0;
          return as - bs; // most-negative (weakest) first
        }
        return (a.ipAddress ?? "").localeCompare(b.ipAddress ?? "");
      });

      const out = filtered.slice(0, limit).map((c) => ({
        id: c.id,
        name: c.name ?? c.hostname,
        ip: c.ipAddress,
        mac: c.macAddress,
        type: c.type,
        signalStrength: c.signalStrength,
        ssid: c.access?.ssidName,
        uplinkDevice: c.uplinkDeviceId
          ? {
              id: c.uplinkDeviceId,
              name: deviceNameById.get(c.uplinkDeviceId),
            }
          : undefined,
        connectedAt: c.connectedAt,
        txRate: c.txRate,
        rxRate: c.rxRate,
      }));

      return ok({
        transport: "local-network",
        console: safeConsoleSummary(sel.entry),
        siteId: resolvedSiteId,
        totalClients: clients.length,
        returnedCount: out.length,
        filters: { wireless_only: !!wireless_only, weak_only: !!weak_only },
        clients: out,
      });
    } catch (err) {
      return toolError("client_detail", err);
    }
  },
);

// ============== PROTECT tools (NEW in v0.3) ==============

server.registerTool(
  "protect_overview",
  {
    title: "UniFi Protect Overview",
    description:
      "NVR + camera fleet summary from the local Protect Integration API: NVR version & storage, " +
      "per-camera recording mode, smart-detect config, last motion, package-camera capability, " +
      "and a count of cameras with motion in the last 24h. Best single tool for 'how's Protect doing'.",
    inputSchema: { host_id: z.string().optional() },
  },
  async ({ host_id }) => {
    try {
      const sel = pickEntry(host_id);
      if (!sel.ok) return toolError("protect_overview", new Error(sel.message));
      const p = sel.entry.protect;
      const [nvr, cameras] = await Promise.all([
        p.getNvrInfo().catch(() => ({})),
        p.listCameras(),
      ]);
      return ok({
        transport: "local-protect",
        console: safeConsoleSummary(sel.entry),
        ...protectOverview(nvr, cameras),
      });
    } catch (err) {
      return toolError("protect_overview", err);
    }
  },
);

server.registerTool(
  "protect_cameras",
  {
    title: "Protect Cameras (detail)",
    description:
      "Per-camera detail from Protect: recording mode, smart-detect types enabled, last motion " +
      "timestamp, connection state, and whether the device has a package camera (dual-lens).",
    inputSchema: {
      host_id: z.string().optional(),
      camera_id: z.string().optional().describe("Optional: restrict to one camera."),
    },
  },
  async ({ host_id, camera_id }) => {
    try {
      const sel = pickEntry(host_id);
      if (!sel.ok) return toolError("protect_cameras", new Error(sel.message));
      const p = sel.entry.protect;
      if (camera_id) {
        const cam = await p.getCamera(camera_id);
        return ok({
          transport: "local-protect",
          console: safeConsoleSummary(sel.entry),
          camera: cameraDetail(cam),
        });
      }
      const cams = await p.listCameras();
      return ok({
        transport: "local-protect",
        console: safeConsoleSummary(sel.entry),
        count: cams.length,
        cameras: cams.map(cameraDetail),
      });
    } catch (err) {
      return toolError("protect_cameras", err);
    }
  },
);

server.registerTool(
  "recent_motion_events",
  {
    title: "Recent Motion Events",
    description:
      "Recent motion events from Protect. Returns events sorted newest-first with camera names " +
      "resolved (not just IDs). Use this for questions like 'what's triggered today' or " +
      "'has the doorbell seen anything in the last hour'.",
    inputSchema: {
      host_id: z.string().optional(),
      hours: z
        .number()
        .min(0.1)
        .max(168)
        .default(24)
        .describe("Look-back window in hours. Default 24, max 168 (one week)."),
      camera_id: z.string().optional().describe("Optional: scope to one camera."),
      limit: z.number().min(1).max(500).default(100),
    },
  },
  async ({ host_id, hours, camera_id, limit }) => {
    try {
      const sel = pickEntry(host_id);
      if (!sel.ok) return toolError("recent_motion_events", new Error(sel.message));
      const p = sel.entry.protect;
      const sinceMs = Date.now() - hours * 60 * 60 * 1000;

      const [events, cameras] = await Promise.all([
        p.listEvents({ types: ["motion"], sinceMs, cameraId: camera_id, limit }),
        p.listCameras().catch(() => []),
      ]);
      const names = cameraNameLookup(cameras);
      const sorted = events
        .slice()
        .sort((a, b) => (b.start ?? 0) - (a.start ?? 0))
        .slice(0, limit);

      return ok({
        transport: "local-protect",
        console: safeConsoleSummary(sel.entry),
        windowHours: hours,
        count: sorted.length,
        events: sorted.map((e) => eventSummary(e, names)),
      });
    } catch (err) {
      return toolError("recent_motion_events", err);
    }
  },
);

server.registerTool(
  "recent_smart_detects",
  {
    title: "Recent Smart-Detect Events",
    description:
      "Recent smart-detect events from Protect (person, vehicle, package, animal, license plate). " +
      "Returns events sorted newest-first with smart-detect types and camera names. Use for questions " +
      "like 'did anyone show up today' or 'any packages delivered'.",
    inputSchema: {
      host_id: z.string().optional(),
      hours: z.number().min(0.1).max(168).default(24),
      types: z
        .array(z.string())
        .optional()
        .describe(
          'Filter to specific smart-detect types: "person", "vehicle", "package", "animal", "licensePlate".',
        ),
      camera_id: z.string().optional(),
      limit: z.number().min(1).max(500).default(100),
    },
  },
  async ({ host_id, hours, types, camera_id, limit }) => {
    try {
      const sel = pickEntry(host_id);
      if (!sel.ok) return toolError("recent_smart_detects", new Error(sel.message));
      const p = sel.entry.protect;
      const sinceMs = Date.now() - hours * 60 * 60 * 1000;

      const [events, cameras] = await Promise.all([
        p.listEvents({
          types: ["smartDetectZone", "smartDetectLine"],
          sinceMs,
          cameraId: camera_id,
          limit,
        }),
        p.listCameras().catch(() => []),
      ]);
      const names = cameraNameLookup(cameras);

      const filtered = types?.length
        ? events.filter((e) =>
            e.smartDetectTypes?.some((t) =>
              types.map((x) => x.toLowerCase()).includes(t.toLowerCase()),
            ),
          )
        : events;

      const sorted = filtered
        .slice()
        .sort((a, b) => (b.start ?? 0) - (a.start ?? 0))
        .slice(0, limit);

      return ok({
        transport: "local-protect",
        console: safeConsoleSummary(sel.entry),
        windowHours: hours,
        typesFilter: types,
        count: sorted.length,
        events: sorted.map((e) => eventSummary(e, names)),
      });
    } catch (err) {
      return toolError("recent_smart_detects", err);
    }
  },
);

server.registerTool(
  "camera_snapshot",
  {
    title: "Camera Snapshot",
    description:
      "Capture a current snapshot from a Protect camera. Returns the image inline plus metadata. " +
      "Defaults to thumbnail size (640x360) for fast results; pass full_resolution=true for the " +
      "camera's full-resolution image. For dual-camera devices (G4 Doorbell Pro etc.), set " +
      "use_package_camera=true to capture from the secondary lens.",
    inputSchema: {
      camera_id: z.string().describe("Protect camera ID. Get from `protect_cameras`."),
      host_id: z.string().optional(),
      full_resolution: z
        .boolean()
        .optional()
        .describe("Default false (640x360 thumbnail). Set true for the camera's native resolution."),
      use_package_camera: z
        .boolean()
        .optional()
        .describe("For dual-lens devices, capture from the package (secondary) camera."),
    },
  },
  async ({ camera_id, host_id, full_resolution, use_package_camera }) => {
    try {
      const sel = pickEntry(host_id);
      if (!sel.ok) return toolError("camera_snapshot", new Error(sel.message));
      const p = sel.entry.protect;

      const dims = full_resolution
        ? {}
        : { width: 640, height: 360 };

      const snap = await p.getSnapshot({
        cameraId: camera_id,
        usePackageCamera: use_package_camera,
        ...dims,
      });

      // Resolve camera name for the caption (best-effort, don't fail snapshot if this fails)
      let cameraName: string | undefined;
      try {
        const cam = await p.getCamera(camera_id);
        cameraName = cam.name;
      } catch {
        /* ignore */
      }

      const caption =
        `Snapshot from ${cameraName ?? camera_id}` +
        (use_package_camera ? " (package camera)" : "") +
        ` at ${new Date().toISOString()}. ` +
        `${full_resolution ? "Full resolution" : "Thumbnail (640x360)"}, ` +
        `${(snap.bytes / 1024).toFixed(0)} KB.`;

      return {
        content: [
          { type: "text" as const, text: caption },
          {
            type: "image" as const,
            data: snap.buffer.toString("base64"),
            mimeType: snap.mimeType,
          },
        ],
      };
    } catch (err) {
      return toolError("camera_snapshot", err);
    }
  },
);

// ============== DIAGNOSTIC ==============

server.registerTool(
  "transport_status",
  {
    title: "Transport Status (diagnostic)",
    description:
      "Diagnostic: shows reachability of cloud + each console's Network and Protect APIs. " +
      "Useful when data seems missing — distinguishes 'console unreachable' from 'no local key' " +
      "from 'Protect not running on this console'.",
    inputSchema: {},
  },
  async () => {
    try {
      const records: LatencyRecord[] = [];
      const ts = new Date().toISOString();

      const cloudStart = Date.now();
      const cloudResult = await cloudClient()
        .listHosts()
        .then((hs) => {
          const latencyMs = Date.now() - cloudStart;
          records.push({
            ts, hostId: "_cloud", surface: "cloud", ok: true, latencyMs,
          });
          return { ok: true as const, hosts: hs.length, latencyMs };
        })
        .catch((e: unknown) => {
          const error = e instanceof Error ? e.message : String(e);
          records.push({
            ts, hostId: "_cloud", surface: "cloud", ok: false,
            error: error.slice(0, 200),
          });
          return { ok: false as const, error };
        });

      const localResults = await Promise.all(
        [...localRegistry.values()].map(async (entry) => {
          const [network, protect] = await Promise.all([
            entry.network.ping(),
            entry.protect.ping(),
          ]);
          records.push({
            ts, hostId: entry.config.hostId, name: entry.config.name,
            surface: "network", ok: network.ok,
            latencyMs: network.latencyMs,
            error: network.error?.slice(0, 200),
          });
          records.push({
            ts, hostId: entry.config.hostId, name: entry.config.name,
            surface: "protect", ok: protect.ok,
            latencyMs: protect.latencyMs,
            error: protect.error?.slice(0, 200),
          });
          return {
            ...safeConsoleSummary(entry),
            network,
            protect,
          };
        }),
      );

      // Fire-and-forget; never let log I/O break the tool call
      appendRecords(records).catch((e) => log("latency log append failed:", e));

      return ok({
        cloud: cloudResult,
        localConfigured: localRegistry.size,
        localConsoles: localResults,
        configErrors: registryErrors,
      });
    } catch (err) {
      return toolError("transport_status", err);
    }
  },
);

server.registerTool(
  "latency_trend",
  {
    title: "Latency Trend (diagnostic)",
    description:
      "Read historical transport_status latency measurements and report trends. Latencies are " +
      "appended to a local log every time `transport_status` is called. Useful for distinguishing " +
      "'normal variance' from 'something is genuinely slowing down' — single-point measurements " +
      "can't tell you that, but the trend can.",
    inputSchema: {
      hours: z.number().min(0.1).max(720).default(24)
        .describe("Look-back window in hours. Default 24, max 720 (30 days)."),
      surface: z.string().optional()
        .describe("Filter to one surface: 'cloud', 'network', or 'protect'. Omit for all."),
    },
  },
  async ({ hours, surface }) => {
    try {
      const sinceMs = Date.now() - hours * 60 * 60 * 1000;
      const since = new Date(sinceMs).toISOString();
      const all = await readRecords({ since, surface });

      if (all.length === 0) {
        return ok({
          windowHours: hours,
          surfaceFilter: surface,
          message:
            "No latency records in this window. Run `transport_status` a few times to build history, " +
            "then come back. Each call records one entry per probed surface.",
          recordCount: 0,
        });
      }

      // Group by surface
      const bySurface = new Map<string, LatencyRecord[]>();
      for (const r of all) {
        const arr = bySurface.get(r.surface) ?? [];
        arr.push(r);
        bySurface.set(r.surface, arr);
      }

      // Compute per-surface stats + recent-vs-prior delta
      const surfaces: Record<string, unknown> = {};
      for (const [name, records] of bySurface.entries()) {
        const oks = records.filter((r) => r.ok && r.latencyMs !== undefined);
        const failures = records.length - oks.length;
        const latencies = oks.map((r) => r.latencyMs as number);

        // Split into older half / newer half for trend direction
        const mid = Math.floor(latencies.length / 2);
        const olderHalf = latencies.slice(0, mid);
        const newerHalf = latencies.slice(mid);
        const olderStats = computeStats(olderHalf);
        const newerStats = computeStats(newerHalf);

        let trend: string;
        if (olderStats.p50 === undefined || newerStats.p50 === undefined) {
          trend = "insufficient-data";
        } else {
          const delta = newerStats.p50 - olderStats.p50;
          const pct = (delta / olderStats.p50) * 100;
          if (Math.abs(pct) < 15) trend = "stable";
          else if (pct > 0) trend = `degrading (newer p50 +${Math.round(pct)}%)`;
          else trend = `improving (newer p50 ${Math.round(pct)}%)`;
        }

        surfaces[name] = {
          probes: records.length,
          successful: oks.length,
          failed: failures,
          stats: computeStats(latencies),
          trend,
          sparkline: sparkline(latencies),
          oldestProbe: records[0]?.ts,
          newestProbe: records[records.length - 1]?.ts,
        };
      }

      return ok({
        windowHours: hours,
        surfaceFilter: surface,
        recordCount: all.length,
        surfaces,
        notes: [
          "Each call to `transport_status` adds one record per probed surface (cloud + network + protect).",
          "Sparkline shows the most recent ~24 points; height = relative latency in that window.",
          "Trend compares the newer half of the window vs the older half; <15% delta is 'stable'.",
        ],
      });
    } catch (err) {
      return toolError("latency_trend", err);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  log("fatal:", err);
  process.exit(1);
});
