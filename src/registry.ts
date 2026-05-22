/**
 * Console registry — bridges cloud host IDs to local API clients.
 *
 * v0.3: same config shape as v0.2, but each entry now exposes BOTH a Network
 * Integration client AND a Protect Integration client. They share the same
 * X-API-KEY (confirmed: a single local key on the UDM grants access to both
 * application surfaces), so no new manifest fields are needed.
 */

import { UnifiLocalClient } from "./local/client.js";
import { UnifiProtectClient } from "./protect/client.js";

export interface LocalConsoleConfig {
  hostId: string;
  name?: string;
  url: string;
  apiKey: string;
}

export interface RegistryEntry {
  config: LocalConsoleConfig;
  network: UnifiLocalClient;
  protect: UnifiProtectClient;
}

export interface ParseResult {
  entries: Map<string, RegistryEntry>;
  errors: string[];
}

const ENV_CONSOLES = "UNIFI_LOCAL_CONSOLES";
const ENV_TLS_INSECURE = "UNIFI_LOCAL_TLS_INSECURE";

export function loadRegistryFromEnv(): ParseResult {
  const entries = new Map<string, RegistryEntry>();
  const errors: string[] = [];

  const raw = (process.env[ENV_CONSOLES] ?? "").trim();
  if (!raw) return { entries, errors };

  const allowSelfSigned = /^(true|1|yes)$/i.test(
    (process.env[ENV_TLS_INSECURE] ?? "true").trim(),
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    errors.push(
      `${ENV_CONSOLES} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { entries, errors };
  }
  if (!Array.isArray(parsed)) {
    errors.push(`${ENV_CONSOLES} must be a JSON array, got ${typeof parsed}`);
    return { entries, errors };
  }

  for (const [i, item] of parsed.entries()) {
    const cfg = validateConsoleConfig(item, i);
    if (typeof cfg === "string") {
      errors.push(cfg);
      continue;
    }
    if (entries.has(cfg.hostId)) {
      errors.push(`Duplicate hostId at index ${i}: ${cfg.hostId}`);
      continue;
    }
    try {
      const sharedOpts = {
        hostId: cfg.hostId,
        name: cfg.name,
        url: cfg.url,
        apiKey: cfg.apiKey,
        allowSelfSigned,
      };
      entries.set(cfg.hostId, {
        config: cfg,
        network: new UnifiLocalClient(sharedOpts),
        protect: new UnifiProtectClient(sharedOpts),
      });
    } catch (e) {
      errors.push(
        `Console at index ${i} (${cfg.name ?? cfg.hostId}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return { entries, errors };
}

function validateConsoleConfig(item: unknown, index: number): LocalConsoleConfig | string {
  if (!item || typeof item !== "object") {
    return `Console at index ${index} is not an object`;
  }
  const obj = item as Record<string, unknown>;
  const hostId = obj.hostId;
  const url = obj.url;
  const apiKey = obj.apiKey;
  const name = obj.name;

  if (typeof hostId !== "string" || !hostId) return `Console at index ${index}: missing hostId`;
  if (typeof url !== "string" || !url) return `Console at index ${index}: missing url`;
  if (typeof apiKey !== "string" || !apiKey)
    return `Console at index ${index}: missing apiKey`;
  if (name !== undefined && typeof name !== "string")
    return `Console at index ${index}: name must be a string if provided`;

  return { hostId, url, apiKey, name };
}

export function safeConsoleSummary(e: RegistryEntry) {
  return {
    hostId: e.config.hostId,
    name: e.config.name ?? e.config.hostId,
    url: e.config.url,
  };
}
