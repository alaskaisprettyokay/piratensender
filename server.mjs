import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./web/', import.meta.url));
const port = Number(process.env.PORT || 8090);
const tlsPort = Number(process.env.TLS_PORT || 8443);
const lanIp = process.env.LAN_IP;
const mediamtxBase = 'http://127.0.0.1:8889';
const mediamtxApi = 'http://127.0.0.1:9997';
const allowRemoteBroadcast = ['1', 'true', 'yes'].includes(
  String(process.env.PIRATENSENDER_ALLOW_REMOTE_BROADCAST || '').toLowerCase(),
);

if (!lanIp) {
  throw new Error('LAN_IP is required');
}

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function isLoopback(address = '') {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function clientIsLoopback(request) {
  const forwardedFor = request.headers['x-forwarded-for'];
  const clientAddress = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : typeof forwardedFor === 'string'
      ? forwardedFor.split(',')[0].trim()
      : request.socket.remoteAddress;

  return isLoopback(clientAddress);
}

function isSecureRequest(request) {
  const forwardedProto = request.headers['x-forwarded-proto'];
  const forwardedValues = Array.isArray(forwardedProto)
    ? forwardedProto
    : typeof forwardedProto === 'string'
      ? forwardedProto.split(',')
      : [];

  return Boolean(request.socket.encrypted)
    || forwardedValues.some((value) => value.trim().toLowerCase() === 'https');
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

// Proxy WHIP/WHEP signaling to MediaMTX so every page is same-origin
// (works over both HTTP and HTTPS with no mixed-content issues).
// The media itself flows directly over UDP 443 or TCP 8189.
async function proxyMediamtx(request, response, url) {
  if (!['POST', 'DELETE', 'PATCH'].includes(request.method)) {
    response.writeHead(405);
    response.end();
    return;
  }
  const isPublishRequest = request.method === 'POST' && url.pathname.endsWith('/whip');
  if (isPublishRequest && !clientIsLoopback(request) && !allowRemoteBroadcast) {
    sendJson(response, 403, { error: 'Remote broadcasting is disabled on this node.' });
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    const upstream = await fetch(mediamtxBase + url.pathname.slice('/mtx'.length), {
      method: request.method,
      headers: request.headers['content-type'] ? { 'Content-Type': request.headers['content-type'] } : {},
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    const headers = { 'Cache-Control': 'no-store' };
    const contentType = upstream.headers.get('content-type');
    if (contentType) headers['Content-Type'] = contentType;
    const location = upstream.headers.get('location');
    if (location) headers.Location = location.startsWith('/') ? `/mtx${location}` : location;
    response.writeHead(upstream.status, headers);
    response.end(body);
  } catch {
    sendJson(response, 502, { error: 'Local media relay is unreachable.' });
  }
}

const server = async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    sendJson(response, 200, { ok: true, lanIp });
    return;
  }

  if (url.pathname === '/config.json') {
    sendJson(response, 200, {
      streamName: 'piratensender',
      allowRemoteBroadcast: allowRemoteBroadcast || clientIsLoopback(request),
    });
    return;
  }

  if (url.pathname.startsWith('/mtx/')) {
    await proxyMediamtx(request, response, url);
    return;
  }

  if (url.pathname === '/channels') {
    try {
      const upstream = await fetch(`${mediamtxApi}/v3/paths/list`);
      const data = await upstream.json();
      // Station levels measured on the box by levels.mjs (may be absent).
      let levels = {};
      try {
        levels = JSON.parse(readFileSync(new URL('./.runtime/levels.json', import.meta.url), 'utf8'));
      } catch { /* meter daemon not running */ }
      sendJson(response, 200, {
        channels: (data.items || []).map((path) => ({
          name: path.name,
          ready: path.ready,
          // Count only real WebRTC listeners. Level meters read via RTSP and
          // must not inflate the count.
          listeners: (path.readers || []).filter((r) => r.type === 'webRTCSession').length,
          level: typeof levels[path.name] === 'number' ? levels[path.name] : null,
        })),
      });
    } catch {
      sendJson(response, 502, { error: 'Local media relay is unreachable.' });
    }
    return;
  }

  // The broadcaster needs a secure context for getUserMedia: loopback on the
  // event laptop, or HTTPS (self-signed) for additional DJ laptops on the LAN.
  if (url.pathname === '/broadcast' && !clientIsLoopback(request)) {
    if (!allowRemoteBroadcast) {
      response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Remote broadcasting is disabled on this node.');
      return;
    }
    if (!isSecureRequest(request)) {
      response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(`Open the broadcaster on the event laptop (http://127.0.0.1:${port}/broadcast) or from a DJ laptop over HTTPS (https://${lanIp}:${tlsPort}/broadcast).`);
      return;
    }
  }

  const requestedPath = url.pathname === '/'
    ? 'index.html'
    : url.pathname === '/broadcast'
      ? 'broadcast.html'
      : url.pathname.replace(/^\/+/, '');
  const normalizedPath = normalize(requestedPath);
  if (normalizedPath.startsWith('..')) {
    response.writeHead(400);
    response.end();
    return;
  }

  try {
    const body = await readFile(join(root, normalizedPath));
    response.writeHead(200, {
      'Content-Type': mimeTypes[extname(normalizedPath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; media-src 'self' blob:; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
};

const servers = [http.createServer(server)];
servers[0].listen(port, '0.0.0.0', () => {
  console.log(`Piratensender listening at http://${lanIp}:${port}`);
});

// HTTPS gives additional DJ laptops the secure context Chrome requires for
// getUserMedia. Cert is self-signed and generated by start.sh.
if (process.env.TLS_CERT && process.env.TLS_KEY) {
  try {
    const tlsServer = https.createServer({
      cert: readFileSync(process.env.TLS_CERT),
      key: readFileSync(process.env.TLS_KEY),
    }, server);
    tlsServer.listen(tlsPort, '0.0.0.0', () => {
      console.log(`DJ broadcaster (other laptops) at https://${lanIp}:${tlsPort}/broadcast`);
    });
    servers.push(tlsServer);
  } catch (error) {
    console.error(`HTTPS broadcaster disabled: ${error.message}`);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const active of servers) active.close();
    process.exit(0);
  });
}
