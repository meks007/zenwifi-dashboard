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
- **Live log view** (server log ring buffer)

### Mesh-aware behavior (AiMesh)

- **Mesh node detection** using the master router's `/tmp/aplist.json` and `/tmp/relist.json`
- Backhaul / infrastructure entries are:
  - Collapsed into a single row per physical mesh node
  - Shown with a distinct visual style
  - **Not disconnectable**

### Client control

- Disconnect (kick) regular clients from the UI
- Disconnect clients via MQTT (`{prefix}/clients/{mac}/disconnect`)

### MQTT integration

- LWT bridge state (`{prefix}/bridge/state` retained)
- Per-client state + info topics (retained)
- Per-AP status topics (retained)
- Global stats topic for total online clients (retained)

### Resilience

- **AP failure resilience**: an AP's client list is only cleared after **3 consecutive poll failures**
- Configurable poll interval, log ring buffer size, and debug logging

### Optional OPNsense DHCP enrichment

If configured, the backend enriches clients using OPNsense DHCP data:

- **Dynamic leases** via OPNsense REST API (IP, hostname, lease end, lease type)
- **Static reservations** via:
  - Kea reservations endpoint (if available), otherwise
  - SSH read of `/conf/config.xml` static mappings

The enriched data is exposed under `client.dhcp.*` and (for non-mesh clients) the dashboard will promote DHCP hostname/IP to the top-level fields when present.

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

# Size of the in-memory log ring buffer (number of log lines kept).
# Older entries are dropped when the buffer is full. Default: 500.
log_buffer_size: 500

# Set to true to log every SSH command and its output (very verbose).
debug_logging: false

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
  # Driver is auto-detected via SSH probe; override only if detection fails.
  - name: "Bedroom"
    host: 192.168.1.3
    ssh_port: 22
    username: admin
    password: secret
    # driver: atheros

# ---------------------------------------------------------------------------
# OPNsense DHCP integration (optional)
# ---------------------------------------------------------------------------
# When configured, the backend queries OPNsense for:
# - Dynamic leases : via REST API -> client.dhcp.ip / hostname / leaseEnds
# - Static mappings : via SSH -> client.dhcp.description / hasReservation
#
# OPNsense is a separate box with its own IP and credentials.
#
# REST API credentials:
# System -> Access -> Users -> -> API keys
# Required privilege: DHCP: Leases (read-only is sufficient)
#
# SSH credentials (same field names as access_points for consistency):
# System -> Settings -> Administration -> Secure Shell -> enable SSH
# Must connect as root.
# ssh_host defaults to the value of 'host' above if omitted.
#
# Remove this block or leave host empty to disable DHCP enrichment entirely.
# ---------------------------------------------------------------------------
opnsense:
  # --- REST API (leases) ---
  host: 192.168.x.x  # OPNsense IP or hostname
  port: 443          # HTTPS port (default: 443)
  api_key: your-api-key
  api_secret: your-api-secret
  verify_ssl: false  # Set to true if OPNsense has a valid/trusted TLS cert

  # --- SSH (static reservations via /conf/config.xml) ---
  ssh_host: 192.168.x.x  # defaults to 'host' above if omitted
  ssh_port: 22
  username: root
  password: your-root-password
  # key_path: /run/secrets/opnsense_id_rsa  # path to private key (alternative to password)

  # --- Polling ---
  poll_interval: 60  # How often (seconds) to refresh DHCP data
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
| `log_buffer_size` | `500` | In-memory log ring buffer size (lines) |
| `debug_logging` | `false` | Verbose SSH command logging |
| `access_points[].name` | required | Display name |
| `access_points[].host` | required | AP hostname or IP |
| `access_points[].ssh_port` | `22` | SSH port |
| `access_points[].username` | required | SSH username |
| `access_points[].password` | required | SSH password |
| `access_points[].master` | `false` | Mark exactly one AP as master |
| `access_points[].driver` | auto | `broadcom` or `atheros`; auto-detected if omitted |
| `opnsense.*` | optional | OPNsense DHCP enrichment (see below) |

### Driver detection

The backend probes each AP via SSH to determine whether it uses the Broadcom (`wl`) or Atheros/Qualcomm (`wlanconfig`) wireless driver. The result is cached for the lifetime of the process.

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

### LWT

The broker publishes `offline` to `{prefix}/bridge/state` (retained) if the backend process disconnects unexpectedly. The backend publishes `online` immediately on connect.

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
| Client IPs and RSSI | `cat /tmp/clientlist.json` (master node only) |
| Mesh AP list | `cat /tmp/aplist.json` (master node only) |
| Mesh relay list | `cat /tmp/relist.json` (master node only) |

---

## Mesh Node Handling

On AiMesh setups the master router exposes `/tmp/aplist.json` and `/tmp/relist.json`, which map backhaul radio MAC addresses to their physical node.

The backend reads these once per poll cycle and uses them to:

- Collapse multiple backhaul MACs belonging to the same physical node into a single row
- Tag mesh infrastructure entries with a distinct visual style; they cannot be disconnected from the UI

---

## AP Failure Handling

If an AP cannot be reached via SSH, its last known client list is retained until 3 consecutive poll failures occur. This prevents brief network interruptions from clearing the client list.

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
