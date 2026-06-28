# Zenwifi Dashboard

A self-hosted web dashboard for Asus ZenWifi access points running Merlin or stock Asus firmware.

Supports:

- Multi-AP mesh setups (e.g. XT8 AiMesh)
- Standalone APs
- Broadcom (`wl`) and Atheros/Qualcomm (`wlanconfig`) wireless drivers

## Current feature set

### Real-time dashboard

- **Consolidated client list across all access points** with **WebSocket push** updates
- Per-client details (where available):
  - MAC address
  - Vendor (OUI lookup)
  - Hostname and IP
  - AP name and interface
  - RSSI
  - TX/RX byte counters (shown as `null` if the firmware does not expose them)
  - Reachability (last ping timestamp + result, for discovered clients)
- **AP status overview**: online/offline, client counts, last seen timestamp, and last error
- **Live log view** (file-backed, full viewport height, with history load and runtime debug toggle)
- **Version badge + GitHub link** in the header (version sourced dynamically from the backend)

### Mesh-aware behavior (AiMesh)

- **Mesh node detection** using the master router's `/tmp/aplist.json` and `/tmp/relist.json`
- Backhaul / infrastructure entries are:
  - Collapsed into a single row per physical mesh node
  - Shown with a distinct visual style
  - **Not disconnectable**

### Discovered clients (OPNsense Neighbor Discovery)

When OPNsense Neighbor Discovery is enabled, the backend merges wired and non-WiFi hosts
that are visible on configured OPNsense interfaces but not already connected via ZenWifi Wi-Fi:

