import { createWebRtcSession, deleteWebRtcSession, loadConfig, preferOpus } from './common.js';

const button = document.querySelector('#listen-button');
const audio = document.querySelector('#audio');
const message = document.querySelector('#message');
const statusLabel = document.querySelector('#status-label');
const volume = document.querySelector('#volume');

let peerConnection = null;
let sessionUrl = null;
let retryTimer = null;
let stoppedByUser = false;
let channel = new URLSearchParams(location.search).get('ch') || null;
let audioContext = null;
let gainNode = null;

function setState(state, detail) {
  document.body.dataset.state = state;
  statusLabel.textContent = state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting' : 'Signal ready';
  message.textContent = detail;
  button.textContent = state === 'live' ? 'Disconnect' : state === 'connecting' ? 'Connecting…' : 'Listen live';
  button.disabled = state === 'connecting';
}

async function disconnect(userInitiated = true) {
  stoppedByUser = userInitiated;
  window.clearTimeout(retryTimer);
  retryTimer = null;
  await deleteWebRtcSession(sessionUrl);
  sessionUrl = null;
  peerConnection?.close();
  peerConnection = null;
  gainNode?.disconnect();
  gainNode = null;
  audio.srcObject = null;
  if (userInitiated) setState('idle', 'Tap once to connect.');
}

async function connect() {
  stoppedByUser = false;
  setState('connecting', 'Joining the room signal…');
  try {
    const config = await loadConfig();
    // No explicit channel chosen: prefer the default, but if it's idle and
    // something else is live, follow the music instead of erroring.
    if (!channel) {
      try {
        const listResponse = await fetch('/channels', { cache: 'no-store' });
        const live = ((await listResponse.json()).channels || []).filter((c) => c.ready);
        if (live.length > 0 && !live.some((c) => c.name === config.streamName)) {
          channel = live[0].name;
          renderedChannels = '';
          renderChannels(live);
        }
      } catch { /* fall through to the default channel */ }
    }
    const pc = new RTCPeerConnection();
    peerConnection = pc;
    const transceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
    preferOpus(transceiver);

    pc.addEventListener('track', (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      // Real gain stage: media-element volume is ignored on iOS, and a
      // GainNode gives boost headroom above 100% for quiet streams.
      // The muted element still drives the WebRTC stream; audio reaches
      // the speakers only through the gain graph.
      audio.srcObject = stream;
      audio.muted = true;
      try {
        audioContext = audioContext || new AudioContext();
        void audioContext.resume();
        const source = audioContext.createMediaStreamSource(stream);
        gainNode = audioContext.createGain();
        gainNode.gain.value = Number(volume.value);
        source.connect(gainNode).connect(audioContext.destination);
      } catch {
        audio.muted = false; // no WebAudio: fall back to plain playback
      }
      // Leave the jitter buffer adaptive by default — forcing it small causes
      // audible speed hunting on spiky wifi. ?buffer=0.05 opts into low
      // latency, ?buffer=0.3 adds safety margin on rough networks.
      const bufferParam = new URLSearchParams(location.search).get('buffer');
      if (bufferParam !== null) {
        const target = Number(bufferParam);
        if (Number.isFinite(target) && target >= 0) {
          if ('playoutDelayHint' in transceiver.receiver) transceiver.receiver.playoutDelayHint = target;
          if ('jitterBufferTarget' in transceiver.receiver) transceiver.receiver.jitterBufferTarget = target * 1000;
        }
      }
    });

    pc.addEventListener('connectionstatechange', () => {
      if (pc !== peerConnection) return;
      if (pc.connectionState === 'connected') {
        setState('live', 'Connected to the live broadcast.');
      } else if (['failed', 'disconnected'].includes(pc.connectionState) && !stoppedByUser) {
        setState('waiting', 'Signal interrupted. Reconnecting…');
        window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(() => {
          void disconnect(false).then(connect);
        }, 1500);
      }
    });

    sessionUrl = await createWebRtcSession(`/mtx/${encodeURIComponent(channel || config.streamName)}/whep`, pc);
    await audio.play();
  } catch (error) {
    await disconnect(false);
    setState('waiting', error instanceof Error ? error.message : 'Waiting for the broadcast…');
    if (!stoppedByUser) retryTimer = window.setTimeout(connect, 2000);
  }
}

button.addEventListener('click', () => {
  if (peerConnection) void disconnect(true);
  else void connect();
});

// Stations render as bars with a live level fill (VU) and listener count.
// Bars persist across polls — only their fill/count/active state mutate —
// so a mid-poll tap never lands on a rebuilt element.
const channelList = document.querySelector('#channel-list');
const channelBars = new Map(); // name -> button element
function renderChannels(channels) {
  const live = channels.filter((c) => c.ready);
  for (const [name, bar] of channelBars) {
    if (!live.some((c) => c.name === name)) {
      bar.remove();
      channelBars.delete(name);
    }
  }
  for (const c of live) {
    let bar = channelBars.get(c.name);
    if (!bar) {
      bar = document.createElement('button');
      bar.type = 'button';
      bar.className = 'channel-bar';
      const fill = document.createElement('span');
      fill.className = 'fill';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = c.name;
      const count = document.createElement('span');
      count.className = 'count';
      bar.append(fill, label, count);
      bar.addEventListener('click', () => {
        if (channel === c.name && peerConnection) return;
        channel = c.name;
        renderChannels(live);
        void disconnect(false).then(connect);
      });
      channelList.append(bar);
      channelBars.set(c.name, bar);
    }
    bar.classList.toggle('active', c.name === channel);
    bar.querySelector('.count').textContent = `${c.listeners} listening`;
    // Momentary loudness (LUFS) -> fill percentage: -60 dB floor to 0 dB.
    const db = typeof c.level === 'number' ? c.level : -70;
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    bar.querySelector('.fill').style.width = `${pct}%`;
  }
}
async function pollChannels() {
  try {
    const response = await fetch('/channels', { cache: 'no-store' });
    if (response.ok) renderChannels((await response.json()).channels);
  } catch { /* venue box unreachable; leave UI as-is */ }
}
void pollChannels();
window.setInterval(pollChannels, 1000);
volume.addEventListener('input', () => {
  const value = Number(volume.value);
  if (gainNode) gainNode.gain.value = value;
  else audio.volume = Math.min(1, value);
});
window.addEventListener('beforeunload', () => { void deleteWebRtcSession(sessionUrl); });

// DJs need the HTTPS origin for audio capture (except on the venue laptop,
// where loopback is already a secure context).
const broadcastLink = document.querySelector('#broadcast-link');
if (broadcastLink && !['127.0.0.1', 'localhost'].includes(location.hostname)) {
  loadConfig().then((config) => {
    if (!config.allowRemoteBroadcast) {
      broadcastLink.hidden = true;
      return;
    }
    broadcastLink.href = location.protocol === 'https:'
      ? '/broadcast'
      : `https://${location.hostname}:8443/broadcast`;
  }).catch(() => {
    broadcastLink.hidden = true;
  });
}
