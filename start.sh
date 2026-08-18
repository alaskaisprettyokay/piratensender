#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$SCRIPT_DIR/.runtime"
MEDIAMTX_BIN="$RUNTIME_DIR/bin/mediamtx"
WEB_PORT="${PIRATENSENDER_WEB_PORT:-8090}"

if [[ -f "$SCRIPT_DIR/.env.local-node" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env.local-node"
  set +a
fi

detect_lan_ip() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    local interface
    interface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')"
    if [[ -n "$interface" ]]; then
      ipconfig getifaddr "$interface" 2>/dev/null || true
    fi
  else
    hostname -I 2>/dev/null | awk '{print $1}'
  fi
}

LAN_IP="${PIRATENSENDER_LAN_IP:-$(detect_lan_ip)}"
if [[ -z "$LAN_IP" ]]; then
  echo "Could not detect the laptop LAN IP." >&2
  echo "Set PIRATENSENDER_LAN_IP in .env.local-node, for example 192.168.50.2." >&2
  exit 1
fi

if [[ ! -x "$MEDIAMTX_BIN" ]]; then
  echo "MediaMTX is not installed. Run ./install.sh first." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required to serve the Piratensender UI." >&2
  exit 1
fi

"$SCRIPT_DIR/stop.sh" >/dev/null 2>&1 || true
mkdir -p "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR"

sed "s/__LAN_IP__/$LAN_IP/g" "$SCRIPT_DIR/mediamtx.template.yml" > "$RUNTIME_DIR/mediamtx.yml"

# The session log is the event's history (attendance, stations, stats) —
# archive it instead of truncating.
if [[ -s "$RUNTIME_DIR/mediamtx.log" ]]; then
  mv "$RUNTIME_DIR/mediamtx.log" "$RUNTIME_DIR/mediamtx-$(date +%Y%m%d-%H%M%S).log"
fi

nohup "$MEDIAMTX_BIN" "$RUNTIME_DIR/mediamtx.yml" > "$RUNTIME_DIR/mediamtx.log" 2>&1 &
echo $! > "$RUNTIME_DIR/mediamtx.pid"

media_ready=false
for _ in $(seq 1 40); do
  if curl -sS -o /dev/null "http://127.0.0.1:8889/" >/dev/null 2>&1; then
    media_ready=true
    break
  fi
  sleep 0.25
done
if [[ "$media_ready" != "true" ]]; then
  echo "MediaMTX did not start. See $RUNTIME_DIR/mediamtx.log" >&2
  "$SCRIPT_DIR/stop.sh" >/dev/null 2>&1 || true
  exit 1
fi

# Self-signed cert so additional DJ laptops get a secure context for
# Chrome audio capture (they click through the browser warning once).
TLS_CERT="$RUNTIME_DIR/venue-cert.pem"
TLS_KEY="$RUNTIME_DIR/venue-key.pem"
if [[ ! -f "$TLS_CERT" || ! -f "$TLS_KEY" ]]; then
  openssl req -x509 -newkey rsa:2048 -keyout "$TLS_KEY" -out "$TLS_CERT" \
    -days 825 -nodes -subj "/CN=piratensender" >/dev/null 2>&1 || true
fi

LAN_IP="$LAN_IP" PORT="$WEB_PORT" TLS_CERT="$TLS_CERT" TLS_KEY="$TLS_KEY" \
  PIRATENSENDER_ALLOW_REMOTE_BROADCAST="${PIRATENSENDER_ALLOW_REMOTE_BROADCAST:-1}" \
  nohup node "$SCRIPT_DIR/server.mjs" > "$RUNTIME_DIR/web.log" 2>&1 &
echo $! > "$RUNTIME_DIR/web.pid"

# Station level meters (VU bars on the listener page); needs ffmpeg.
if command -v ffmpeg >/dev/null 2>&1; then
  nohup node "$SCRIPT_DIR/levels.mjs" > "$RUNTIME_DIR/levels.log" 2>&1 &
  echo $! > "$RUNTIME_DIR/levels.pid"
fi

web_ready=false
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${WEB_PORT}/health" >/dev/null 2>&1; then
    web_ready=true
    break
  fi
  sleep 0.25
done
if [[ "$web_ready" != "true" ]]; then
  echo "Piratensender UI did not start. See $RUNTIME_DIR/web.log" >&2
  "$SCRIPT_DIR/stop.sh" >/dev/null 2>&1 || true
  exit 1
fi

listener_url="http://${LAN_IP}:${WEB_PORT}/"
broadcast_url="http://127.0.0.1:${WEB_PORT}/broadcast"
dj_url="https://${LAN_IP}:8443/broadcast"

# mDNS name survives IP changes across networks; prefer it when available.
MDNS_HOST=""
if command -v scutil >/dev/null 2>&1; then
  MDNS_HOST="$(scutil --get LocalHostName 2>/dev/null | tr '[:upper:]' '[:lower:]')"
fi
if [[ -n "$MDNS_HOST" ]]; then
  listener_url="http://${MDNS_HOST}.local:${WEB_PORT}/"
  dj_url="https://${MDNS_HOST}.local:8443/broadcast"
fi

echo
echo "PIRATENSENDER IS READY"
echo "Broadcaster (open on this laptop): $broadcast_url"
echo "DJ laptops (other machines):       $dj_url  (accept the cert warning once, name your station, go live)"
echo "Listener (phones on event Wi-Fi):  $listener_url"
if [[ -n "$MDNS_HOST" ]]; then
  echo "Listener fallback (older Android): http://${LAN_IP}:${WEB_PORT}/"
fi
echo "Keep this laptop wired to the event router. Disable AP/client isolation."

if command -v qrencode >/dev/null 2>&1; then
  qrencode -o "$RUNTIME_DIR/listener-qr.png" -s 8 -m 2 "$listener_url"
  qrencode -o "$RUNTIME_DIR/dj-qr.png" -s 8 -m 2 "$dj_url"
  echo "Listener QR PNG: $RUNTIME_DIR/listener-qr.png"
  echo "DJ QR PNG:       $RUNTIME_DIR/dj-qr.png"
  echo
  qrencode -t ANSIUTF8 "$listener_url"
fi
