/**
 * Network status summarization from local API data.
 *
 * Two design changes from v0.3:
 *
 * 1. Role classification is robust to multiple `features` shapes (UniFi OS 5.x
 *    Network 10.x returns an object with boolean-valued keys; earlier firmwares
 *    returned nested objects). Falls back to model-name pattern matching when
 *    features data is missing or empty, which is what we observed on the Urb.
 *
 * 2. Client summarization adds signal-strength binning (for wireless) and
 *    distribution by AP — surfaces real config findings like "12 clients on one AP".
 */

import type { LocalClient, LocalDevice, LocalSite } from "./client.js";

export type DeviceRole = "ap" | "switch" | "gateway" | "accessory" | "camera" | "other";

/**
 * Multi-strategy role classifier. Tries the official `features` object first,
 * then falls back to model-name patterns. Either approach can succeed on its
 * own — we want both so the data on this firmware works.
 */
export function classifyDevice(d: LocalDevice): DeviceRole {
  // Strategy 1: features object (preferred, official)
  const f = d.features as Record<string, unknown> | undefined;
  if (f && typeof f === "object") {
    if (truthy(f.accessPoint) || truthy(f.wifi) || truthy(f.radios)) return "ap";
    if (truthy(f.switching) || truthy(f.switch)) return "switch";
    if (truthy(f.routing) || truthy(f.firewallSecurity) || truthy(f.gateway)) return "gateway";
  }

  // Strategy 2: model-name patterns (robust fallback)
  const model = (d.model ?? "").toUpperCase();
  const name = (d.name ?? "").toUpperCase();
  const combo = `${model} ${name}`;

  if (/\bUDM|UCG|UXG|UDR|UDW|UGW|USG\b/.test(combo)) return "gateway";
  if (/\bUSW|US-\d|US24|US48|USL|USXG\b/.test(combo)) return "switch";
  if (/\bU6|U7|UAP|UALR|UHD|UAC\b/.test(combo)) return "ap";
  if (/\bUVC|G3|G4|G5|G6|DOORBELL|CAMERA\b/.test(combo)) return "camera";
  if (/\bUP CHIME|UP SENSE|USP|PDU|CHIME\b/.test(combo)) return "accessory";

  return "other";
}

function truthy(v: unknown): boolean {
  // Handles both `true` and non-empty nested object forms
  if (v === true) return true;
  if (v && typeof v === "object") return Object.keys(v as object).length > 0;
  return false;
}

// ---- Signal-strength bands for wireless clients ----
export type SignalBand = "excellent" | "good" | "fair" | "poor" | "unknown";
export function signalBand(dbm: number | undefined): SignalBand {
  if (dbm === undefined || dbm === null || isNaN(dbm)) return "unknown";
  if (dbm >= -50) return "excellent";
  if (dbm >= -60) return "good";
  if (dbm >= -70) return "fair";
  return "poor";
}

// ---- Public types ----

export interface SiteSummary {
  siteId: string;
  siteName: string;
  totals: {
    devices: number;
    online: number;
    offline: number;
    other: number;
    accessPoints: number;
    switches: number;
    gateways: number;
    cameras: number;
    accessories: number;
    clients: number;
    wiredClients: number;
    wirelessClients: number;
  };
  offlineDevices: Array<{
    id: string;
    name?: string;
    model?: string;
    ip?: string;
    state?: string;
  }>;
  /** Wireless client distribution by signal-strength band (config-quality signal) */
  wirelessSignal?: Record<SignalBand, number>;
  /** Clients per AP — points at over- or under-utilized APs */
  clientsByAp?: Array<{ apId: string; apName?: string; clients: number }>;
}

export function summarizeSite(
  site: LocalSite,
  devices: LocalDevice[],
  clients: LocalClient[],
): SiteSummary {
  let online = 0;
  let offline = 0;
  let other = 0;
  const counts: Record<DeviceRole, number> = {
    ap: 0,
    switch: 0,
    gateway: 0,
    accessory: 0,
    camera: 0,
    other: 0,
  };
  const offlineDevices: SiteSummary["offlineDevices"] = [];

  // Build an id→name lookup so we can attribute client counts back to AP names
  const apNameById = new Map<string, string | undefined>();

  for (const d of devices) {
    const role = classifyDevice(d);
    counts[role]++;
    if (role === "ap") apNameById.set(d.id, d.name);

    const state = (d.state ?? "").toUpperCase();
    if (state === "ONLINE") online++;
    else if (state === "OFFLINE") {
      offline++;
      offlineDevices.push({
        id: d.id,
        name: d.name,
        model: d.model,
        ip: d.ipAddress,
        state: d.state,
      });
    } else other++;
  }

  let wired = 0;
  let wireless = 0;
  const signal: Record<SignalBand, number> = {
    excellent: 0,
    good: 0,
    fair: 0,
    poor: 0,
    unknown: 0,
  };
  const apClientCounts = new Map<string, number>();

  for (const c of clients) {
    const t = (c.type ?? "").toUpperCase();
    if (t === "WIRED") wired++;
    else if (t === "WIRELESS") {
      wireless++;
      signal[signalBand(c.signalStrength)]++;
    }
    if (c.uplinkDeviceId) {
      apClientCounts.set(
        c.uplinkDeviceId,
        (apClientCounts.get(c.uplinkDeviceId) ?? 0) + 1,
      );
    }
  }

  const clientsByAp = [...apClientCounts.entries()]
    .filter(([apId]) => apNameById.has(apId)) // only count APs we know are APs
    .map(([apId, n]) => ({ apId, apName: apNameById.get(apId), clients: n }))
    .sort((a, b) => b.clients - a.clients);

  return {
    siteId: site.id,
    siteName: site.name ?? site.internalReference ?? site.id,
    totals: {
      devices: devices.length,
      online,
      offline,
      other,
      accessPoints: counts.ap,
      switches: counts.switch,
      gateways: counts.gateway,
      cameras: counts.camera,
      accessories: counts.accessory,
      clients: clients.length,
      wiredClients: wired,
      wirelessClients: wireless,
    },
    offlineDevices,
    wirelessSignal: wireless > 0 ? signal : undefined,
    clientsByAp: clientsByAp.length > 0 ? clientsByAp : undefined,
  };
}
