(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var img = $('frame');
  var stage = $('stage');
  var placeholder = $('placeholder');
  var dot = $('dot');
  var badgeText = $('badgeText');
  var SETTING_KEYS = ['interval', 'width', 'quality', 'idleInterval', 'rotation', 'facing'];

  var ws = null;
  var reconnectDelay = 1000;
  var status = null;
  var lastFrameLocal = 0; // Zeitpunkt (lokale Uhr) des letzten Bildes
  var currentUrl = null;
  var connected = false;

  function wsUrl() {
    var proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + window.location.host + '/ws?role=viewer';
  }

  function connect() {
    ws = new WebSocket(wsUrl());
    ws.binaryType = 'arraybuffer';
    ws.onopen = function () {
      connected = true;
      reconnectDelay = 1000;
      render();
    };
    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.type === 'status') onStatus(msg);
        return;
      }
      showFrame(ev.data);
    };
    ws.onclose = function () {
      connected = false;
      render();
      // Sitzung abgelaufen? Dann zum Login.
      fetch('/api/session', { credentials: 'same-origin' }).then(function (r) {
        if (r.status === 401) {
          window.location.href = '/login';
          return;
        }
        scheduleReconnect();
      }, scheduleReconnect);
    };
  }

  function scheduleReconnect() {
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  }

  function showFrame(buf) {
    var blob = new Blob([buf], { type: 'image/jpeg' });
    var url = URL.createObjectURL(blob);
    var old = currentUrl;
    currentUrl = url;
    img.onload = function () {
      if (old) URL.revokeObjectURL(old);
    };
    img.src = url;
    img.hidden = false;
    placeholder.hidden = true;
    lastFrameLocal = Date.now();
    $('size').textContent = Math.round(buf.byteLength / 1024) + ' KB';
    render();
  }

  function onStatus(msg) {
    var first = !status;
    status = msg;
    // Beim ersten Status das Alter des vorhandenen Bildes übernehmen
    if (msg.lastFrameAt && (first || !lastFrameLocal)) {
      lastFrameLocal = Date.now() - Math.max(0, msg.serverTime - msg.lastFrameAt);
    }
    var s = msg.settings || {};
    SETTING_KEYS.forEach(function (key) {
      var el = $(key);
      if (el && document.activeElement !== el && s[key] !== undefined) el.value = String(s[key]);
    });
    render();
  }

  function formatAge(ms) {
    var s = Math.round(ms / 1000);
    if (s < 2) return 'gerade eben';
    if (s < 60) return 'vor ' + s + ' s';
    var m = Math.floor(s / 60);
    if (m < 60) return 'vor ' + m + ' min';
    var h = Math.floor(m / 60);
    if (h < 48) return 'vor ' + h + ' h';
    return 'vor ' + Math.floor(h / 24) + ' Tagen';
  }

  function render() {
    var age = lastFrameLocal ? Date.now() - lastFrameLocal : null;
    $('age').textContent = age === null ? '–' : formatAge(age);
    if (status) {
      $('fps').textContent = status.cameraOnline ? (status.fps ? status.fps.toFixed(1) + ' /s' : '–') : '–';
      $('viewers').textContent = String(status.viewers);
    }
    var expected = status && status.settings ? status.settings.interval : 1000;
    var stale = age === null || age > Math.max(10000, expected * 4);
    stage.className = 'stage' + (stale && lastFrameLocal ? ' stale' : '');

    var cls = 'dot';
    var text;
    if (!connected) {
      cls += ' bad';
      text = 'Keine Verbindung zum Server';
    } else if (!status || !status.cameraOnline) {
      cls += ' bad';
      text = 'Kamera offline';
    } else if (stale) {
      cls += ' warn';
      text = 'Kamera verbunden, wartet auf Bild';
    } else {
      cls += ' ok';
      text = 'Live';
    }
    dot.className = cls;
    badgeText.textContent = text;
    if (!lastFrameLocal) {
      placeholder.textContent = status && !status.cameraOnline
        ? 'Kamera offline – öffne /camera auf dem iPhone.'
        : 'Warte auf Bild …';
    }
  }

  SETTING_KEYS.forEach(function (key) {
    $(key).addEventListener('change', function (ev) {
      var raw = ev.target.value;
      var value = key === 'facing' ? raw : Number(raw);
      var settings = {};
      settings[key] = value;
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'settings', settings: settings }));
    });
  });

  var fsBtn = $('fullscreen');
  var canFs = stage.requestFullscreen || stage.webkitRequestFullscreen;
  if (!canFs) {
    fsBtn.hidden = true;
  } else {
    fsBtn.addEventListener('click', function () {
      if (stage.requestFullscreen) stage.requestFullscreen();
      else stage.webkitRequestFullscreen();
    });
  }

  $('snapshot').addEventListener('click', function () {
    // Zeitstempel im Dateinamen
    var d = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    this.setAttribute('download', 'drucker_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
      '_' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.jpg');
  });

  setInterval(render, 1000);
  connect();
})();
