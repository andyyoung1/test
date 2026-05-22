# unifi-status — Claude Desktop Extension v0.3

A one-click Claude Desktop extension that connects Claude to UniFi across three API surfaces: cloud (Site Manager), local Network, and local Protect.

> "Summarize my camera status."
> "Has the front door seen anyone in the last 4 hours?"
> "Show me a snapshot from the driveway camera."
> "What's the recording mode on each Protect camera?"
> "Any packages delivered today?"

## What's new in v0.3

- **UniFi Protect support** via the local Protect Integration API. Same X-API-KEY as Network — no new keys to generate.
- **Five new tools**: `protect_overview`, `protect_cameras`, `recent_motion_events`, `recent_smart_detects`, `camera_snapshot`.
- **Inline snapshots**: `camera_snapshot` returns the JPEG inline in chat, defaulting to a 640×360 thumbnail (~50 KB) so responses stay snappy. Pass `full_resolution: true` for the native image.
- **Event tools resolve camera names** so you get "Driveway G6" not just an ID.
- **`transport_status` now probes Protect too**, so you can distinguish "Protect not running on this console" from "console unreachable."

## Tool surface

| Tool | Transport | Purpose |
|---|---|---|
| `list_hosts` | cloud | All UniFi consoles on the account |
| `list_sites` | cloud | All sites across hosts |
| `list_devices` | cloud | Devices, optional `cameras_only` filter |
| `camera_status` | cloud | Camera totals, offline list, firmware updates |
| `network_status` | **local Network** | Per-console site/device/client breakdown |
| `protect_overview` | **local Protect** | NVR + camera fleet summary |
| `protect_cameras` | **local Protect** | Per-camera recording mode, smart-detect config, last motion |
| `recent_motion_events` | **local Protect** | Motion events with camera names |
| `recent_smart_detects` | **local Protect** | Person / vehicle / package / animal / license-plate events |
| `camera_snapshot` | **local Protect** | Current still, returned inline as JPEG |
| `transport_status` | all | Reachability diagnostic |

## Install

1. **Get a cloud API key.** unifi.ui.com → API → generate. Copy immediately.
2. **Open `unifi-status.mcpb`** (double-click on macOS/Windows, or Settings → Extensions → Advanced settings → Install Extension).
3. **Paste your cloud API key** when prompted. Stored in your OS keychain.
4. **Restart Claude Desktop.** Try: *"Give me a status summary of my UniFi cameras."*

That's the cloud-only experience. To unlock the Network and Protect tools, configure local consoles next.

## Adding local API access

The Network and Protect Integration APIs **share one API key per UDM** — you only need to generate one key on each console to use both surfaces.

### 1. Generate a local API key on each UDM

**Settings → Control Plane → Integrations → Create API Key**. Copy it (only shown once). The key inherits the creating admin's permissions, so use a dedicated admin account if you want least-privilege.

Repeat on each console.

### 2. Find the cloud host IDs

In Claude: *"List my UniFi hosts."* Copy the `id` for each.

### 3. Configure local consoles

Settings → Extensions → UniFi Status → settings → "Local consoles":

```json
[
  {
    "hostId": "6C63F8A2C421000000000937EDED...",
    "name": "Udm-Pro-Urb",
    "url": "https://192.168.3.1",
    "apiKey": "PASTE_LOCAL_KEY_FOR_URB"
  },
  {
    "hostId": "245A4C87EB660000000005DD7FA1...",
    "name": "UDM-Pro",
    "url": "https://192.168.1.1",
    "apiKey": "PASTE_LOCAL_KEY_FOR_HOME"
  }
]
```

URL accepts forms with/without scheme, with/without trailing slash, with/without proxy path — all normalized. Leave "Allow self-signed certs" set to `true` unless you've installed a real cert on your UDM.

### 4. Verify

*"What's my transport status?"* — `transport_status` shows cloud + Network + Protect reachability per console.

### 5. Try Protect tools

