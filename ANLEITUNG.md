# Druckerüberwachung – altes iPhone als Kamera für den 3D-Drucker

Das iPhone (getestet für das iPhone 6 mit iOS 12) wird zur Live-Kamera. Das Bild
kann über das Internet in jedem Browser angesehen werden, auf Handy, Tablet oder PC.

**Auf dem iPhone muss keine App installiert werden.** Es öffnet in Safari eine
Webseite, die die Kamera nutzt. Das ist wichtig, weil das iPhone 6 nicht über
iOS 12 hinaus aktualisiert werden kann und die meisten Kamera-Apps dort nicht mehr laufen.

```
 iPhone 6 (Safari)  ── Bilder per WebSocket (HTTPS) ──▶  kleiner Server  ──▶  dein Handy / PC
     /camera                                              (Cloud oder        (Browser, /)
                                                           zu Hause)
```

## Funktionen

- Livebild im Browser, 0,2 bis 5 Bilder pro Sekunde, Auflösung bis 1280 px
- **Spart Daten:** Volle Bildrate nur, wenn jemand zuschaut. Sonst z. B. ein Bild pro Minute (einstellbar)
- Einstellungen (Bildrate, Auflösung, Qualität, Drehung, Front- oder Rückkamera)
  aus der Ferne änderbar
- Zeitstempel im Bild, Anzeige „Kamera offline“ bzw. „Letztes Bild vor X s“
- Passwortschutz, angemeldete Geräte bleiben 180 Tage eingeloggt
- Automatischer Neuaufbau bei WLAN-Abbruch und Neustart der Kamera, wenn das Bild hängt
- `/snapshot.jpg` und `/stream.mjpg` für OctoPrint, Home Assistant, VLC und Ähnliches
- Taste „Bildschirm schwarz“, damit das Display nicht die ganze Nacht leuchtet

## Warum ein Server?

Ein iPhone kann aus dem Internet nicht direkt erreicht werden: Der Router lässt
keine Verbindungen von außen herein, und Safari kann keinen Server spielen. Deshalb
**schickt** das iPhone seine Bilder an einen kleinen Server, und du holst sie dort ab.
Außerdem gibt Safari die Kamera nur auf Seiten mit **https://** frei. Beide
Varianten unten liefern das automatisch.

Es gibt zwei Möglichkeiten. Nimm die, die besser zu dir passt.

| | Variante A: Cloud (Render.com) | Variante B: Zu Hause + Cloudflare Tunnel |
|---|---|---|
| Zusätzliche Hardware | keine | ein Rechner, der ständig läuft (Raspberry Pi, NAS, alter PC) |
| Kosten | kostenloser Tarif möglich | kostenlos (eigene Domain für feste Adresse: ca. 10 €/Jahr) |
| Einrichtung | ca. 10 Minuten | ca. 20–30 Minuten |
| Zuverlässigkeit | Gratis-Server schläft evtl. nach Inaktivität ein (siehe unten) | sehr gut |

---

## Variante A: Kostenlos in der Cloud (Render.com)

1. Ein Konto bei <https://render.com> anlegen (Anmeldung mit GitHub ist am einfachsten).
2. **New → Blueprint** wählen und dieses GitHub-Repository auswählen. Render findet
   die Datei `render.yaml` selbst.
3. Bei der Abfrage der Umgebungsvariablen eintragen:
   - `PASSWORD`: ein langes Passwort (mindestens 8 Zeichen, besser 16 oder mehr)
   - `STREAM_TOKEN`: leer lassen, außer du brauchst die MJPEG-Adresse (siehe unten)
4. Nach dem Deploy bekommst du eine Adresse wie `https://druckerueberwachung-xxxx.onrender.com`.

Weiter mit **„iPhone einrichten“**.

> **Hinweis zum Gratistarif:** Kostenlose Server können nach einer Weile ohne
> Zugriffe schlafen gelegt werden und brauchen dann bis zu einer Minute zum Aufwachen.
> Die Kameraseite verbindet sich automatisch neu. Wenn dich das stört, nimm den
> kleinsten bezahlten Tarif oder Variante B. Die Bedingungen der Anbieter ändern sich
> gelegentlich, bitte bei Render nachlesen.
> Genauso funktioniert jeder andere Anbieter, der Node.js oder Docker ausführt
> und WebSockets unterstützt (z. B. Railway, Fly.io, ein eigener VPS).

