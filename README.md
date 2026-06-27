# Zenwifi Dashboard

A self-hosted web dashboard for Asus Zenwifi XT8 access points running Merlin firmware.

## Features

- Consolidated client list across all access points, updated in real time via WebSocket
- Disconnect clients from the UI or via MQTT
- MQTT publishing of all client states, AP associations and roaming events
- YAML configuration for access points and MQTT broker
- Docker Compose deployment

---

## Quick Start

### 1. Configure

Copy the example config and edit it:

```bash
cp config.example.yaml config.yaml
```

Edit `config.yaml` with your AP and MQTT details.

### 2. Run

```bash
docker compose up -d
```

Open http://localhost:3000 in your browser.

---

## MQTT Topic Structure

| Topic | Direction | Payload | Retained |
|---|---|---|---|
| `{prefix}/clients/{mac}/state` | Publish | `online` / `offline` | yes |
| `{prefix}/clients/{mac}/ap` | Publish | AP name string | yes |
| `{prefix}/clients/{mac}/info` | Publish | `{"hostname":"...","ip":"...","rssi":...}` | yes |
| `{prefix}/clients/{mac}/disconnect` | Subscribe | any | - |
| `{prefix}/status` | Publish | Full JSON client array | yes |

### Disconnect a client via MQTT

Publish any payload to:
```
zenwifi/clients/aa:bb:cc:dd:ee:ff/disconnect
```

---

## SSH Commands Used (Merlin Firmware)

| Purpose | Command |
|---|---|
| List wireless interfaces | `nvram get wl_ifnames` |
| List associated clients | `wl -i {iface} assoclist` |
| Get client RSSI | `wl -i {iface} rssi {mac}` |
| Kick client | `wl -i {iface} deauthenticate {mac}` |
| ARP table | `cat /proc/net/arp` |
| DHCP leases | `cat /tmp/dnsmasq.leases` |

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

---

## Contributors

- [meks007](https://github.com/meks007) - Project owner
- [Hueck Folien AI](https://github.com/langdock) - Architecture & initial implementation
