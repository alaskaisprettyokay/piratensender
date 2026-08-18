export async function loadConfig() {
  const response = await fetch('/config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Local node configuration is unavailable.');
  return response.json();
}

// Chrome's Opus defaults are speech-tuned (~32 kbps, effectively mono).
// Force stereo music-grade encoding: the sender obeys the fmtp line of the
// SDP it applies, so this must be run on both our offer and the answer.
export function tuneOpusForMusic(sdp, bitrate = 256000) {
  return sdp.replace(/a=fmtp:(\d+) ([^\r\n]*)/g, (line, payloadType, params) => {
    if (!new RegExp(`a=rtpmap:${payloadType} opus/`, 'i').test(sdp)) return line;
    return `a=fmtp:${payloadType} ${params};stereo=1;sprop-stereo=1;maxaveragebitrate=${bitrate};maxplaybackrate=48000;cbr=0;useinbandfec=1`;
  });
}

export function preferOpus(transceiver) {
  if (!transceiver?.setCodecPreferences || !window.RTCRtpReceiver?.getCapabilities) return;
  const capabilities = RTCRtpReceiver.getCapabilities('audio');
  if (!capabilities) return;
  const opus = capabilities.codecs.filter((codec) => codec.mimeType.toLowerCase() === 'audio/opus');
  const rest = capabilities.codecs.filter((codec) => codec.mimeType.toLowerCase() !== 'audio/opus');
  transceiver.setCodecPreferences([...opus, ...rest]);
}

export async function waitForIceGathering(peerConnection, timeoutMs = 3000) {
  if (peerConnection.iceGatheringState === 'complete') return;
  await new Promise((resolve) => {
    const timeout = window.setTimeout(done, timeoutMs);
    function done() {
      window.clearTimeout(timeout);
      peerConnection.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    }
    function onChange() {
      if (peerConnection.iceGatheringState === 'complete') done();
    }
    peerConnection.addEventListener('icegatheringstatechange', onChange);
  });
}

export async function createWebRtcSession(endpoint, peerConnection, { music = false, bitrate = 256000 } = {}) {
  const offer = await peerConnection.createOffer();
  if (music) offer.sdp = tuneOpusForMusic(offer.sdp, bitrate);
  await peerConnection.setLocalDescription(offer);
  await waitForIceGathering(peerConnection);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: peerConnection.localDescription.sdp,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Media connection failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }

  let answer = await response.text();
  if (music) answer = tuneOpusForMusic(answer, bitrate);
  await peerConnection.setRemoteDescription({ type: 'answer', sdp: answer });
  const location = response.headers.get('Location');
  // endpoint may be relative (same-origin /mtx proxy); resolve against the page.
  const base = new URL(endpoint, window.location.href);
  return location ? new URL(location, base).toString() : null;
}

export async function deleteWebRtcSession(sessionUrl) {
  if (!sessionUrl) return;
  await fetch(sessionUrl, { method: 'DELETE', keepalive: true }).catch(() => undefined);
}
