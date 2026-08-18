import { createWebRtcSession, deleteWebRtcSession, loadConfig, preferOpus } from './common.js';

const channelInput = document.querySelector('#channel-name');
const deviceSelect = document.querySelector('#audio-device');
const qualitySelect = document.querySelector('#quality');
const permissionButton = document.querySelector('#permission-button');
const broadcastButton = document.querySelector('#broadcast-button');
const message = document.querySelector('#message');
const statusLabel = document.querySelector('#status-label');
const meterFill = document.querySelector('#meter-fill');

let peerConnection = null;
let sessionUrl = null;
let mediaStream = null;
let wakeLock = null;
let audioContext = null;
let meterFrame = null;

function setState(state, detail) {
  document.body.dataset.state = state;
  statusLabel.textContent = state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting' : 'Offline';
  message.textContent = detail;
  broadcastButton.textContent = state === 'live' ? 'Stop' : state === 'connecting' ? 'Starting…' : 'Go live';
  broadcastButton.disabled = state === 'connecting' || (state !== 'live' && !deviceSelect.value);
  deviceSelect.disabled = state === 'live' || state === 'connecting';
  permissionButton.disabled = state === 'live' || state === 'connecting';
  channelInput.disabled = state === 'live' || state === 'connecting';
  qualitySelect.disabled = state === 'live' || state === 'connecting';
}

// Channel names become URL path segments: keep them simple and predictable.
function normalizedChannel() {
  return channelInput.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
}

async function refreshDevices(requestPermission = false) {
  let permissionStream;
  try {
    if (requestPermission) permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
    const previous = deviceSelect.value;
    deviceSelect.replaceChildren(new Option('Select mixer / interface', ''));
    for (const [index, device] of devices.entries()) {
      deviceSelect.add(new Option(device.label || `Audio input ${index + 1}`, device.deviceId));
    }
    deviceSelect.value = devices.some((device) => device.deviceId === previous) ? previous : (devices[0]?.deviceId || '');
    setState('idle', devices.length ? 'Select the mixer master input and start.' : 'No audio inputs found.');
  } catch (error) {
    setState('idle', error instanceof Error ? error.message : 'Could not access audio devices.');
  } finally {
    permissionStream?.getTracks().forEach((track) => track.stop());
  }
}

function startMeter(stream) {
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const values = new Uint8Array(analyser.fftSize);
  const draw = () => {
    analyser.getByteTimeDomainData(values);
    let peak = 0;
    for (const value of values) peak = Math.max(peak, Math.abs(value - 128) / 128);
    meterFill.style.width = `${Math.min(100, peak * 180)}%`;
    meterFrame = requestAnimationFrame(draw);
  };
  draw();
}

async function stop() {
  await deleteWebRtcSession(sessionUrl);
  sessionUrl = null;
  peerConnection?.close();
  peerConnection = null;
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  cancelAnimationFrame(meterFrame);
  meterFrame = null;
  await audioContext?.close().catch(() => undefined);
  audioContext = null;
  meterFill.style.width = '0%';
  await wakeLock?.release().catch(() => undefined);
  wakeLock = null;
  setState('idle', 'Broadcast stopped.');
}

async function start() {
  setState('connecting', 'Opening the mixer and relay…');
  try {
    const config = await loadConfig();

    // Station names are unique: refuse one that is already live. MediaMTX
    // enforces this too (overridePublisher: no); this is the friendly error.
    const channel = normalizedChannel() || config.streamName;
    channelInput.value = channel;
    try {
      const listResponse = await fetch('/channels', { cache: 'no-store' });
      const live = ((await listResponse.json()).channels || []).filter((c) => c.ready);
      if (live.some((c) => c.name === channel)) {
        setState('error', `"${channel}" is already live. Pick another station name.`);
        return;
      }
    } catch { /* if the check fails, MediaMTX still rejects duplicates */ }

    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        deviceId: { exact: deviceSelect.value },
        channelCount: { ideal: 2 },
        sampleRate: { ideal: 48000 },
        sampleSize: { ideal: 24 },
        latency: { ideal: 0 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        voiceIsolation: false,
      },
    });

    const pc = new RTCPeerConnection();
    peerConnection = pc;
    const track = mediaStream.getAudioTracks()[0];
    track.contentHint = 'music';
    const transceiver = pc.addTransceiver(track, { direction: 'sendonly', streams: [mediaStream] });
    preferOpus(transceiver);

    pc.addEventListener('connectionstatechange', () => {
      if (pc !== peerConnection) return;
      if (pc.connectionState === 'connected') setState('live', 'Publishing. Keep this tab open.');
      if (['failed', 'disconnected'].includes(pc.connectionState)) {
        setState('error', 'Relay disconnected. Stop and restart the broadcast.');
      }
    });

    const bitrate = (Number(qualitySelect.value) || 256) * 1000;
    sessionUrl = await createWebRtcSession(`/mtx/${encodeURIComponent(channel)}/whip`, pc, { music: true, bitrate });
    startMeter(mediaStream);
    if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen').catch(() => null);
    setState('live', 'Publishing. Keep this tab open.');
  } catch (error) {
    await stop();
    setState('error', error instanceof Error ? error.message : 'Could not start the broadcast.');
  }
}

permissionButton.addEventListener('click', () => { void refreshDevices(true); });
deviceSelect.addEventListener('change', () => setState('idle', 'Ready to publish the selected input.'));
broadcastButton.addEventListener('click', () => {
  if (peerConnection) void stop();
  else void start();
});
navigator.mediaDevices?.addEventListener('devicechange', () => { if (!peerConnection) void refreshDevices(false); });
window.addEventListener('beforeunload', () => { void deleteWebRtcSession(sessionUrl); });
void refreshDevices(false);

// ?bitrate= presets the quality selector (adds a custom entry if needed).
const bitrateParam = Number(new URLSearchParams(location.search).get('bitrate'));
if (Number.isFinite(bitrateParam) && bitrateParam >= 32 && bitrateParam <= 320) {
  const value = String(Math.round(bitrateParam));
  if (![...qualitySelect.options].some((o) => o.value === value)) {
    qualitySelect.add(new Option(`Custom · ${value}k`, value));
  }
  qualitySelect.value = value;
}

// Prefill the channel from ?ch= or the node's default.
channelInput.value = new URLSearchParams(location.search).get('ch') || '';
if (!channelInput.value) {
  loadConfig().then((config) => {
    if (!channelInput.value) channelInput.value = config.streamName;
  }).catch(() => { channelInput.value = 'piratensender'; });
}