- *"Give me a Protect overview."* → `protect_overview`
- *"What's the recording mode on each camera?"* → `protect_cameras`
- *"Has anything triggered motion in the last 2 hours?"* → `recent_motion_events`
- *"Any people or packages detected today?"* → `recent_smart_detects`
- *"Show me a snapshot from the driveway camera."* → `camera_snapshot`

## Snapshot details

`camera_snapshot` defaults to a **640×360 thumbnail** (~50 KB) so the response is fast and the JSON-RPC payload stays small. This is intentional: full-resolution images from modern Protect cameras can exceed 1 MB, which some MCP clients struggle to render.

To get full resolution: ask for it explicitly, or call the tool with `full_resolution: true`.

For dual-camera devices (e.g., G4 Doorbell Pro PoE which has a package camera): set `use_package_camera: true` to capture from the secondary lens.

## When you're away from your network

- **Cloud tools** keep working from anywhere.
- **Local tools** fail with a clear "unreachable" message — not silent timeouts.
- **Teleport / VPN** restores local access; URLs in your config can be LAN IPs reachable through the tunnel.

## Build from source

```bash
npm install
npm run build               # tsc → server/
```

### Smoke test

Validates all three surfaces without going through MCP:

```bash
$env:UNIFI_API_KEY = "<cloud-key>"
$env:UNIFI_LOCAL_CONSOLES = '[{"hostId":"...","url":"https://192.168.3.1","apiKey":"<local-key>"}]'
$env:UNIFI_LOCAL_TLS_INSECURE = "true"
npx tsx src/smoke-test.ts
```

You'll see cloud OK, then for each console a Network status line and a Protect status line.

### Pack

```bash
npm install --omit=dev
npx mcpb validate manifest.json
npx mcpb pack . unifi-status.mcpb
```

## Troubleshooting

**`transport_status` says Protect is unreachable but Network is fine.**
Some UniFi OS versions ship without the Protect application installed, or with it disabled. Open Protect at `https://<udm-ip>/protect/` in a browser to confirm it's running. If not, install it from the UniFi OS dashboard.

**401 on Protect, 200 on Network (same key).**
Should be impossible per Ubiquiti's docs — the same key covers both. If you see this, the most likely cause is that the key was generated on a UniFi OS version that pre-dates unified Network+Protect keys. Regenerate the key on the current OS version.

**Snapshots come back with "Snapshot {id} on {name}: 400" or similar.**
Camera ID is wrong. Use `protect_cameras` (no filter) to list all camera IDs on the console.

**`recent_motion_events` returns empty when you know there's been motion.**
Two likely causes:
1. The look-back window is too narrow (`hours: 24` is the default; try `168` for a week).
2. The console has Protect events filtered or auto-pruned. Check Protect's event retention settings.

**Snapshot payload too large / Claude says "context length exceeded".**
You asked for full resolution and the camera is high-res. Drop `full_resolution: true` to revert to the thumbnail.

**`recent_smart_detects` returns motion events too.**
That's expected: the underlying API mixes event types in one stream. The tool filters to `smartDetectZone` and `smartDetectLine` types, and you can further filter with the `types` parameter (e.g., `["person", "package"]`).

**Logs**
- macOS: `~/Library/Logs/Claude/mcp-server-unifi-status.log`
- Windows: `%APPDATA%\Claude\logs\mcp-server-unifi-status.log`

## Security notes

- **Cloud key** is read-only at the Site Manager level.
- **Local keys** inherit the creating admin's permissions on that console. There is currently no way to scope a local API key to read-only or to specific endpoints — Ubiquiti exposes admin-level keys only. Use a dedicated admin account if you need separation.
- **All keys** are stored in your OS keychain via Claude Desktop's `sensitive: true` user_config.
- **Self-signed TLS** is opted in per host using a scoped undici Agent, not by setting `NODE_TLS_REJECT_UNAUTHORIZED=0`.

## Roadmap (v0.4 ideas)

- **Per-port switch detail** — what's plugged in where, PoE budget, link speed
- **Wi-Fi audit** — SSIDs, security modes, band steering, min-RSSI settings
- **Event push** — websocket subscription to Protect events for near-real-time alerts via a future Claude tool surface
- **Site-to-site config diff** — compare two consoles' device inventory and identify drift
