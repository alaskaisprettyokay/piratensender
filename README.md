# Piratensender

Piratensender is a local-first party radio node: one box or server where
anyone creates a station and anyone listens. It can run as a hosted demo on a
cloud server, or as a venue node on a local event network.

The app can carry a visual partner mark, but local playback does not call back
to upstream infrastructure.

Live demo: `https://piratensender.subcult.music/`

Current status: working demo for trusted event networks and controlled hosted
tests. It is not hardened as an open public broadcasting service.

## Deployment modes

### Hosted server

Run Piratensender on a VPS or dedicated server when you want a public demo URL
or remote RTMP ingest from OBS. Put the web UI behind a normal HTTPS reverse
proxy, keep the MediaMTX API private on loopback, and decide deliberately which
publisher ports are reachable from the internet.

In hosted mode, listeners can use the public HTTPS URL. DJs can publish through
these endpoints only when you intentionally expose/protect them:

- the browser broadcaster at `/broadcast`,
- OBS/RTMP on TCP `1935`.

Remote browser publishing is disabled by default when the web service is run
directly. Enable it only for a protected demo or trusted network:

```bash
PIRATENSENDER_ALLOW_REMOTE_BROADCAST=1 node server.mjs
```

The hosted demo can safely be listener-only.

### Venue node

Run Piratensender on a laptop or small box at an event when you want local
playback that survives internet loss. The broadcaster machine joins the event
router, DJs publish over the LAN, and phones listen from the same network.

## Signal flow

```text
CDJs -> DJ mixer master USB -> Chrome broadcaster -> MediaMTX
                         OBS -> RTMP ingest --------^
                                                    `-> phones/browsers (WebRTC/WHEP)
```

Local playback does not depend on any upstream platform. Audio is
stereo Opus at up to 256 kbps (music-tuned; Chrome's speech defaults are
overridden), and MediaMTX forwards it without transcoding.

## Security model

Piratensender is built for trusted event networks and controlled demos. By
default, venue-mode publishing is trust-based: anyone on the event LAN who can
reach an enabled publisher endpoint can publish a station. Do not expose TCP
1935, TCP 8889, TCP 8443, or UDP 443 to the public internet unless you add
authentication, an allowlist, or a firewall in front of the node.

Listeners can stay public, but publishing should be limited to trusted DJs,
trusted LAN users, or a separately protected public endpoint. See
`SECURITY.md` before exposing a hosted server or running outside a trusted LAN.

### Multiple DJ setups

Additional DJ laptops on the event LAN open
`https://<laptop-ip>:8443/broadcast` (self-signed cert — accept the warning
once), type a station name, pick their audio interface, and go live.
Stations are created on first publish; nothing to configure. Station names
are unique — a name that is already live is rejected, so nobody can hijack a
running set; handover is stop, then go live. When more than one station is
live, the listener page shows a picker.

### OBS / RTMP ingest

RTMP publishes into the same station list as the browser broadcaster:

```text
Server: rtmp://your-host.example:1935
Stream Key: test
```

That creates station `test`, which appears on the listener page while OBS is
streaming. Use a different stream key for a different station.

## What you need

For hosted server mode:

- Linux server with Node.js
- public DNS + HTTPS reverse proxy for the web UI
- MediaMTX (installed by this kit)
- firewall rules for whichever publisher ports you intentionally expose

For venue node mode:

- MacBook (Apple Silicon or Intel) with Chrome and Node.js
- DJ mixer with a class-compliant USB master/record output, or REC/BOOTH OUT into a USB audio interface
- Dedicated Wi-Fi router/access point with client/AP isolation disabled
- Ethernet cable or adapter from the laptop to the router
- MediaMTX (installed by this kit)
- `qrencode` optionally generates the listener QR PNG

## Prepare before arriving

```bash
cd piratensender
./install.sh
cp .env.example .env.local-node
```

On macOS with Homebrew:

```bash
brew install ffmpeg qrencode
```

FFmpeg is optional and is used by the level meter. `qrencode` is optional.

## Venue configuration

1. Connect the dedicated router and disable AP/client isolation, guest mode, and captive portal.
2. Connect the broadcast laptop to the router by Ethernet. Phones join the router's Wi-Fi.
3. Connect the mixer USB master output (or USB audio interface) to the laptop.
4. Start the node:

   ```bash
   ./start.sh
   ```

5. On the laptop, open the printed broadcaster URL: `http://127.0.0.1:8090/broadcast`.
6. Click **Allow audio access / refresh**, select the mixer/interface, and start the local broadcast.
7. Scan the generated listener QR from a phone on the event Wi-Fi, tap **Listen live**, and confirm audio.

The local URL is based on the laptop's LAN IP. If automatic detection selects the wrong interface, add this to `.env.local-node`:

```dotenv
PIRATENSENDER_LAN_IP=192.168.50.2
```

## Ports and firewall

- TCP 8090: local web UI
- TCP 8443: DJ broadcaster for additional laptops (HTTPS, self-signed)
- TCP 8889: WHIP/WHEP signaling (also proxied same-origin under /mtx/)
- TCP 1935: RTMP ingest for OBS
- UDP 443: WebRTC media (preferred for public demos)
- TCP 8189: WebRTC fallback
- TCP 8554: local RTSP

In venue node mode, allow incoming connections for MediaMTX and Node when macOS
asks. No router port-forwarding is required or desired.

In hosted server mode, keep TCP 9997 and TCP 8554 private. Only expose the web
UI and the publisher/listener ports you actually intend to support.

## Audio checks

- Mixer/interface should negotiate 48 kHz and two channels.
- Disable laptop microphone, desktop audio, echo cancellation, noise suppression, and automatic gain.
- Keep peaks below clipping on the mixer/interface. The page meter is a safety indicator, not a calibrated broadcast meter.
- Test with headphones. Do not play unsynchronized phone audio through speakers beside the PA.

## Operations

```bash
./stop.sh
tail -f .runtime/mediamtx.log
tail -f .runtime/web.log
```

If the internet drops in a LAN deployment, local listeners remain connected.

## Developer smoke test

With the node running and the repo's Playwright dependency installed:

```bash
node test/smoke.mjs
```

The test publishes a synthetic browser audio device over WHIP, subscribes over WHEP, and verifies that MediaMTX reports a ready path.
