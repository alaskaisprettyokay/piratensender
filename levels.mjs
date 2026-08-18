// Meters every live station once, on the box: reads the loopback RTSP tap
// with ffmpeg's ebur128 loudness filter and writes momentary levels to
// .runtime/levels.json, which server.mjs merges into /channels. Phones get
// per-station VU data in the poll they already make — no extra streams.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('./.runtime/levels.json', import.meta.url));
const meters = new Map(); // station -> { proc, db }

function startMeter(name) {
  const proc = spawn('ffmpeg', [
    '-hide_banner', '-nostats',
    '-rtsp_transport', 'tcp',
    '-i', `rtsp://127.0.0.1:8554/${name}`,
    '-filter:a', 'ebur128=peak=none',
    '-f', 'null', '-',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const meter = { proc, db: -70 };
  meters.set(name, meter);

  let buffer = '';
  proc.stderr.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const match = line.match(/M:\s*(-inf|-?[\d.]+)/);
      if (match) meter.db = match[1] === '-inf' ? -70 : Number(match[1]);
    }
  });
  proc.on('exit', () => {
    if (meters.get(name) === meter) meters.delete(name);
  });
}

async function reconcile() {
  let ready = [];
  try {
    const response = await fetch('http://127.0.0.1:9997/v3/paths/list');
    ready = ((await response.json()).items || []).filter((p) => p.ready).map((p) => p.name);
  } catch {
    return; // MediaMTX briefly unavailable; keep existing meters
  }
  for (const name of ready) if (!meters.has(name)) startMeter(name);
  for (const [name, meter] of meters) {
    if (!ready.includes(name)) {
      meter.proc.kill('SIGKILL');
      meters.delete(name);
    }
  }
}

void reconcile();
setInterval(reconcile, 3000);

setInterval(() => {
  const out = {};
  for (const [name, meter] of meters) out[name] = meter.db;
  void writeFile(OUT, JSON.stringify(out)).catch(() => {});
}, 500);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const meter of meters.values()) meter.proc.kill('SIGKILL');
    process.exit(0);
  });
}
