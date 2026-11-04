/*
 * Kameraseite – läuft auf dem iPhone in Safari (iOS 12 kompatibel:
 * keine optional chaining / nullish / class fields verwenden).
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var video = $('video');
  var canvas = $('canvas');
  var ctx = canvas.getContext('2d');
  var startBtn = $('start');
  var dimBtn = $('dim');
  var blackout = $('blackout');
  var errorEl = $('error');

  var settings = {
    width: 640, interval: 1000, quality: 0.6, idleInterval: 60000, rotation: 0, facing: 'environment',
  };
  var watching = 0;
  var stream = null;
  var currentFacing = null;
  var ws = null;
  var wsWanted = false;
  var reconnectDelay = 1000;
  var reconnectTimer = null;
  var captureTimer = null;
  var sending = false;
  var sentCount = 0;
  var bytesWindow = []; // [zeit, bytes]
  var replaced = false;
  var lastVideoTime = -1;
  var frozenSince = 0;
  var restarting = false;

  function setState(text, cls) {
    $('state').textContent = text;
    $('dot').className = 'dot' + (cls ? ' ' + cls : '');
  }

  function showError(text) {
    errorEl.textContent = text;
    errorEl.hidden = !text;
  }

  // ------------------------------------------------------------------
  // Kamera
  // ------------------------------------------------------------------

  function stopStream() {
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
  }

  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError('Dieser Browser erlaubt keinen Kamerazugriff. Bitte Safari verwenden und die Seite über https:// öffnen.');
      return Promise.reject(new Error('no getUserMedia'));
    }
    stopStream();
    var facing = settings.facing;
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: facing,
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    }).then(function (s) {
      stream = s;
      currentFacing = facing;
      video.srcObject = s;
      var track = s.getVideoTracks()[0];
      if (track) {
        track.onended = function () { restartCamera('Kamera wurde beendet'); };
      }
      return video.play().catch(function () {});
    }).then(function () {
      return waitForVideo();
    }).then(function () {
      showError('');
      lastVideoTime = -1;
      frozenSince = 0;
      $('res').textContent = video.videoWidth + '×' + video.videoHeight;
      sendJson({ type: 'info', videoWidth: video.videoWidth, videoHeight: video.videoHeight, facing: currentFacing });
    });
  }

  function waitForVideo() {
    return new Promise(function (resolve) {
      if (video.videoWidth > 0) return resolve();
      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
        resolve();
      };
      video.addEventListener('loadedmetadata', finish);
      setTimeout(finish, 3000);
    });
  }

  function restartCamera(reason) {
    if (restarting) return;
    restarting = true;
    setState(reason + ' – starte neu …', 'warn');
    setTimeout(function () {
      startCamera().then(function () {
        restarting = false;
        updateState();
        scheduleCapture(0);
      }, function (err) {
        restarting = false;
        showError('Kamera konnte nicht neu gestartet werden: ' + (err && err.message ? err.message : err) +
          '. Bitte „Kamera starten“ antippen.');
        startBtn.disabled = false;
        setState('Kamera gestoppt', 'bad');
      });
    }, 1000);
  }

  // ------------------------------------------------------------------
  // Bild aufnehmen und senden
  // ------------------------------------------------------------------

  function currentInterval() {
    return watching > 0 ? settings.interval : settings.idleInterval;
  }

  function scheduleCapture(delay) {
    if (captureTimer) clearTimeout(captureTimer);
    captureTimer = null;
    if (!stream) return;
    if (delay === undefined) delay = currentInterval();
    if (watching === 0 && settings.idleInterval === 0 && delay !== 0) return; // nichts zu tun
    captureTimer = setTimeout(captureAndSend, delay);
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function timestamp() {
    var d = new Date();
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function drawFrame() {
    var vw = video.videoWidth;
    var vh = video.videoHeight;
    if (!vw || !vh) return false;
    var w = Math.min(settings.width, vw);
    var h = Math.round(w * vh / vw);
    var rot = settings.rotation;
    var swap = rot === 90 || rot === 270;
    canvas.width = swap ? h : w;
    canvas.height = swap ? w : h;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rot * Math.PI / 180);
    ctx.drawImage(video, -w / 2, -h / 2, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Zeitstempel unten links
    var fontSize = Math.max(11, Math.round(canvas.height / 26));
    ctx.font = fontSize + 'px -apple-system, Helvetica, Arial, sans-serif';
    var text = timestamp();
    var tw = ctx.measureText(text).width;
    var padding = Math.round(fontSize / 3);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, canvas.height - fontSize - padding * 2, tw + padding * 2, fontSize + padding * 2);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'bottom';
    ctx.fillText(text, padding, canvas.height - padding);
    return true;
  }

  function dataUrlToBlob(dataUrl) {
    var comma = dataUrl.indexOf(',');
    var bin = atob(dataUrl.slice(comma + 1));
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: 'image/jpeg' });
  }

  function encode() {
    return new Promise(function (resolve) {
      if (canvas.toBlob) {
        canvas.toBlob(function (b) {
          resolve(b || dataUrlToBlob(canvas.toDataURL('image/jpeg', settings.quality)));
        }, 'image/jpeg', settings.quality);
      } else {
        resolve(dataUrlToBlob(canvas.toDataURL('image/jpeg', settings.quality)));
      }
    });
  }

  function checkFrozen() {
    // Erkennen, ob das Videobild hängt (passiert gelegentlich nach Unterbrechungen)
    var t = video.currentTime;
    if (t !== lastVideoTime) {
      lastVideoTime = t;
      frozenSince = 0;
      return false;
    }
    if (!frozenSince) frozenSince = Date.now();
    return Date.now() - frozenSince > 8000;
  }

  function captureAndSend() {
    captureTimer = null;
    if (!stream) return;

    var track = stream.getVideoTracks()[0];
    if (!track || track.readyState === 'ended' || checkFrozen()) {
      restartCamera('Kamerabild hängt');
      return;
    }

    // Wenn die letzte Übertragung noch läuft, dieses Bild auslassen
    if (!ws || ws.readyState !== 1 || sending || ws.bufferedAmount > 0) {
      scheduleCapture(watching > 0 ? Math.min(settings.interval, 250) : 1000);
      return;
    }

    if (!drawFrame()) {
      scheduleCapture(500);
      return;
    }

    sending = true;
    encode().then(function (blob) {
      sending = false;
      if (ws && ws.readyState === 1) {
        ws.send(blob);
        sentCount++;
        bytesWindow.push([Date.now(), blob.size]);
        $('sent').textContent = String(sentCount);
      }
      scheduleCapture();
    }, function () {
      sending = false;
      scheduleCapture();
    });
  }

  function updateRate() {
    var now = Date.now();
    while (bytesWindow.length && now - bytesWindow[0][0] > 10000) bytesWindow.shift();
    var total = 0;
    for (var i = 0; i < bytesWindow.length; i++) total += bytesWindow[i][1];
    $('rate').textContent = bytesWindow.length ? Math.round(total / 10 / 1024) + ' KB/s' : '–';
  }

  // ------------------------------------------------------------------
  // Verbindung zum Server
  // ------------------------------------------------------------------

  function sendJson(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function wsUrl() {
    var proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + window.location.host + '/ws?role=camera';
  }

  function connect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    ws = new WebSocket(wsUrl());
    ws.onopen = function () {
      reconnectDelay = 1000;
      updateState();
      if (video.videoWidth) {
        sendJson({ type: 'info', videoWidth: video.videoWidth, videoHeight: video.videoHeight, facing: currentFacing });
      }
    };
    ws.onmessage = function (ev) {
      if (typeof ev.data !== 'string') return;
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'config') {
        var facingChanged = msg.settings && msg.settings.facing !== settings.facing;
        settings = msg.settings || settings;
        watching = msg.watching || 0;
        $('watching').textContent = String(watching);
        updateState();
        if (facingChanged && stream) {
          restartCamera('Kamera wird gewechselt');
        } else {
          scheduleCapture(0);
        }
      } else if (msg.type === 'demand') {
        var before = watching;
        watching = msg.watching || 0;
        $('watching').textContent = String(watching);
        updateState();
        if (watching > 0 && before === 0) scheduleCapture(0);
        else if (!captureTimer || watching === 0) scheduleCapture();
      }
    };
    ws.onclose = function (ev) {
      ws = null;
      if (ev.code === 4000) {
        replaced = true;
        wsWanted = false;
        stopStream();
        setState('Eine andere Kamera hat übernommen', 'bad');
        startBtn.disabled = false;
        return;
      }
      updateState();
      if (!wsWanted) return;
      // Prüfen, ob die Anmeldung abgelaufen ist
      fetch('/api/session', { credentials: 'same-origin' }).then(function (r) {
        if (r.status === 401) {
          window.location.href = '/login?next=/camera';
          return;
        }
        scheduleReconnect();
      }, scheduleReconnect);
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer || !wsWanted) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  }

  function updateState() {
    if (replaced) return;
    if (!stream) {
      setState('Kamera gestoppt', 'bad');
    } else if (!ws || ws.readyState !== 1) {
      setState('Keine Verbindung – verbinde neu …', 'warn');
    } else if (watching > 0) {
      setState('Live – ' + watching + ' Zuschauer', 'ok');
    } else {
      setState('Bereit – niemand schaut zu', 'ok');
    }
  }

  // ------------------------------------------------------------------
  // Bedienung
  // ------------------------------------------------------------------

  startBtn.addEventListener('click', function () {
    replaced = false;
    startBtn.disabled = true;
    setState('Starte Kamera …', 'warn');
    startCamera().then(function () {
      wsWanted = true;
      dimBtn.disabled = false;
      startBtn.textContent = 'Kamera neu starten';
      connect();
      updateState();
      scheduleCapture(0);
      setTimeout(function () { startBtn.disabled = false; }, 2000);
    }, function (err) {
      startBtn.disabled = false;
      setState('Kamera gestoppt', 'bad');
      var name = err && err.name;
      if (name === 'NotAllowedError') {
        showError('Kamerazugriff verweigert. In den Einstellungen → Safari → Kamera auf „Fragen“ oder „Erlauben“ stellen und neu laden.');
      } else if (!errorEl.textContent) {
        showError('Kamera konnte nicht gestartet werden: ' + (err && err.message ? err.message : err));
      }
    });
  });

  dimBtn.addEventListener('click', function () {
    blackout.className = 'blackout on';
  });
  blackout.addEventListener('click', function () {
    blackout.className = 'blackout';
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden || !wsWanted) return;
    // Zurück im Vordergrund: Kamera und Verbindung prüfen
    var track = stream && stream.getVideoTracks()[0];
    if (!track || track.readyState === 'ended') restartCamera('Kamera wird fortgesetzt');
    if (!ws) {
      reconnectDelay = 1000;
      connect();
    }
  });

  window.addEventListener('online', function () {
    if (wsWanted && !ws) {
      reconnectDelay = 1000;
      connect();
    }
  });

  setInterval(function () {
    updateRate();
    // Sicherheitsnetz: falls die Aufnahmeschleife steht, wieder anstoßen
    if (stream && !captureTimer && !sending && !restarting && currentInterval() > 0) scheduleCapture();
  }, 2000);

  if (window.isSecureContext === false && window.location.hostname !== 'localhost') {
    showError('Achtung: Die Seite ist nicht über https:// geöffnet. Safari erlaubt die Kamera nur mit https.');
  }
})();
