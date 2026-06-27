# Zenwifi Dashboard

A self-hosted web dashboard for Asus ZenWifi access points running Merlin or stock Asus firmware.

Supports multi-AP mesh setups (e.g. XT8 AiMesh) as well as standalone APs with Broadcom (wl) or Atheros/Qualcomm (wlanconfig) wireless drivers.

## Features

- Consolidated, real-time client list across all access points (WebSocket push)
- Per-client details: MAC, vendor (OUI lookup), hostname, IP, AP, interface, RSSI, TX/RX bytes
- Mesh node detection - backhaul nodes shown in a distinct style, not disconnectable
- Disconnect clients from the UI or via MQTT
- MQTT integration with LWT bridge state, per-client state/info topics, AP status and global stats
- AP failure resilience - client list is only cleared after 3 consecutive poll failures
- Configurable poll interval, log ring buffer size and debug logging
- Docker Compose deployment

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
mqtt:
  host: 192.168.1.10
  port: 1883
  username: myuser
  password: mypassword
  topic_prefix: zenwifi

polling_interval_seconds: 30
log_buffer_size: 500
debug_logging: false

access_points:
  - name: "Living Room"
    host: 192.168.1.1
    ssh_port: 22
    username: admin
    password: secret
    master: true
    # driver: broadcom   # optional override: broadcom | atheros

  - name: "Office"
    host: 192.168.1.2
    username: admin
    password: secret

  - name: "Bedroom"
    host: 192.168.1.3
    username: admin
    password: secret
```

### Config reference

| Key | Default | Description |
|---|---|---|
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

### Driver detection

The backend probes each AP via SSH to determine whether it uses the Broadcom (`wl`) or Atheros/Qualcomm (`wlanconfig`) wireless driver. The result is cached for the lifetime of the process. Set `driver:` explicitly if auto-detection fails.

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

```
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

On AiMesh setups the master router exposes `/tmp/aplist.json` and `/tmp/relist.json`, which map all backhaul radio MAC addresses to their physical node. The backend reads these once per poll cycle and uses them to:

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
