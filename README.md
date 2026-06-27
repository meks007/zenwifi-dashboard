# Zenwifi Dashboard

A self-hosted dashboard for managing multiple Asus Zenwifi XT8 access points running Merlin firmware over SSH.

## Features

- Consolidated client list across all configured access points
- Real-time updates via WebSocket (no manual refresh needed)
- MAC-centric identity: hostname and IP are additional attributes
- MAC vendor/manufacturer lookup using the IEEE OUI database (offline, via `oui-data`)
- Disconnect clients from the UI or via MQTT
- MQTT integration: publishes all client states with retained messages; accepts disconnect commands per client topic
- Frontend log viewer: live streaming log panel with level filtering and search
- Configurable poll interval, log buffer size, and debug logging via config file
- Docker deployment via Docker Compose

---

## Interface Discovery

On Merlin/Asus XT8 hardware, wireless clients associate to BSS interfaces named `wl0.1`, `wl1.1`, `wl2.1` etc. The dashboard discovers these automatically at each poll cycle using:

```sh
ip -o link show | awk -F': ' '{print $2}' | grep -E '^wl'
```

Each discovered `wl*` interface is validated by probing `wl assoclist` before use. If discovery fails entirely, the backend falls back to a static list `[eth4, eth5, eth6]`.

Note: `nvram get wl_ifnames` is not used. It only returns physical radio interfaces (`eth4/5/6`) which do not surface associated clients on XT8 hardware.

---

## Configuration

Copy `config.example.yaml` to `config.yaml` and adjust to your environment:

```yaml
mqtt:
  host: 192.168.1.10
  port: 1883
  username: myuser
  password: mypassword
  topic_prefix: zenwifi

# How often to poll all APs (seconds). Each poll opens SSH connections
# and runs multiple commands per AP. Keep this >= 30.
polling_interval_seconds: 30

# Number of log lines kept in the in-memory ring buffer.
log_buffer_size: 500

# Log every SSH command and its output (very verbose).
debug_logging: false

access_points:
  - name: "Living Room"
    host: 192.168.1.1
    ssh_port: 22
    username: admin
    password: secret
  - name: "Office"
    host: 192.168.1.2
    ssh_port: 22
    username: admin
    password: secret
```

### Config reference

| Key | Default | Description |
|---|---|---|
| `mqtt.host` | (required) | MQTT broker hostname or IP |
| `mqtt.port` | `1883` | MQTT broker port |
| `mqtt.username` | (required) | MQTT username |
| `mqtt.password` | (required) | MQTT password |
| `mqtt.topic_prefix` | `zenwifi` | Root topic prefix |
| `polling_interval_seconds` | `30` | AP poll interval in seconds |
| `log_buffer_size` | `500` | In-memory log ring buffer size (lines) |
| `debug_logging` | `false` | Verbose SSH command logging |
| `access_points[].name` | (required) | Display name for the AP |
| `access_points[].host` | (required) | AP hostname or IP |
| `access_points[].ssh_port` | `22` | SSH port |
| `access_points[].username` | (required) | SSH username |
| `access_points[].password` | (required) | SSH password |

---

## MQTT Topic Structure

All topics are prefixed with `mqtt.topic_prefix` (default: `zenwifi`).

| Topic | Retained | Description |
|---|---|---|
| `zenwifi/clients/<mac>/state` | yes | `online` or `offline` |
| `zenwifi/clients/<mac>/ap` | yes | AP name the client is currently associated with |
| `zenwifi/clients/<mac>/info` | yes | JSON: `{ mac, ip, hostname, rssi, iface, vendor }` |
| `zenwifi/status` | yes | JSON: full consolidated client list and AP status |
| `zenwifi/clients/<mac>/disconnect` | no | Publish any payload to kick this client |

### Example: disconnect a client via MQTT

```
mosquitto_pub -t zenwifi/clients/aa:bb:cc:dd:ee:ff/disconnect -m 1
```

---

## SSH Commands Used

The backend opens a fresh SSH connection per command. Commands run on each AP per poll cycle:

| Command | Purpose |
|---|---|
| `ip -o link show ... grep wl` | Discover wireless BSS interfaces |
| `wl -i <iface> assoclist` | List associated client MACs per interface |
| `wl -i <iface> rssi <mac>` | Signal strength per client |
| `cat /proc/net/arp` | MAC-to-IP mapping |
| `cat /tmp/dnsmasq.leases` | Hostname resolution |
| `wl -i <iface> deauthenticate <mac>` | Disconnect a client |

---

## Running with Docker

```bash
cp config.example.yaml config.yaml
# edit config.yaml

docker compose up -d
```

The frontend is served on **port 3000**. The backend API and WebSocket run on **port 3001** (internal, proxied by the frontend container).

---

## Development

**Backend**

```bash
cd backend
npm install
node src/index.js
```

**Frontend**

```bash
cd frontend
npm install
npm run dev
```

The Vite dev server proxies `/api` and WebSocket connections to `http://localhost:3001`.

---

## Contributors

- [meks007](https://github.com/meks007) - Project owner
- Hueck Folien AI - Architecture and implementation
