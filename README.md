# Kamera-Streaming: iPhone 7 beobachtet meinen 3D-Drucker

## Ziel
Ein altes iPhone 7 steht vor meinem Bambu-Lab-A1-mini-Drucker und sendet sein Kamerabild live. Ich schaue es von überall auf meinem iPad an (Browser). Mehr nicht: Der Drucker selbst wird weiter nur über die Bambu-App gesteuert. Es gibt keine Verbindung zum Drucker.

## Ausgangslage
- Sender: iPhone 7 mit iOS 15 (Safari). Es hängt dauerhaft am Strom.
- Empfänger: iPad (aktuelles iPadOS), auch von unterwegs.
- Kostenlose Streaming-Apps und Alfred Camera sind keine Option (Bildqualität, Einschränkungen).
- Ich bin kein Programmierer. Erkläre Schritte einfach, und teste selbst, bevor du etwas als fertig meldest.
- Ich arbeite hauptsächlich mit dem iPad, bitte alles so planen, dass ich es dort bedienen kann.

## Gewünschtes Ergebnis
1. Eine **Sender-Seite**: Auf dem iPhone im Safari öffnen, Kamera erlauben, Stream starten.
2. Eine **Zuschauer-Seite**: Auf dem iPad öffnen, Live-Bild sehen.
3. **Zugangsschutz**: Nur ich darf das Bild sehen (Passwort oder geheimer Link). Das Bild zeigt meine Wohnung, es darf nie öffentlich zugänglich sein.
4. Läuft **kostenlos** (oder fast kostenlos) und ohne Rechner bei mir zu Hause.

## Technischer Ansatz (Vorschlag, bitte prüfen)
- Kamerazugriff im Browser über `getUserMedia`, Übertragung per **WebRTC** (direkt zwischen iPhone und iPad).
- Ein kleiner **Vermittlungsserver** (Signaling) bei einem kostenlosen Hosting-Dienst. Er stellt nur die Verbindung her, das Video läuft nicht über ihn.
- Alles über **HTTPS**, sonst erlaubt iOS den Kamerazugriff nicht.
- Von unterwegs (Mobilfunk) reicht ein reiner STUN-Server oft nicht aus. Dann wird ein **TURN-Server** gebraucht. Prüfe, ob ein kostenloser Anbieter dafür reicht, und erkläre mir die Grenzen.
- Alternative, falls WebRTC zu kompliziert ist: Einzelbilder in kurzen Abständen hochladen und anzeigen (weniger flüssig, dafür robuster).

## Bekannte Stolpersteine auf dem iPhone 7
- iOS 15 kennt die Funktion "Bildschirm wach halten" im Browser noch nicht. Lösung: In den iPhone-Einstellungen die automatische Sperre auf "Nie" stellen, und optional "Geführter Zugriff" nutzen, damit Safari nicht versehentlich geschlossen wird.
- iOS beendet die Kamera, wenn Safari in den Hintergrund geht oder das Gerät sperrt. Die Sender-Seite muss deshalb im Vordergrund offen bleiben.
- Das iPhone wird bei Dauerbetrieb warm und der Akku leidet. Ladeeinstellung beachten, nicht in einen engen Bereich stellen.
- Safari auf iOS 15 ist älter. Keine neuen Browser-Funktionen verwenden, die dort fehlen. Teste, was wirklich auf dem Gerät läuft.

## Vorgehen für Claude Code
1. Zuerst mit mir klären, wo der Server kostenlos laufen soll (Vorschlag von dir, mit Vor- und Nachteilen).
2. Kleinsten Prototyp bauen: Sender-Seite und Zuschauer-Seite im selben WLAN, ohne Passwort.
3. Danach HTTPS, Zugangsschutz und Zugriff von außen ergänzen.
4. Zuletzt Stabilität: Verbindungsabbrüche, automatisches Neuverbinden, Bildqualität.
5. Nach jedem Schritt kurz erklären, was getestet wurde und wie ich es selbst mit iPhone und iPad ausprobiere.
