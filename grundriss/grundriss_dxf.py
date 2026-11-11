#!/usr/bin/env python3
"""
Erzeugt den Grundriss aus der Handskizze als maßstabsgetreue 2D-DXF-Datei.

    pip install ezdxf
    python grundriss_dxf.py          ->  Grundriss.dxf

Einheit: Meter (1 Zeichnungseinheit = 1 m). Die untere linke Außenecke liegt auf (0,0).

Aus der Skizze übernommene Maße
-------------------------------
- Hauptkörper außen: 7,49 m breit, 9,99 m tief
- Anbau rechts: 0,99 m tief (nach außen), 1,99 m lang,
  Abstand von der oberen Außenecke: 2,00 m
- Wanddicke: 0,49 m
- Tür in der unteren Wand: 1,01 m breit, 2,26 m hoch (Maß "1,01 / 2,26")

Annahmen (in der Skizze nicht bemaßt, unten in den Parametern anpassbar)
------------------------------------------------------------------------
- Lage der Tür: linke Türkante 4,40 m von der linken Außenecke (aus der Skizze abgegriffen)
- Die Tür schlägt nach innen auf, Anschlag links.
- Fenster sind in der Skizze nicht eingezeichnet. Der Layer "Fenster" wird angelegt;
  Fenster können in der Liste FENSTER ergänzt werden.
"""

import ezdxf
from ezdxf import units
from ezdxf.enums import TextEntityAlignment

# --------------------------------------------------------------------------
# Parameter (alle Maße in Meter)
# --------------------------------------------------------------------------
BREITE = 7.49            # Außenbreite Hauptkörper (x)
TIEFE = 9.99             # Außentiefe Hauptkörper (y)
WAND = 0.49              # Wanddicke Außenwände

ANBAU_TIEFE = 0.99       # Vorsprung des Anbaus nach rechts
ANBAU_LAENGE = 1.99      # Länge des Anbaus entlang der rechten Wand
ANBAU_ABSTAND_OBEN = 2.00  # Abstand obere Außenecke -> Oberkante Anbau

TUER_X = 4.40            # linke Türkante (Annahme, aus Skizze abgegriffen)
TUER_BREITE = 1.01
TUER_HOEHE = 2.26

# Fenster: Liste von (Wand, Abstand vom Wandanfang, Breite)
#   Wand: "unten" / "oben" (Abstand ab x=0), "links" (Abstand ab y=0)
#   Beispiel: ("links", 3.00, 1.26)
FENSTER = []

DATEINAME = "Grundriss.dxf"

# Layer: Name -> (AutoCAD-Farbnummer, Linienstärke in 1/100 mm)
LAYER = {
    "Aussenwaende": (7, 50),   # weiß/schwarz, 0,50 mm
    "Fenster":      (4, 25),   # cyan
    "Tueren":       (1, 25),   # rot
    "Bemassung":    (3, 18),   # grün
}

# --------------------------------------------------------------------------
# Abgeleitete Koordinaten
# --------------------------------------------------------------------------
X_ANBAU = BREITE + ANBAU_TIEFE              # 8,48
Y_ANBAU_OBEN = TIEFE - ANBAU_ABSTAND_OBEN   # 7,99
Y_ANBAU_UNTEN = Y_ANBAU_OBEN - ANBAU_LAENGE  # 6,00


def aussenkontur():
    """Außenkontur gegen den Uhrzeigersinn, Start unten links (0,0)."""
    return [
        (0.0, 0.0),
        (BREITE, 0.0),
        (BREITE, Y_ANBAU_UNTEN),
        (X_ANBAU, Y_ANBAU_UNTEN),
        (X_ANBAU, Y_ANBAU_OBEN),
        (BREITE, Y_ANBAU_OBEN),
        (BREITE, TIEFE),
        (0.0, TIEFE),
    ]


def innenkontur():
    """Innenkontur (um WAND nach innen versetzt), gleiche Reihenfolge wie außen."""
    w = WAND
    return [
        (w, w),
        (BREITE - w, w),
        (BREITE - w, Y_ANBAU_UNTEN + w),
        (X_ANBAU - w, Y_ANBAU_UNTEN + w),
        (X_ANBAU - w, Y_ANBAU_OBEN - w),
        (BREITE - w, Y_ANBAU_OBEN - w),
        (BREITE - w, TIEFE - w),
        (w, TIEFE - w),
    ]


def wand_polylinie():
    """
    Eine geschlossene Polylinie, die den Wandquerschnitt umrandet, mit
    Aussparung für die Türöffnung in der unteren Wand:
    Außenkontur ab rechter Türkante gegen den Uhrzeigersinn bis zur linken
    Türkante, durch die Wand nach innen, Innenkontur zurück, wieder nach außen.
    """
    t0, t1 = TUER_X, TUER_X + TUER_BREITE
    aussen = aussenkontur()
    innen = innenkontur()
    pts = [(t1, 0.0)] + aussen[1:] + [aussen[0], (t0, 0.0)]
    pts += [(t0, WAND), innen[0]] + innen[1:][::-1] + [(t1, WAND)]
    return pts


