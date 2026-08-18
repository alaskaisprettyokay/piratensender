#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$SCRIPT_DIR/.runtime"
BIN_DIR="$RUNTIME_DIR/bin"
MEDIAMTX_VERSION="${PIRATENSENDER_MEDIAMTX_VERSION:-v1.20.0}"

for command_name in curl tar node; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
done

os_name="$(uname -s)"
case "$os_name" in
  Darwin) asset_os="darwin" ;;
  Linux) asset_os="linux" ;;
  *) echo "Unsupported operating system: $os_name" >&2; exit 1 ;;
esac

machine="$(uname -m)"
case "$machine" in
  arm64|aarch64) asset_arch="arm64" ;;
  x86_64|amd64) asset_arch="amd64" ;;
  *) echo "Unsupported CPU architecture: $machine" >&2; exit 1 ;;
esac

mkdir -p "$BIN_DIR"

if [[ ! -x "$BIN_DIR/mediamtx" ]]; then
  echo "Finding MediaMTX ${MEDIAMTX_VERSION} for ${asset_os}/${asset_arch}…"
  asset_url="$({ curl -fsSL "https://api.github.com/repos/bluenviron/mediamtx/releases/tags/${MEDIAMTX_VERSION}"; } | \
    ASSET_SUFFIX="_${asset_os}_${asset_arch}.tar.gz" node -e '
      let body = "";
      process.stdin.on("data", (chunk) => { body += chunk; });
      process.stdin.on("end", () => {
        const release = JSON.parse(body);
        const asset = release.assets.find((item) => item.name.endsWith(process.env.ASSET_SUFFIX));
        if (!asset) process.exit(2);
        process.stdout.write(asset.browser_download_url);
      });
    ')"

  if [[ -z "$asset_url" ]]; then
    echo "Could not find a compatible MediaMTX ${MEDIAMTX_VERSION} release asset." >&2
    exit 1
  fi

  archive="$RUNTIME_DIR/mediamtx.tar.gz"
  extract_dir="$RUNTIME_DIR/extract"
  mkdir -p "$extract_dir"
  curl -fL "$asset_url" -o "$archive"
  tar -xzf "$archive" -C "$extract_dir"
  mv "$extract_dir/mediamtx" "$BIN_DIR/mediamtx"
  chmod +x "$BIN_DIR/mediamtx"
  rm -rf "$extract_dir" "$archive"
fi

echo "MediaMTX installed: $BIN_DIR/mediamtx"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo
  echo "FFmpeg is optional and enables station level metering."
  if [[ "$asset_os" == "darwin" ]] && command -v brew >/dev/null 2>&1; then
    echo "Install it before the event with: brew install ffmpeg"
  else
    echo "Install ffmpeg with your system package manager if you want level meters."
  fi
fi

if ! command -v qrencode >/dev/null 2>&1; then
  echo
  echo "qrencode is optional; without it the launcher still prints the listener URL."
  if [[ "$asset_os" == "darwin" ]] && command -v brew >/dev/null 2>&1; then
    echo "Install it with: brew install qrencode"
  fi
fi

echo
echo "Installation complete. Run: ./start.sh"