## Variante B: Server zu Hause + Cloudflare Tunnel

Der Server läuft auf einem Rechner im Heimnetz. Ein **Cloudflare Tunnel** macht ihn
ohne Portfreigabe im Router per HTTPS aus dem Internet erreichbar.

### Server starten

Mit Docker (empfohlen):

```bash
git clone <dieses-repository> druckerueberwachung
cd druckerueberwachung
cp .env.example .env        # dann PASSWORD in .env eintragen
docker compose up -d --build
```

Oder direkt mit Node.js (ab Version 18):

```bash
npm ci --omit=dev
PASSWORD='dein-langes-passwort' npm start
```

Der Server läuft dann auf Port 8080.

### Aus dem Internet erreichbar machen

**Schnelltest ohne Konto:** (Die Adresse ändert sich bei jedem Start.)

```bash
cloudflared tunnel --url http://localhost:8080
```

Es erscheint eine Adresse wie `https://irgendwas.trycloudflare.com`. Die kannst du sofort nutzen.

**Dauerhaft mit fester Adresse** (dafür braucht es eine eigene Domain bei Cloudflare):

1. Im Cloudflare-Dashboard: **Zero Trust → Networks → Tunnels → Tunnel erstellen**
   (Typ „Cloudflared“).
2. Das angezeigte Token in `.env` als `TUNNEL_TOKEN=` eintragen.
3. Beim Tunnel einen **Public Hostname** anlegen, z. B. `drucker.deine-domain.de`,
   mit Service `http://druckerkamera:8080`.
4. Starten mit `docker compose --profile tunnel up -d --build`.

> Auch das iPhone im selben WLAN muss die **https://-Adresse des Tunnels** benutzen,
> nicht `http://192.168.…`. Ohne HTTPS verweigert Safari die Kamera.

---

## iPhone einrichten

1. **iPhone ans Ladekabel** und in eine Halterung mit Blick auf den Drucker.
   Für den Anfang reicht ein günstiger Handy-Schwanenhals oder eine 3D-gedruckte Halterung.
2. **Automatische Sperre ausschalten:**
   *Einstellungen → Anzeige & Helligkeit → Automatische Sperre → Nie*.
   Sonst geht das Display aus, und Safari stoppt die Kamera.
3. **Safari** öffnen, `https://<deine-adresse>/camera` aufrufen und mit dem Passwort anmelden.
4. **„Kamera starten“** antippen und den Kamerazugriff erlauben.
5. Empfohlen: **Geführter Zugriff**, damit Safari nicht versehentlich verlassen wird:
   *Einstellungen → Allgemein → Bedienungshilfen → Geführter Zugriff → ein*.
   Danach in Safari **dreimal die Home-Taste** drücken und „Starten“ antippen.
   Zum Beenden wieder dreimal drücken und den Code eingeben.
6. Optional: **„Bildschirm schwarz“** antippen und die Helligkeit im Kontrollzentrum
   ganz herunterdrehen. Antippen blendet die Anzeige wieder ein.
7. Weitere Tipps für den Dauerbetrieb:
   - Mitteilungen ausschalten oder *Nicht stören* aktivieren. Pop-ups können Safari unterbrechen.
   - Automatische App-Updates und den iCloud-Fotoupload ausschalten.
   - Nicht benötigte Apps beenden, damit das alte iPhone kühl und schnell bleibt.

Wird die Kameraseite doch einmal beendet (Anruf, Absturz, Neustart), zeigt die
Ansicht **„Kamera offline“**. Dann einfach `/camera` wieder öffnen und auf Start tippen.
Die Anmeldung bleibt gespeichert.

### Hinweis zu Akku und Wärme

Ein Handy, das monatelang am Ladekabel hängt, kann bei altem Akku auf Dauer
**aufquellen**. Lege das iPhone nicht direkt neben das heiße Druckbett oder in eine
geschlossene, warme Einhausung. Schau gelegentlich nach, ob sich das Gehäuse wölbt.
Eine Zeitschaltuhr, die das Ladegerät nachts ein paar Stunden abschaltet, schont den Akku.

## Zuschauen

`https://<deine-adresse>/` auf einem beliebigen Gerät öffnen und anmelden. Tipp: Auf dem
Handy „Zum Home-Bildschirm“ hinzufügen, dann ist es wie eine App erreichbar.