def setup_dokument():
    doc = ezdxf.new("R2010", setup=True)
    doc.units = units.M
    doc.header["$MEASUREMENT"] = 1          # metrisch
    doc.header["$LUNITS"] = 2               # Dezimal
    doc.header["$LUPREC"] = 2

    for name, (farbe, staerke) in LAYER.items():
        doc.layers.add(name, color=farbe, lineweight=staerke)

    # Bemaßungsstil für Meter mit 2 Nachkommastellen und Dezimalkomma
    ds = doc.dimstyles.new("Meter")
    ds.dxf.dimtxt = 0.18      # Texthöhe
    ds.dxf.dimasz = 0.12      # Pfeilgröße
    ds.dxf.dimexo = 0.05      # Abstand Hilfslinie zum Objekt
    ds.dxf.dimexe = 0.10      # Hilfslinie über Maßlinie hinaus
    ds.dxf.dimgap = 0.05      # Abstand Text zur Maßlinie
    ds.dxf.dimdec = 2         # Nachkommastellen
    ds.dxf.dimdsep = ord(",")  # Dezimalkomma
    ds.dxf.dimzin = 0         # keine Nullen unterdrücken (z. B. 0,49)
    ds.dxf.dimtad = 1         # Text über der Maßlinie
    ds.dxf.dimtih = 0         # Text parallel zur Maßlinie
    ds.dxf.dimtoh = 0
    ds.dxf.dimblk = "ARCHTICK"  # Architektur-Schrägstrich
    ds.dxf.dimlunit = 2
    return doc


def zeichne_waende(msp):
    msp.add_lwpolyline(wand_polylinie(), close=True,
                       dxfattribs={"layer": "Aussenwaende"})


def zeichne_tuer(msp):
    a = {"layer": "Tueren"}
    t0, t1 = TUER_X, TUER_X + TUER_BREITE
    # Türblatt (geöffnet, 90° nach innen, Anschlag links)
    msp.add_lwpolyline([(t0, WAND), (t0 + 0.04, WAND),
                        (t0 + 0.04, WAND + TUER_BREITE), (t0, WAND + TUER_BREITE)],
                       close=True, dxfattribs=a)
    # Aufschlagbogen
    msp.add_arc(center=(t0, WAND), radius=TUER_BREITE,
                start_angle=0, end_angle=90, dxfattribs=a)
    # Schwelle / Laibungslinie außen
    msp.add_line((t0, 0.0), (t1, 0.0), dxfattribs=a)
    # Beschriftung Breite / Höhe
    msp.add_text(f"T {TUER_BREITE:.2f} / {TUER_HOEHE:.2f}".replace(".", ","),
                 height=0.15, dxfattribs=a).set_placement(
        ((t0 + t1) / 2, WAND + TUER_BREITE + 0.15),
        align=TextEntityAlignment.BOTTOM_CENTER)


def zeichne_fenster(msp):
    a = {"layer": "Fenster"}
    for wand, abstand, breite in FENSTER:
        if wand in ("unten", "oben"):
            y0, y1 = (0.0, WAND) if wand == "unten" else (TIEFE - WAND, TIEFE)
            x0, x1 = abstand, abstand + breite
            msp.add_lwpolyline([(x0, y0), (x1, y0), (x1, y1), (x0, y1)],
                               close=True, dxfattribs=a)
            ym = (y0 + y1) / 2
            msp.add_line((x0, ym), (x1, ym), dxfattribs=a)  # Glaslinie
        elif wand == "links":
            x0, x1 = 0.0, WAND
            y0, y1 = abstand, abstand + breite
            msp.add_lwpolyline([(x0, y0), (x1, y0), (x1, y1), (x0, y1)],
                               close=True, dxfattribs=a)
            xm = (x0 + x1) / 2
            msp.add_line((xm, y0), (xm, y1), dxfattribs=a)
        else:
            raise ValueError(f"Unbekannte Wand: {wand}")


def bemassung(msp):
    a = {"layer": "Bemassung"}

    def dim(p1, p2, base, angle):
        d = msp.add_linear_dim(base=base, p1=p1, p2=p2, angle=angle,
                               dimstyle="Meter", dxfattribs=a)
        d.render()

    # unten: Gesamtbreite und Türlage
    dim((0, 0), (BREITE, 0), (0, -1.10), 0)
    dim((0, 0), (TUER_X, 0), (0, -0.55), 0)
    dim((TUER_X, 0), (TUER_X + TUER_BREITE, 0), (0, -0.55), 0)
    dim((TUER_X + TUER_BREITE, 0), (BREITE, 0), (0, -0.55), 0)

    # oben: Hauptkörper und Anbau
    dim((0, TIEFE), (BREITE, TIEFE), (0, TIEFE + 0.60), 0)
    dim((BREITE, TIEFE), (X_ANBAU, Y_ANBAU_OBEN), (0, TIEFE + 0.60), 0)

    # links: Gesamttiefe
    dim((0, 0), (0, TIEFE), (-0.70, 0), 90)

    # rechts: Anbau-Lage
    xr = X_ANBAU + 0.60
    dim((BREITE, TIEFE), (X_ANBAU, Y_ANBAU_OBEN), (xr, 0), 90)
    dim((X_ANBAU, Y_ANBAU_OBEN), (X_ANBAU, Y_ANBAU_UNTEN), (xr, 0), 90)
    dim((X_ANBAU, Y_ANBAU_UNTEN), (BREITE, 0), (xr, 0), 90)

    # Wanddicke (linke Wand, oben im Raum)
    dim((0, TIEFE - 1.50), (WAND, TIEFE - 1.50), (0, TIEFE - 1.50), 0)


def main():
    doc = setup_dokument()
    msp = doc.modelspace()
    zeichne_waende(msp)
    zeichne_fenster(msp)
    zeichne_tuer(msp)
    bemassung(msp)

    auditor = doc.audit()
    if auditor.has_errors:
        auditor.print_error_report()
    doc.set_modelspace_vport(height=TIEFE + 4, center=(X_ANBAU / 2, TIEFE / 2))
    doc.saveas(DATEINAME)
    print(f"{DATEINAME} geschrieben.")


if __name__ == "__main__":
    main()