- Hosts appear as **"Discovered \<Interface\>"** rows (e.g. "Discovered LAN")
- Interface names can be mapped to human-readable labels via `interface_labels` in config
- Hosts last seen more than 24 hours ago are ignored
- Discovered clients are **pinged via ICMP** to verify reachability; offline hosts are hidden
  from the frontend until they respond again (see [Pinger](#pinger) below)
- Discovered clients cannot be disconnected from the UI
- Requires OPNsense 26.1+ with the **Host Discovery** service enabled and the
  **Host Discovery: Search** API privilege granted

### Pinger

The backend runs periodic ICMP reachability checks against all discovered (non-WiFi) clients:

- 3 ICMP packets per client, 1 s timeout each
- Clients that fail all 3 packets are hidden from the frontend until they respond again
- Newly discovered clients are pinged immediately (rather than waiting for the next scheduled cycle)
- When a client transitions from Wi-Fi to discovered, an immediate ping is fired
- **On-demand ping**: a Ping button in the client table triggers an immediate single-client ping
  via `POST /api/ping`; the Reachable column updates optimistically without waiting for the next
  broadcast cycle
- Ping interval is configurable via `ping_interval_minutes` (default: 5 minutes)
- Uses the system `ping` binary -- no extra npm package required

### Client control

- Disconnect (kick) regular Wi-Fi clients from the UI
- Disconnect clients via MQTT (`{prefix}/clients/{mac}/disconnect`)

### Client table features

- **Multi-column sort**: plain click = single-column sort; Shift+click = add/toggle a column in
  the multi-sort stack; sort state is persisted to `localStorage` and survives tab switches
- **Active filter chips**: OUI, vendor, and AP facets are shown as removable chips above the table
- **AP name pills**: access point names are shown as styled pill buttons with a status dot;
  clicking filters the table to that AP
- **Search**: matches MAC, vendor, hostname, IP, AP name, "mesh node", and "discovered"
- **Row badges**: mesh infrastructure rows show an "Infrastructure" badge; discovered rows show
  a "Discovered" badge
- **Column settings**: toggle visible columns via an inline panel that unfolds below the header
  (works on mobile without overflowing the viewport)
- **Click-to-log**: clicking a MAC or IP cell switches to the Log view with that value
  pre-filled as the search filter
- **Reachable column**: shows last ping timestamp and result for discovered clients
- All filter and search state is lifted to App and persists across tab switches

### Log view

- File-backed logger (replaces the old in-memory ring buffer); log files are purged on each
  backend startup so every run starts with a clean log
- **Load history**: buttons to request the last 500 lines or all lines from the server
- **Top / Bottom** navigation buttons (blue); Top button is visible immediately on load
- **Debug toggle**: a toggle in the log toolbar enables/disables debug logging at runtime
  without restarting the backend; state is synced from `config.yaml` on connect and broadcast
  to all connected frontends when changed
- **Line count status bar** at the bottom showing filtered vs total line count
- Clickable `[TAG]`, MAC, and IP tokens in log messages -- clicking sets the search filter

### MQTT integration

- LWT bridge state (`{prefix}/bridge/state` retained)
- Per-client state + info topics (retained)
- Per-AP status topics (retained)
- Global stats topic for total online clients (retained)
- **Home Assistant MQTT Discovery**: publishes a `button` entity per client so HA can trigger
  a Wi-Fi disconnect; entity name is "Disconnect Wi-Fi"; discovery is published once per client
  on first appearance and retracted when the client goes offline

### Housekeeping

On startup (after one full interval delay) and then every `housekeeping_interval_minutes`
(default: 60), the backend scans the SQLite DB for MACs that are no longer in the active
client set and for each stale row:

- Publishes `state=offline` and removes the HA discovery config (retained, empty payload)
- Deletes the row from the DB

### Resilience

- **AP failure resilience**: an AP's client list is only cleared after **3 consecutive poll failures**
- **Interface discovery caching**: wireless interface discovery results are cached and reused across
  poll cycles (configurable via `iface_discovery_interval`), reducing SSH overhead significantly
- **DB offline state restore**: on startup, the pinger's status map is pre-seeded from the DB so
  previously-offline discovered clients remain hidden until they respond
- Configurable poll interval, log file settings, and debug logging

### Optional OPNsense integration

If configured, the backend integrates with OPNsense for two purposes:

#### DHCP enrichment

- **Dynamic leases** via OPNsense REST API (IP, hostname, lease end, lease type)
- **Static reservations** via:
  - Kea reservations endpoint (if available), otherwise
  - SSH read of `/conf/config.xml` static mappings
- The backend automatically handles OPNsense's numbered SSH console menu (sends `8` to open a shell)

The enriched data is exposed under `client.dhcp.*` and (for non-mesh clients) the dashboard
promotes DHCP hostname/IP to the top-level fields when present.

#### Neighbor Discovery (discovered clients)

See [Discovered clients](#discovered-clients-opnsense-neighbor-discovery) above.

---

## Versioning

The project version is maintained in a single place: **`backend/package.json`** (`"version"` field).

- The backend reads this value at startup and broadcasts it to all WebSocket clients as part of every `clients` message.
- The frontend displays the version badge in the header without any hardcoded constant -- it simply consumes `data.version` from the WebSocket payload.
- The repository URL is sourced the same way from `backend/package.json` (`"repository".url`) and used to render the GitHub link in the header.

To bump the version, update only `backend/package.json`. No frontend file changes are needed.

---

## Releases

Releases follow [Semantic Versioning](https://semver.org/). The typical flow:

1. Make and commit all code changes to `main`.
2. Update the `"version"` field in `backend/package.json` (patch / minor / major as appropriate).
3. Create a GitHub Release with tag `vMAJOR.MINOR.PATCH` targeting `main`, and paste the changelog as release notes.

See [releases](https://github.com/meks007/zenwifi-dashboard/releases) for the full history.

---

## Quick Start

### 1. Configure

Copy the example config and edit it:

```bash
cp config.example.yaml config.yaml
```

### 2. Run

```bash
docker compose up -d
```

Open http://localhost:3000 in your browser.

---

## Configuration

`config.yaml` (copy from `config.example.yaml`):

```yaml
# Zenwifi Dashboard Configuration Example
# Copy this file to config.yaml and adjust to your environment.

mqtt:
  host: 192.168.1.10
  port: 1883
  username: myuser
  password: mypassword
  topic_prefix: zenwifi

# How often (in seconds) to poll all access points for connected clients.
polling_interval_seconds: 30

# How often to re-run wireless interface discovery per AP (in poll cycles).
# Default: 10
iface_discovery_interval: 10

# File-backed logger settings.
# Log files are purged on each backend startup.
log_file:
  path: /tmp/zenwifi.log
  max_lines: 5000

# Set to true to log every SSH command and its output (very verbose).
# Can also be toggled at runtime from the Log view in the UI.
debug_logging: false

# Whether to include IPv6 addresses in the IP column. Default: false.
show_ipv6: false

# How often (in minutes) to ping discovered (non-WiFi) clients. Default: 5.
ping_interval_minutes: 5

# How often (in minutes) to evict stale DB records. Default: 60.
housekeeping_interval_minutes: 60

access_points:
  - name: "Living Room"
    host: 192.168.1.1
    ssh_port: 22
    username: admin
    password: secret
    master: true

  - name: "Office"
    host: 192.168.1.2
    ssh_port: 22
    username: admin
    password: secret

opnsense:
  host: 192.168.x.x
  port: 443
  api_key: your-api-key
  api_secret: your-api-secret
  verify_ssl: false
  ssh_host: 192.168.x.x
  ssh_port: 22
  username: root
  password: your-root-password
  poll_interval: 60
  neighbor_discovery:
    enabled: true
    interfaces:
      - lan
    interface_labels:
      lan: "LAN"

# Home Assistant MQTT Discovery (optional)
ha_discovery:
  enabled: true
  prefix: homeassistant
```

### Config reference

| Key | Default | Description |
|---|---:|---|
| `mqtt.host` | required | MQTT broker hostname or IP |
| `mqtt.port` | `1883` | MQTT broker port |
| `mqtt.username` | required | MQTT username |
| `mqtt.password` | required | MQTT password |
| `mqtt.topic_prefix` | `zenwifi` | Root topic prefix |
| `polling_interval_seconds` | `30` | Seconds between AP polls |
| `iface_discovery_interval` | `10` | Re-run interface discovery every N poll cycles |
| `log_file.path` | `/tmp/zenwifi.log` | Log file path |
| `log_file.max_lines` | `5000` | Maximum lines kept in the log file |
| `debug_logging` | `false` | Verbose SSH command logging (also togglable at runtime) |
| `show_ipv6` | `false` | Show IPv6 addresses in the IP column |
| `ping_interval_minutes` | `5` | How often (minutes) to ICMP-ping discovered clients |
| `housekeeping_interval_minutes` | `60` | How often (minutes) to evict stale DB records |
| `access_points[].name` | required | Display name |
| `access_points[].host` | required | AP hostname or IP |
| `access_points[].ssh_port` | `22` | SSH port |
| `access_points[].username` | required | SSH username |
| `access_points[].password` | required | SSH password |
| `access_points[].master` | `false` | Mark exactly one AP as master |
| `access_points[].driver` | auto | `broadcom` or `atheros`; auto-detected if omitted |
| `opnsense.*` | optional | OPNsense integration (see below) |
| `opnsense.neighbor_discovery.enabled` | `false` | Enable OPNsense Neighbor Discovery |
| `opnsense.neighbor_discovery.interfaces` | `[]` | OPNsense interfaces to watch |
| `opnsense.neighbor_discovery.interface_labels` | `{}` | Human-readable labels for interface names |
| `ha_discovery.enabled` | `false` | Enable Home Assistant MQTT Discovery |
| `ha_discovery.prefix` | `homeassistant` | HA discovery topic prefix |

### Driver detection

The backend probes each AP via SSH to determine whether it uses the Broadcom (`wl`) or
Atheros/Qualcomm (`wlanconfig`) wireless driver. The result is cached for the lifetime of the
process.

Set `driver:` explicitly if auto-detection fails.

---

## OPNsense DHCP enrichment (optional)

See `config.example.yaml` for the full block.

Minimum required fields:

- `opnsense.host`
- `opnsense.api_key`
- `opnsense.api_secret`

Optional (only needed for reservation enrichment):

- `opnsense.username` + `opnsense.password` (or `opnsense.key_path`)

---

## MQTT Topic Structure

`{prefix}` is set via `mqtt.topic_prefix` (default: `zenwifi`).

| Topic | Direction | Payload | Retained |
|---|---|---|---|
| `{prefix}/bridge/state` | Publish | `online` / `offline` (LWT) | yes |
| `{prefix}/clients/{mac}/state` | Publish | `online` / `offline` | yes |
| `{prefix}/clients/{mac}/info` | Publish | JSON object | yes |
| `{prefix}/clients/{mac}/last_seen` | Publish | ISO 8601 timestamp | yes |
| `{prefix}/clients/{mac}/disconnect` | Subscribe | any | - |
| `{prefix}/aps/{name}/state` | Publish | `online` / `offline` | yes |
| `{prefix}/aps/{name}/clients` | Publish | client count (integer) | yes |
| `{prefix}/aps/{name}/last_seen` | Publish | ISO 8601 timestamp | yes |
| `{prefix}/stats/clients_online` | Publish | total online client count | yes |

### Home Assistant MQTT Discovery

When `ha_discovery.enabled: true`, the backend publishes a `button` entity for each online
Wi-Fi client to `{ha_prefix}/button/zenwifi_{mac}/config` (retained). The button is named
"Disconnect Wi-Fi" and pressing it publishes to the client's disconnect topic. The discovery
config is retracted (empty retained payload) when the client goes offline or is evicted by
housekeeping.

### Client info payload

```json
{
  "hostname": "my-phone",
  "ip": "192.168.1.42",
  "rssi": -65,
  "iface": "eth5",
  "ap": "Living Room",
  "tx_bytes": 12345678,
  "rx_bytes": 87654321
}
```

`tx_bytes` / `rx_bytes` are `null` when the AP firmware does not expose per-client byte counters.

### WebSocket clients payload

Every connected frontend receives a `clients` message on connect and on every poll cycle:

```json
{
  "type": "clients",
  "clients": [...],
  "apStatus": {...},
  "mqttConnected": true,
  "dbHealthy": true,
  "version": "0.1.4",
  "repoUrl": "https://github.com/meks007/zenwifi-dashboard",
  "timestamp": "2026-06-28T09:00:00.000Z"
}
```

`version` and `repoUrl` are read from `backend/package.json` at startup and require no frontend
changes when the version is bumped.

### LWT

The broker publishes `offline` to `{prefix}/bridge/state` (retained) if the backend process
disconnects unexpectedly. The backend publishes `online` immediately on connect.

### Disconnect a client via MQTT

```bash
mosquitto_pub -t zenwifi/clients/aa:bb:cc:dd:ee:ff/disconnect -m 1
```

---

## SSH Commands Used

### Broadcom firmware (wl)

| Purpose | Command |
|---|---|
| Driver detection | `wl ver` |
| Interface discovery | `ip -o link show` filtered, then `wl -i {iface} assoclist` probe |
| Associated clients | `wl -i {iface} assoclist` |
| Client RSSI | `wl -i {iface} rssi {mac}` |
| Client TX/RX stats | `wl -i {iface} sta_info {mac}` |
| Kick client | `wl -i {iface} deauthenticate {mac}` |

### Atheros / Qualcomm firmware (wlanconfig)

| Purpose | Command |
|---|---|
| Driver detection | `wlanconfig` |
| Interface discovery | `ifconfig` (filters ath*) |
| Associated clients + RSSI | `wlanconfig {iface} list sta` |
| Client TX/RX stats | `wlanconfig {iface} list sta` (extended columns 22/23) |
| Kick client | `wlanconfig {iface} kick {mac}` |

### Common (all APs)

| Purpose | Command |
|---|---|
| ARP table (IP fallback) | `cat /proc/net/arp` |
| Neighbor table (IP resolution) | `ip neigh` (master node only) |
| Client IPs and RSSI | `cat /tmp/clientlist.json` (master node only) |
| Mesh AP list | `cat /tmp/aplist.json` (master node only) |
| Mesh relay list | `cat /tmp/relist.json` (master node only) |

---

## Mesh Node Handling

On AiMesh setups the master router exposes `/tmp/aplist.json` and `/tmp/relist.json`, which map
backhaul radio MAC addresses to their physical node.

The backend reads these once per poll cycle and uses them to:

- Collapse multiple backhaul MACs belonging to the same physical node into a single row
- Tag mesh infrastructure entries with a distinct visual style; they cannot be disconnected from the UI

---

## AP Failure Handling

If an AP cannot be reached via SSH, its last known client list is retained until 3 consecutive
poll failures occur. This prevents brief network interruptions from clearing the client list.

---

## Architecture

```
backend/
  package.json              <- single source of truth for version and repository URL
  Dockerfile                <- node:20-alpine; WORKDIR /app; runs src/index.js
  src/
    index.js                <- Express + WebSocket server; orchestrates all modules
    config.js               <- config.yaml loader + ha_discovery / log_file config helpers
    routes.js               <- HTTP route handlers (clients, disconnect, ping, debug, logs)
    ssh.js                  <- AP polling orchestrator
    ssh-transport.js        <- raw SSH primitive (runSSH)
    ssh-drivers.js          <- driver detection, interface cache, Broadcom/Atheros helpers
    mesh.js                 <- AiMesh topology parsing (aplist.json, relist.json)
    client-pipeline.js      <- pure poll transform helpers (IP filter, type detection, etc.)
    mqtt.js                 <- MQTT bridge + HA MQTT Discovery publish/unpublish
    opnsense.js             <- OPNsense coordinator
    opnsense-dhcp.js        <- OPNsense leases, reservations, DHCP lookup
    opnsense-neighbors.js   <- OPNsense neighbor/host discovery
    pinger.js               <- ICMP reachability checks + on-demand single-client ping
    housekeeping.js         <- stale DB record eviction + MQTT/HA cleanup
    db.js                   <- SQLite persistence (client_seen, last_ping_at, last_ping_result)
    logger.js               <- file-backed logger with WebSocket broadcaster and isDebug() getter
    oui.js                  <- MAC OUI vendor lookup

frontend/
  src/
    App.jsx                 <- WebSocket client; owns all filter/facet state; debug toggle
    components/
      ClientTable.jsx       <- client list orchestrator (sort, filter, AP pills, column toggle)
      ClientTableCell.jsx   <- per-cell renderer (MAC/IP click-to-log, ping button, disconnect)
      ClientTableControls.jsx <- ColumnSettingsPanel, ResizeHandle
      LogView.jsx           <- live log view (history load, debug toggle, Top/Bottom nav, line count)
      StatusBar.jsx         <- AP status overview (4-column grid)
```

### Docker layout note

The backend container sets `WORKDIR /app` and copies `src/` into `/app/src/`. The `package.json`
therefore lives at `/app/package.json`, one level above `src/`. The require path in `index.js` is:

```js
const pkg = require('../package.json');
```

---

## Development

### Backend (Node.js)

```bash
cd backend
npm install
CONFIG_PATH=../config.yaml npm run dev
```

### Frontend (React + Vite)

```bash
cd frontend
npm install
npm run dev
```

The Vite dev server proxies `/api` and WebSocket connections to `http://localhost:3001`.

---

## Contributors

- [meks007](https://github.com/meks007) - Project owner
