#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$SCRIPT_DIR/.runtime"

stop_pid_file() {
  local name="$1"
  local pid_file="$RUNTIME_DIR/${name}.pid"
  if [[ ! -f "$pid_file" ]]; then
    return
  fi

  local pid
  pid="$(cat "$pid_file")"
  if kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      if ! kill -0 "$pid" >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$pid_file"
}

stop_pid_file levels
stop_pid_file web
stop_pid_file mediamtx

echo "Piratensender stopped."
