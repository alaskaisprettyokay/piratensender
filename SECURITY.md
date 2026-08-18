# Security

Piratensender is a local-first radio node for trusted event networks and
controlled hosted demos. It is not hardened as a public multi-tenant
broadcasting service.

## Supported deployment

- Run the node on a venue LAN or a controlled server.
- Let listeners reach the public listener page if desired.
- Limit publisher access to trusted DJs and operators.

## Publishing access

Local venue nodes launched with `./start.sh` allow remote browser publishing on
the event LAN so additional DJ laptops can join. When the web service is run
directly, remote browser publishing is disabled unless
`PIRATENSENDER_ALLOW_REMOTE_BROADCAST=1` is set.

Publishing is open to anyone who can reach the enabled ingest endpoints:

- Browser broadcaster: `/broadcast` -> `/mtx/<station>/whip`
- OBS/RTMP: TCP `1935`
- WebRTC signaling: TCP `8889`
- WebRTC media: UDP `443` and TCP `8189`

The MediaMTX config accepts dynamic stations with `all_others`, so a stream
key becomes a station name. This is useful at events, but unsafe for an open
internet endpoint without an external control layer.

Before exposing a public publisher endpoint, set
`PIRATENSENDER_ALLOW_REMOTE_BROADCAST=1` deliberately and add one of:

- firewall rules limiting publisher ports to known IPs,
- reverse-proxy authentication for browser/WHIP publishing,
- MediaMTX authentication hooks,
- a station allowlist plus per-station publish keys.

## Secrets

This repo should not contain provider tokens, private keys, production
certificates, or `.env.local-node`. Runtime files live under `.runtime/`, which
is ignored by git.

## Reporting

For now, report issues privately to the repository owner. Please do not publish
an exploit against a live demo node.
