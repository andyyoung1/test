/**
 * Smoke test — exercises cloud, then Network + Protect on each configured local console.
 * Run before packaging:
 *   $env:UNIFI_API_KEY = "<cloud-key>"
 *   $env:UNIFI_LOCAL_CONSOLES = '[{"hostId":"...","url":"https://192.168.3.1","apiKey":"<local-key>"}]'
 *   npx tsx src/smoke-test.ts
 */

import { UnifiAPIError, UnifiClient } from "./cloud/client.js";
import { cameraStatusSummary } from "./cloud/summarize.js";
import { summarizeSite } from "./local/summarize.js";
import { protectOverview } from "./protect/summarize.js";
import { loadRegistryFromEnv } from "./registry.js";

async function main(): Promise<number> {
  if (!process.env.UNIFI_API_KEY) {
    console.error("ERROR: UNIFI_API_KEY env var not set.");
    return 1;
  }

  let failed = 0;

  console.log("=== Cloud (Site Manager) ===");
  try {
    const c = new UnifiClient();
    const hosts = await c.listHosts();
    const devices = await c.listDevices();
    const summary = cameraStatusSummary(devices);
    console.log(
      `  ${hosts.length} host(s), ${devices.length} devices, ` +
        `${summary.overview.totalCameras} cameras (${summary.overview.online} on, ${summary.overview.offline} off)`,
    );
    console.log("  ✓ cloud OK");
  } catch (err) {
    failed++;
    console.error(`  ✗ cloud: ${err instanceof UnifiAPIError ? err.message : err}`);
  }

  console.log("\n=== Local consoles ===");
  const { entries, errors } = loadRegistryFromEnv();
  for (const e of errors) console.error(`  config: ${e}`);
  if (entries.size === 0) {
    console.log("  (none configured — set UNIFI_LOCAL_CONSOLES to enable)");
  }

  for (const entry of entries.values()) {
    const label = `${entry.config.name ?? entry.config.hostId} @ ${entry.config.url}`;
    console.log(`\n  ${label}`);

    // Network
    process.stdout.write("    Network: ");
    try {
      const ping = await entry.network.ping();
      if (!ping.ok) {
        failed++;
        console.log(`✗ unreachable (${ping.error})`);
      } else {
        const sites = await entry.network.listSites();
        let totalDevs = 0;
        let totalClients = 0;
        for (const s of sites) {
          const [devs, clients] = await Promise.all([
            entry.network.listDevices(s.id),
            entry.network.listClients(s.id),
          ]);
          const sum = summarizeSite(s, devs, clients);
          totalDevs += sum.totals.devices;
          totalClients += sum.totals.clients;
        }
        console.log(
          `✓ ${ping.latencyMs}ms, ${sites.length} site(s), ${totalDevs} devices, ${totalClients} clients`,
        );
      }
    } catch (err) {
      failed++;
      console.log(`✗ ${err instanceof Error ? err.message : err}`);
    }

    // Protect
    process.stdout.write("    Protect: ");
    try {
      const ping = await entry.protect.ping();
      if (!ping.ok) {
        // Not necessarily a failure — Protect may not be running on this console.
        console.log(`(not reachable: ${ping.error})`);
      } else {
        const [nvr, cams] = await Promise.all([
          entry.protect.getNvrInfo().catch(() => ({})),
          entry.protect.listCameras(),
        ]);
        const ov = protectOverview(nvr, cams);
        console.log(
          `✓ ${ping.latencyMs}ms, NVR ${ov.nvr.firmwareVersion ?? "?"}, ` +
            `${ov.cameras.total} cameras (${ov.cameras.connected} connected, ${ov.cameras.recording} recording, ` +
            `${ov.cameras.motionInLast24h} with motion in 24h)`,
        );
      }
    } catch (err) {
      failed++;
      console.log(`✗ ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(failed ? `\n✗ ${failed} failure(s)` : "\n✓ smoke test passed");
  return failed ? 2 : 0;
}

main().then((code) => process.exit(code));
