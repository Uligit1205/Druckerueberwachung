(function () {
  'use strict';
  var params = new URLSearchParams(window.location.search);
  var next = params.get('next');
  if (next === '/camera') document.getElementById('next').value = '/camera';
  var err = params.get('error');
  if (err) {
    var el = document.getElementById('error');
    el.textContent = err === 'blocked'
      ? 'Zu viele Fehlversuche. Bitte 15 Minuten warten.'
      : 'Falsches Passwort.';
    el.hidden = false;
  }
})();
