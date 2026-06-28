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
- **AP status overview**: online/offline, client counts, last seen timestamp, and last error
- **Live log view** (server log ring buffer, full viewport height)
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
- Ping interval is configurable via `ping_interval_minutes` (default: 5 minutes)
- Uses the system `ping` binary - no extra npm package required

### Client control

- Disconnect (kick) regular Wi-Fi clients from the UI
- Disconnect clients via MQTT (`{prefix}/clients/{mac}/disconnect`)

### Client table features

- **Multi-column sort**: click column headers to sort; Shift+click a column header to remove it from the sort order
- **Active filter chips**: OUI, vendor, and AP facets are shown as removable chips above the table
- **AP name pills**: access point names are shown as styled pill buttons with a status dot; clicking filters the table to that AP
- **Search**: matches MAC, vendor, hostname, IP, AP name, "mesh node", and "discovered"
- **Row badges**: mesh infrastructure rows show an "Infrastructure" badge; discovered rows show a "Discovered" badge
- **Column settings**: toggle visible columns via an inline panel that unfolds below the header (works on mobile without overflowing the viewport)

### MQTT integration

- LWT bridge state (`{prefix}/bridge/state` retained)
- Per-client state + info topics (retained)
- Per-AP status topics (retained)
- Global stats topic for total online clients (retained)

### Resilience

- **AP failure resilience**: an AP's client list is only cleared after **3 consecutive poll failures**
- **Interface discovery caching**: wireless interface discovery results are cached and reused across
  poll cycles (configurable via `iface_discovery_interval`), reducing SSH overhead significantly
- Configurable poll interval, log ring buffer size, and debug logging

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
# Polling involves multiple SSH commands per AP, so keep this sane (>=30 recommended).
polling_interval_seconds: 30

# How often to re-run wireless interface discovery per AP (in poll cycles).
# Discovery runs on the very first poll and then once every N cycles.
# Example: polling_interval_seconds: 30, iface_discovery_interval: 10
#   -> discovery runs on poll 0, 10, 20, 30, ... (every ~5 minutes)
# Set to 1 to disable caching and always run discovery. Default: 10.
iface_discovery_interval: 10

# Size of the in-memory log ring buffer (number of log lines kept).
# Older entries are dropped when the buffer is full. Default: 500.
log_buffer_size: 500

# Set to true to log every SSH command and its output (very verbose).
debug_logging: false

# Whether to include IPv6 addresses in the IP column.
# Defaults to false: only IPv4 addresses are shown.
show_ipv6: false

# How often (in minutes) to ping discovered (non-WiFi) clients to check reachability.
# 3 ICMP packets are sent per client. Clients that fail all 3 are hidden from the
# frontend until they respond again. Default: 5.
ping_interval_minutes: 5

access_points:
  # Mark exactly one AP as master: true. The master node maintains
  # /tmp/clientlist.json which is the primary source for client IPs and
  # RSSI values across all nodes. On ASUS AiMesh, this is the main router.
  - name: "Living Room"
    host: 192.168.1.1
    ssh_port: 22
    username: admin
    password: secret
    master: true
    # driver: broadcom  # optional override; auto-detected if omitted

  - name: "Office"
    host: 192.168.1.2
    ssh_port: 22
    username: admin
    password: secret
    # driver: broadcom

  # Example: Atheros-based node (e.g. ZenWifi AC Mini with stock ASUS firmware)
  - name: "Bedroom"
    host: 192.168.1.3
    ssh_port: 22
    username: admin
    password: secret
    # driver: atheros

# ---------------------------------------------------------------------------
# OPNsense integration (optional)
# ---------------------------------------------------------------------------
# When configured, the backend queries OPNsense for:
# - Dynamic leases        : via REST API -> client.dhcp.ip / hostname / leaseEnds
# - Static mappings       : via SSH -> client.dhcp.description / hasReservation
# - Neighbor discovery    : via REST API -> discovered clients on configured interfaces
#
# REST API credentials:
# System -> Access -> Users -> <user> -> API keys
# Required privileges:
#   - DHCP: Leases (for lease enrichment)
#   - Host Discovery: Search (for neighbor discovery)
#
# SSH credentials: the backend automatically handles OPNsense's numbered
# console menu by sending "8" to open a shell.
# Must connect as root.
#
# Remove this block or leave host empty to disable OPNsense integration.
# ---------------------------------------------------------------------------
opnsense:
  # --- REST API (leases + neighbor discovery) ---
  host: 192.168.x.x  # OPNsense IP or hostname
  port: 443           # HTTPS port (default: 443)
  api_key: your-api-key
  api_secret: your-api-secret
  verify_ssl: false   # Set to true if OPNsense has a valid/trusted TLS cert

  # --- SSH (static reservations via /conf/config.xml) ---
  ssh_host: 192.168.x.x  # defaults to 'host' above if omitted
  ssh_port: 22
  username: root
  password: your-root-password
  # key_path: /run/secrets/opnsense_id_rsa  # path to private key

  # --- Polling ---
  poll_interval: 60  # How often (seconds) to refresh DHCP data

  # --- Neighbor Discovery (discovered client detection) ---
  # Requires OPNsense 26.1+ and the "Host Discovery" service enabled
  # (Interfaces -> Neighbors -> Automatic Discovery).
  # The API key user needs the "Host Discovery: Search" privilege.
  # Hosts last seen more than 24 hours ago are ignored.
  # Hosts already connected via ZenWifi Wi-Fi are never shown as discovered.
  #
  # interface_labels: optional map of OPNsense interface name (lowercase)
  # to a human-readable label shown in the "Access Point" column.
  neighbor_discovery:
    enabled: true
    interfaces:
      - lan
      # - opt1
      # - vlan10
    interface_labels:
      lan: "LAN"
      # opt1: "IoT"
      # vlan10: "Servers"
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
| `log_buffer_size` | `500` | In-memory log ring buffer size (lines) |
| `debug_logging` | `false` | Verbose SSH command logging |
| `show_ipv6` | `false` | Show IPv6 addresses in the IP column |
| `ping_interval_minutes` | `5` | How often (minutes) to ICMP-ping discovered clients |
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
  "version": "0.1.3",
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
  package.json        <- single source of truth for version and repository URL
  Dockerfile          <- node:20-alpine; WORKDIR /app; runs src/index.js
  src/
    index.js          <- Express + WebSocket server; reads pkg from ../package.json
    config.js         <- config.yaml loader
    ssh.js            <- SSH client / AP polling
    mqtt.js           <- MQTT bridge
    opnsense.js       <- OPNsense REST + SSH integration
    pinger.js         <- ICMP reachability checks
    db.js             <- SQLite persistence
    logger.js         <- ring-buffer logger with WebSocket broadcaster

frontend/
  src/
    App.jsx           <- WebSocket client; reads version + repoUrl from WS payload
    components/
      ClientTable.jsx <- client list with sort, filter, AP pills, column toggle
      LogView.jsx     <- live log view (full viewport height)
      StatusBar.jsx   <- AP status overview
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
