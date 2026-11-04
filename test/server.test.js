'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = 'http://127.0.0.1:' + PORT;
const PASSWORD = 'test-passwort-123';
const STREAM_TOKEN = 'stream-token-abcdefghijklmnop';

// Minimales gültiges JPEG-ähnliches Payload (Server prüft nur SOI-Marker)
const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 7), Buffer.from([0xff, 0xd9])]);

let proc;

function waitForServer() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const tryOnce = () => {
      http.get(BASE + '/healthz', (res) => {
        res.resume();
        resolve();
      }).on('error', () => {
        if (Date.now() > deadline) reject(new Error('Server startet nicht'));
        else setTimeout(tryOnce, 100);
      });
    };
    tryOnce();
  });
}

async function login(password) {
  const res = await fetch(BASE + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=' + encodeURIComponent(password) + '&next=%2Fcamera',
    redirect: 'manual',
  });
  return res;
}

function openWs(role, cookie, extraHeaders) {
  return new WebSocket('ws://127.0.0.1:' + PORT + '/ws?role=' + role, {
    headers: Object.assign({ Cookie: cookie || '' }, extraHeaders || {}),
  });
}

function nextMessage(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), 3000);
    const onMsg = (data, isBinary) => {
      const value = isBinary ? data : JSON.parse(data.toString());
      if (!predicate || predicate(value, isBinary)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve({ value, isBinary });
      }
    };
    ws.on('message', onMsg);
  });
}

test.before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', PASSWORD, STREAM_TOKEN }),
    stdio: 'ignore',
  });
  await waitForServer();
});

test.after(() => {
  if (proc) proc.kill();
});

let cookie;

test('ohne Login wird zur Anmeldung umgeleitet', async () => {
  const res = await fetch(BASE + '/camera', { redirect: 'manual' });
  assert.strictEqual(res.status, 303);
  assert.strictEqual(res.headers.get('location'), '/login?next=%2Fcamera');
  const snap = await fetch(BASE + '/snapshot.jpg');
  assert.strictEqual(snap.status, 401);
});

test('falsches Passwort wird abgelehnt', async () => {
  const res = await login('falsch');
  assert.strictEqual(res.status, 303);
  assert.match(res.headers.get('location'), /error=1/);
  assert.strictEqual(res.headers.get('set-cookie'), null);
});

test('richtiges Passwort setzt Cookie', async () => {
  const res = await login(PASSWORD);
  assert.strictEqual(res.status, 303);
  assert.strictEqual(res.headers.get('location'), '/camera');
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  cookie = setCookie.split(';')[0];
  const page = await fetch(BASE + '/camera', { headers: { Cookie: cookie } });
  assert.strictEqual(page.status, 200);
  const session = await fetch(BASE + '/api/session', { headers: { Cookie: cookie } });
  assert.strictEqual(session.status, 200);
});

test('WebSocket ohne Login oder mit fremdem Origin wird abgelehnt', async () => {
  for (const [c, headers, code] of [['', {}, 401], [cookie, { Origin: 'https://boese.example' }, 403]]) {
    const ws = openWs('viewer', c, headers);
    const status = await new Promise((resolve) => {
      ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
      ws.on('error', () => {});
    });
    assert.strictEqual(status, code);
  }
});

test('Bilder werden von der Kamera an Zuschauer und MJPEG weitergeleitet', async () => {
  const cam = openWs('camera', cookie);
  const config = await nextMessage(cam, (m, bin) => !bin && m.type === 'config');
  assert.strictEqual(config.value.watching, 0);

  const viewer = openWs('viewer', cookie, { Origin: BASE.replace('127.0.0.1', '127.0.0.1') });
  const demand = await nextMessage(cam, (m, bin) => !bin && m.type === 'demand');
  assert.strictEqual(demand.value.watching, 1);
  await nextMessage(viewer, (m, bin) => !bin && m.type === 'status' && m.cameraOnline === true);

  // Einstellungen vom Zuschauer erreichen die Kamera; ungültige Werte werden ignoriert
  viewer.send(JSON.stringify({ type: 'settings', settings: { interval: 500, width: 12345 } }));
  const cfg2 = await nextMessage(cam, (m, bin) => !bin && m.type === 'config');
  assert.strictEqual(cfg2.value.settings.interval, 500);
  assert.strictEqual(cfg2.value.settings.width, 640);

  const gotFrame = nextMessage(viewer, (m, bin) => bin);
  cam.send(FAKE_JPEG);
  const frame = await gotFrame;
  assert.ok(Buffer.compare(frame.value, FAKE_JPEG) === 0);

  // Kein JPEG -> wird verworfen
  cam.send(Buffer.from('hallo'));

  const snap = await fetch(BASE + '/snapshot.jpg', { headers: { Cookie: cookie } });
  assert.strictEqual(snap.status, 200);
  assert.strictEqual(snap.headers.get('content-type'), 'image/jpeg');
  assert.ok(Buffer.compare(Buffer.from(await snap.arrayBuffer()), FAKE_JPEG) === 0);

  // MJPEG mit Token
  const mjpegChunk = await new Promise((resolve, reject) => {
    const req = http.get(BASE + '/stream.mjpg?token=' + STREAM_TOKEN, (res) => {
      assert.strictEqual(res.statusCode, 200);
      assert.match(res.headers['content-type'], /multipart\/x-mixed-replace/);
      res.once('data', (d) => {
        req.destroy();
        resolve(d.toString('latin1'));
      });
    });
    req.on('error', reject);
  });
  assert.match(mjpegChunk, /--frame/);

  const badToken = await fetch(BASE + '/stream.mjpg?token=falsch');
  assert.strictEqual(badToken.status, 401);

  // Zweite Kamera ersetzt die erste
  const closed = new Promise((resolve) => cam.on('close', (code) => resolve(code)));
  const cam2 = openWs('camera', cookie);
  assert.strictEqual(await closed, 4000);

  viewer.close();
  cam2.close();
});
