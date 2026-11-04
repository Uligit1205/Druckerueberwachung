'use strict';

/*
 * Druckerüberwachung – Relay-Server
 *
 * Das iPhone öffnet /camera in Safari und schickt JPEG-Bilder per WebSocket.
 * Zuschauer öffnen / und bekommen die Bilder live weitergereicht.
 * Zusätzlich gibt es /snapshot.jpg und /stream.mjpg (z. B. für OctoPrint,
 * Home Assistant oder VLC).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PASSWORD = process.env.PASSWORD || '';
const STREAM_TOKEN = process.env.STREAM_TOKEN || '';
const SESSION_DAYS = parseInt(process.env.SESSION_DAYS || '180', 10);

if (PASSWORD.length < 8) {
  console.error('FEHLER: Bitte die Umgebungsvariable PASSWORD setzen (mindestens 8 Zeichen).');
  process.exit(1);
}
if (STREAM_TOKEN && STREAM_TOKEN.length < 16) {
  console.error('FEHLER: STREAM_TOKEN muss mindestens 16 Zeichen lang sein (oder leer lassen).');
  process.exit(1);
}

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const VIEWER_BUFFER_LIMIT = 512 * 1024;
const HEARTBEAT_MS = 25000;
const COOKIE_NAME = 'dcam';

// Sitzungsschlüssel wird vom Passwort abgeleitet: Neustarts lassen die
// Kamera eingeloggt, eine Passwortänderung meldet alle Geräte ab.
const SESSION_KEY = crypto.createHmac('sha256', 'druckerueberwachung-session-v1').update(PASSWORD).digest();

// Erlaubte Werte für die Kameraeinstellungen
const ALLOWED_SETTINGS = {
  width: [320, 480, 640, 800, 960, 1280],
  interval: [200, 333, 500, 1000, 2000, 5000],
  quality: [0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
  idleInterval: [0, 10000, 30000, 60000, 300000],
  rotation: [0, 90, 180, 270],
  facing: ['environment', 'user'],
};

let settings = {
  width: 640,
  interval: 1000,
  quality: 0.6,
  idleInterval: 60000,
  rotation: 0,
  facing: 'environment',
};

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

function safeEqualStrings(a, b) {
  // Hash vorher, damit die Länge nicht über das Timing verraten wird
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_KEY).update(String(value)).digest('base64url');
}

function makeSessionToken() {
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  return exp + '.' + sign(exp);
}

function isValidSessionToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d{1,16}$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEqualStrings(sig, sign(exp));
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch (e) {
      out[k] = v;
    }
  }
  return out;
}

function isLoggedIn(req) {
  return isValidSessionToken(parseCookies(req)[COOKIE_NAME]);
}

function hasStreamToken(url) {
  if (!STREAM_TOKEN) return false;
  const t = url.searchParams.get('token');
  return !!t && safeEqualStrings(t, STREAM_TOKEN);
}

function isSecureRequest(req) {
  if (req.socket.encrypted) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https';
}

function clientKey(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf);
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function securityHeaders(extra) {
  return Object.assign(
    {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob: mediastream:; " +
        "connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    },
    extra || {}
  );
}

function send(res, status, body, headers) {
  res.writeHead(status, securityHeaders(Object.assign({ 'Cache-Control': 'no-store' }, headers || {})));
  res.end(body);
}

function redirect(res, location, extraHeaders) {
  send(res, 303, '', Object.assign({ Location: location }, extraHeaders || {}));
}

// Nur interne Weiterleitungsziele zulassen
function safeNext(next) {
  return next === '/camera' ? '/camera' : '/';
}

// ---------------------------------------------------------------------------
// Login-Schutz gegen Durchprobieren
// ---------------------------------------------------------------------------

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const loginFailures = new Map(); // key -> { count, first }

function loginBlocked(key) {
  const entry = loginFailures.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > LOGIN_WINDOW_MS) {
    loginFailures.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function registerLoginFailure(key) {
  const now = Date.now();
  const entry = loginFailures.get(key);
  if (!entry || now - entry.first > LOGIN_WINDOW_MS) {
    loginFailures.set(key, { count: 1, first: now });
  } else {
    entry.count++;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginFailures) {
    if (now - v.first > LOGIN_WINDOW_MS) loginFailures.delete(k);
  }
}, 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Statische Dateien (feste Liste, kein freier Dateizugriff)
// ---------------------------------------------------------------------------

const PUBLIC_DIR = path.join(__dirname, 'public');
const HTML = 'text/html; charset=utf-8';
const JS = 'application/javascript; charset=utf-8';
const CSS = 'text/css; charset=utf-8';

const ROUTES = {
  '/': { file: 'index.html', type: HTML, auth: true },
  '/camera': { file: 'camera.html', type: HTML, auth: true },
  '/viewer.js': { file: 'viewer.js', type: JS, auth: true },
  '/camera.js': { file: 'camera.js', type: JS, auth: true },
  '/login': { file: 'login.html', type: HTML, auth: false },
  '/login.js': { file: 'login.js', type: JS, auth: false },
  '/style.css': { file: 'style.css', type: CSS, auth: false },
  '/icon.svg': { file: 'icon.svg', type: 'image/svg+xml', auth: false },
};

const fileCache = new Map();
function readPublic(file) {
  if (process.env.NODE_ENV === 'production' && fileCache.has(file)) return fileCache.get(file);
  const data = fs.readFileSync(path.join(PUBLIC_DIR, file));
  fileCache.set(file, data);
  return data;
}

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------

let camera = null; // WebSocket der Kamera
let cameraInfo = null; // { videoWidth, videoHeight, facing, userAgent }
let cameraSince = 0;
let latestFrame = null; // Buffer
let latestFrameAt = 0;
const frameTimes = []; // für FPS-Berechnung
const viewers = new Set(); // WebSockets
const mjpegClients = new Set(); // http.ServerResponse

function watcherCount() {
  return viewers.size + mjpegClients.size;
}

function sendJson(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function currentFps() {
  const now = Date.now();
  while (frameTimes.length && now - frameTimes[0] > 10000) frameTimes.shift();
  if (frameTimes.length < 2) return 0;
  const span = (frameTimes[frameTimes.length - 1] - frameTimes[0]) / 1000;
  return span > 0 ? (frameTimes.length - 1) / span : 0;
}

function statusMessage() {
  return {
    type: 'status',
    serverTime: Date.now(),
    cameraOnline: !!camera,
    cameraSince,
    cameraInfo,
    lastFrameAt: latestFrameAt,
    fps: Math.round(currentFps() * 10) / 10,
    frameBytes: latestFrame ? latestFrame.length : 0,
    viewers: watcherCount(),
    settings,
  };
}

function broadcastStatus() {
  const msg = JSON.stringify(statusMessage());
  for (const v of viewers) {
    if (v.readyState === WebSocket.OPEN) v.send(msg);
  }
}

let lastDemand = -1;
function notifyDemand() {
  const n = watcherCount();
  if (n === lastDemand) return;
  lastDemand = n;
  sendJson(camera, { type: 'demand', watching: n });
}

function writeMjpegFrame(res, frame) {
  res.write('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + frame.length + '\r\n\r\n');
  res.write(frame);
  res.write('\r\n');
}

function onFrame(data) {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return; // kein JPEG
  latestFrame = data;
  latestFrameAt = Date.now();
  frameTimes.push(latestFrameAt);
  if (frameTimes.length > 200) frameTimes.shift();

  for (const v of viewers) {
    if (v.readyState === WebSocket.OPEN && v.bufferedAmount < VIEWER_BUFFER_LIMIT) {
      v.send(data, { binary: true });
    }
  }
  for (const res of mjpegClients) {
    if (!res.writableNeedDrain) writeMjpegFrame(res, data);
  }
}

function sanitizeSettings(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of Object.keys(ALLOWED_SETTINGS)) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      const value = input[key];
      if (ALLOWED_SETTINGS[key].indexOf(value) !== -1) out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function handleLogin(req, res) {
  const key = clientKey(req);
  let body = '';
  let tooLarge = false;
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 4096) {
      tooLarge = true;
      req.destroy();
    }
  });
  req.on('end', () => {
    if (tooLarge) return;
    const params = new URLSearchParams(body);
    const next = safeNext(params.get('next'));
    if (loginBlocked(key)) {
      return redirect(res, '/login?error=blocked&next=' + encodeURIComponent(next));
    }
    const pw = params.get('password') || '';
    if (!safeEqualStrings(pw, PASSWORD)) {
      registerLoginFailure(key);
      // kleine Verzögerung bremst Durchprobieren zusätzlich
      return setTimeout(() => redirect(res, '/login?error=1&next=' + encodeURIComponent(next)), 1000);
    }
    loginFailures.delete(key);
    const cookie =
      COOKIE_NAME + '=' + encodeURIComponent(makeSessionToken()) +
      '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + SESSION_DAYS * 24 * 60 * 60 +
      (isSecureRequest(req) ? '; Secure' : '');
    redirect(res, next, { 'Set-Cookie': cookie });
  });
}

function handleMjpeg(req, res) {
  res.writeHead(200, securityHeaders({
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache',
    Connection: 'close',
    'X-Accel-Buffering': 'no',
  }));
  mjpegClients.add(res);
  if (latestFrame) writeMjpegFrame(res, latestFrame);
  notifyDemand();
  broadcastStatus();
  const cleanup = () => {
    if (mjpegClients.delete(res)) {
      notifyDemand();
      broadcastStatus();
    }
  };
  req.on('close', cleanup);
  res.on('error', cleanup);
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (e) {
    return send(res, 400, 'Bad Request');
  }
  const pathname = url.pathname;

  if (pathname === '/healthz') {
    return send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  if (pathname === '/login' && req.method === 'POST') return handleLogin(req, res);

  if (pathname === '/logout') {
    return redirect(res, '/login', {
      'Set-Cookie': COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (isSecureRequest(req) ? '; Secure' : ''),
    });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  }

  const loggedIn = isLoggedIn(req);

  if (pathname === '/api/session') {
    return send(res, loggedIn ? 200 : 401, JSON.stringify({ loggedIn }), { 'Content-Type': 'application/json' });
  }

  if (pathname === '/snapshot.jpg' || pathname === '/stream.mjpg') {
    if (!loggedIn && !hasStreamToken(url)) {
      return send(res, 401, 'Nicht angemeldet', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    if (pathname === '/stream.mjpg') return handleMjpeg(req, res);
    if (!latestFrame) {
      return send(res, 503, 'Noch kein Bild vorhanden', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    return send(res, 200, latestFrame, {
      'Content-Type': 'image/jpeg',
      'Content-Length': latestFrame.length,
      'Last-Modified': new Date(latestFrameAt).toUTCString(),
    });
  }

  const route = ROUTES[pathname];
  if (!route) return send(res, 404, 'Nicht gefunden', { 'Content-Type': 'text/plain; charset=utf-8' });

  if (route.auth && !loggedIn) {
    if (route.type === HTML) return redirect(res, '/login?next=' + encodeURIComponent(safeNext(pathname)));
    return send(res, 401, 'Nicht angemeldet');
  }

  if (pathname === '/login' && loggedIn) {
    return redirect(res, safeNext(url.searchParams.get('next')));
  }

  let data;
  try {
    data = readPublic(route.file);
  } catch (e) {
    return send(res, 500, 'Datei fehlt');
  }
  return send(res, 200, req.method === 'HEAD' ? '' : data, {
    'Content-Type': route.type,
    'Cache-Control': route.auth ? 'no-store' : 'public, max-age=300',
  });
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // Nicht-Browser-Clients
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch (e) {
    return false;
  }
  const hosts = [req.headers.host, req.headers['x-forwarded-host']]
    .filter(Boolean)
    .map((h) => String(h).split(',')[0].trim());
  return hosts.indexOf(originHost) !== -1;
}

function rejectUpgrade(socket, status, text) {
  socket.write('HTTP/1.1 ' + status + ' ' + text + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (e) {
    return rejectUpgrade(socket, 400, 'Bad Request');
  }
  if (url.pathname !== '/ws') return rejectUpgrade(socket, 404, 'Not Found');
  if (!isLoggedIn(req)) return rejectUpgrade(socket, 401, 'Unauthorized');
  if (!originAllowed(req)) return rejectUpgrade(socket, 403, 'Forbidden');
  const role = url.searchParams.get('role');
  if (role !== 'camera' && role !== 'viewer') return rejectUpgrade(socket, 400, 'Bad Request');

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('error', () => {});
    if (role === 'camera') attachCamera(ws, req);
    else attachViewer(ws);
  });
});

function attachCamera(ws, req) {
  if (camera && camera !== ws) {
    // Es kann nur eine Kamera geben – die neue gewinnt
    try {
      camera.close(4000, 'replaced');
    } catch (e) {}
  }
  camera = ws;
  cameraSince = Date.now();
  cameraInfo = { userAgent: String(req.headers['user-agent'] || '').slice(0, 200) };
  lastDemand = watcherCount();
  sendJson(ws, { type: 'config', settings, watching: lastDemand });
  console.log('Kamera verbunden');
  broadcastStatus();

  ws.on('message', (data, isBinary) => {
    if (camera !== ws) return;
    if (isBinary) return onFrame(data);
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }
    if (msg && msg.type === 'info') {
      cameraInfo = {
        userAgent: cameraInfo ? cameraInfo.userAgent : '',
        videoWidth: Number(msg.videoWidth) || 0,
        videoHeight: Number(msg.videoHeight) || 0,
        facing: msg.facing === 'user' ? 'user' : 'environment',
      };
      broadcastStatus();
    }
  });

  ws.on('close', () => {
    if (camera === ws) {
      camera = null;
      console.log('Kamera getrennt');
      broadcastStatus();
    }
  });
}

function attachViewer(ws) {
  viewers.add(ws);
  sendJson(ws, statusMessage());
  if (latestFrame) ws.send(latestFrame, { binary: true });
  notifyDemand();
  broadcastStatus();

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }
    if (!msg) return;
    if (msg.type === 'settings') {
      const changes = sanitizeSettings(msg.settings);
      if (Object.keys(changes).length) {
        settings = Object.assign({}, settings, changes);
        sendJson(camera, { type: 'config', settings, watching: watcherCount() });
        broadcastStatus();
      }
    }
  });

  ws.on('close', () => {
    viewers.delete(ws);
    notifyDemand();
    broadcastStatus();
  });
}

// Tote Verbindungen erkennen (z. B. iPhone im Standby) und Proxys wachhalten
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (e) {}
  }
  // MJPEG-Verbindungen bei fehlender Kamera mit dem letzten Bild wachhalten
  if (!camera && latestFrame) {
    for (const res of mjpegClients) {
      if (!res.writableNeedDrain) writeMjpegFrame(res, latestFrame);
    }
  }
}, HEARTBEAT_MS);

// Status regelmäßig an Zuschauer (FPS, Alter des letzten Bildes)
const statusTimer = setInterval(() => {
  if (viewers.size) broadcastStatus();
}, 5000);

server.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(statusTimer);
});

server.listen(PORT, HOST, () => {
  const addr = server.address();
  console.log('Druckerüberwachung läuft auf Port ' + addr.port);
  console.log('  Ansicht:  /        Kamera (auf dem iPhone öffnen): /camera');
  if (!STREAM_TOKEN) console.log('  Hinweis: STREAM_TOKEN nicht gesetzt – /stream.mjpg und /snapshot.jpg nur mit Login.');
});

function shutdown() {
  for (const ws of wss.clients) ws.terminate();
  for (const res of mjpegClients) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = server;