Unter **Kamera-Einstellungen** kannst du live umstellen:

| Einstellung | Bedeutung |
|---|---|
| Bildrate | Bilder pro Sekunde, solange mindestens ein Zuschauer da ist |
| Auflösung | Bildbreite in Pixeln (640 px ist ein guter Kompromiss) |
| JPEG-Qualität | höher = schärfer, aber mehr Daten |
| Ohne Zuschauer | wie oft ein Bild geschickt wird, wenn niemand zuschaut (für ein aktuelles Vorschaubild) |
| Drehung | falls das iPhone quer oder kopfüber montiert ist |
| Kamera am iPhone | Rück- oder Frontkamera (die Rückkamera ist deutlich besser) |

### Datenverbrauch (grobe Richtwerte bei 640 px, 60 %)

- Ein Bild ist etwa 30–60 KB groß.
- Beim Zuschauen mit 1 Bild/s: ca. 150 MB pro Stunde
- Ohne Zuschauer mit 1 Bild/min: ca. 60 MB pro Tag

Wenn du unterwegs per Mobilfunk zuschaust, lieber 320–480 px und 1 Bild alle 2 s wählen.

## Einbindung in andere Programme (optional)

Setze die Umgebungsvariable `STREAM_TOKEN` auf eine lange Zufallszeichenfolge
(mindestens 16 Zeichen, z. B. mit `openssl rand -hex 24` erzeugen). Dann gibt es:

- **MJPEG-Stream:** `https://<adresse>/stream.mjpg?token=<STREAM_TOKEN>`
  (OctoPrint: *Settings → Webcam → Stream URL*, Home Assistant: *MJPEG IP Camera*, VLC)
- **Einzelbild:** `https://<adresse>/snapshot.jpg?token=<STREAM_TOKEN>`
  (OctoPrint: *Snapshot URL*, z. B. für Zeitraffer)

Wer die Adresse samt Token kennt, kann das Bild sehen. Gib sie also nicht weiter.
Ohne `STREAM_TOKEN` funktionieren beide Adressen nur nach dem Login im Browser.

## Konfiguration

| Variable | Standard | Bedeutung |
|---|---|---|
| `PASSWORD` | – (Pflicht) | Passwort für Ansicht und Kamera, mindestens 8 Zeichen |
| `PORT` | `8080` | HTTP-Port |
| `STREAM_TOKEN` | leer | Aktiviert den Token-Zugriff auf `/stream.mjpg` und `/snapshot.jpg` |
| `SESSION_DAYS` | `180` | Wie lange ein Login gültig bleibt |

Wenn du das Passwort änderst, werden alle Geräte abgemeldet, auch das iPhone.

## Fehlersuche

| Problem | Lösung |
|---|---|
| „Dieser Browser erlaubt keinen Kamerazugriff“ | Seite in **Safari** und über **https://** öffnen. Andere Browser auf iOS 12 und Web-Apps vom Home-Bildschirm haben dort keinen Kamerazugriff. |
| „Kamerazugriff verweigert“ | *Einstellungen → Safari → Kamera* auf „Fragen“ stellen und Seite neu laden. |
| Ansicht zeigt „Kamera offline“ | Auf dem iPhone `/camera` öffnen und „Kamera starten“. Prüfen, ob die automatische Sperre auf „Nie“ steht. |
| Bild ruckelt oder kommt verzögert | Auflösung oder Qualität senken. Die Kamera lässt automatisch Bilder aus, wenn die Leitung nicht hinterherkommt. |
| Bild steht quer | Unter *Drehung* korrigieren oder die Ausrichtungssperre am iPhone einschalten. |
| „Eine andere Kamera hat übernommen“ | `/camera` wurde auf einem zweiten Gerät gestartet. Es gibt immer nur eine Kamera. |

## Entwicklung

```bash
npm install
PASSWORD=testtest123 npm start   # http://localhost:8080 (Kamera geht lokal nur auf localhost)
npm test
```

Aufbau:

- `server.js`: Node.js-Server (Login, WebSocket-Weiterleitung, MJPEG, Snapshot)
- `public/camera.html` + `camera.js`: Kameraseite für das iPhone (kompatibel mit Safari unter iOS 12)
- `public/index.html` + `viewer.js`: Ansicht mit Einstellungen
- `test/`: automatische Tests
