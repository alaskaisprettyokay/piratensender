import { chromium } from '@playwright/test';

const baseUrl = process.env.PIRATENSENDER_TEST_URL || 'http://127.0.0.1:8090';
// Unique station so the test never collides with a real broadcast.
const station = `smoke-${Date.now().toString(36)}`;
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

try {
  const context = await browser.newContext();
  await context.grantPermissions(['microphone'], { origin: baseUrl });

  const broadcaster = await context.newPage();
  await broadcaster.goto(`${baseUrl}/broadcast`);
  await broadcaster.locator('#permission-button').click();
  await broadcaster.locator('#audio-device').selectOption({ index: 1 });
  await broadcaster.locator('#channel-name').fill(station);
  await broadcaster.locator('#broadcast-button').click();
  await broadcaster.locator('body[data-state="live"]').waitFor({ timeout: 15_000 });

  const listener = await context.newPage();
  await listener.goto(`${baseUrl}/?ch=${station}`);
  await listener.locator('#listen-button').click();
  await listener.locator('body[data-state="live"]').waitFor({ timeout: 15_000 });

  const audioState = await listener.locator('#audio').evaluate((element) => ({
    hasStream: element.srcObject instanceof MediaStream,
    activeTracks: element.srcObject instanceof MediaStream
      ? element.srcObject.getAudioTracks().filter((track) => track.readyState === 'live').length
      : 0,
  }));
  if (!audioState.hasStream || audioState.activeTracks < 1) {
    throw new Error(`Listener did not receive a live audio track: ${JSON.stringify(audioState)}`);
  }

  const apiResponse = await fetch(`http://127.0.0.1:9997/v3/paths/get/${station}`);
  if (!apiResponse.ok) throw new Error(`MediaMTX path API returned ${apiResponse.status}`);
  const pathState = await apiResponse.json();
  if (!pathState.ready) throw new Error(`MediaMTX path is not ready: ${JSON.stringify(pathState)}`);

  const channelCount = pathState.tracks2?.[0]?.codecProps?.channelCount ?? null;
  if (channelCount !== 2) {
    throw new Error(`Expected stereo Opus ingest, got channelCount=${channelCount}`);
  }

  console.log(JSON.stringify({ ok: true, audioState, channelCount, readers: pathState.readers?.length ?? null }));
} finally {
  await browser.close();
}
