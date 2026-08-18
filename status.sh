#!/usr/bin/env bash
# Live view of stations and connected clients (run on the venue box).
set -euo pipefail

curl -s http://127.0.0.1:9997/v3/paths/list | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('STATIONS')
for p in d.get('items', []):
    state = 'LIVE' if p['ready'] else 'idle'
    listeners = len(p.get('readers', []))
    print(f\"  {p['name']:16} {state:5} listeners={listeners}\")
"
echo
curl -s http://127.0.0.1:9997/v3/webrtcsessions/list | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('CLIENTS (web clients appear as 127.0.0.1 via the signaling proxy)')
for s in d.get('items', []):
    role = 'DJ      ' if s.get('state') == 'publish' else 'listener'
    mb_in = s.get('bytesReceived', 0) / 1e6
    mb_out = s.get('bytesSent', 0) / 1e6
    print(f\"  {role} {s.get('path','?'):16} {s.get('remoteAddr','?'):22} in={mb_in:6.1f}MB out={mb_out:6.1f}MB\")
print(f\"total: {d.get('itemCount', 0)} connections\")
"
