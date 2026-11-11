#!/usr/bin/env python3
"""
Erzeugt aus der Handskizze ein BIM-Modell im IFC4-Format (Grundriss.ifc).

    pip install ifcopenshell ezdxf
    python grundriss_ifc.py   ->  Grundriss.ifc         (IFC4, aktueller Standard)
                                  Grundriss_IFC2X3.ifc  (IFC2X3, für ältere Viewer/Apps)

Die Grundrissmaße (Breite, Tiefe, Anbau, Wanddicke, Tür) kommen aus
grundriss_dxf.py, damit DXF und IFC immer übereinstimmen.
Einheit: Meter, untere linke Außenecke auf (0,0,0), Oberkante Rohfußboden = 0.

Aus der Ansicht in der Skizze übernommen
----------------------------------------
- Wandhöhe 3,00 m bis Oberkante Decke
- Drempel (Kniestock) 0,45 m über der Decke beim Hauptkörper
- Satteldach 40° über dem Hauptkörper, Giebel vorn (Türseite) und hinten
- Im Bereich des Erkers (Anbau) ist die Ost-Dachfläche mit gleicher Neigung
  heruntergezogen. Die Erkerwände enden schräg unter der Dachfläche,
  die Traufe am Erker liegt dadurch tiefer als am Hauptkörper.

Annahmen (in der Skizze nicht angegeben, unten änderbar)
--------------------------------------------------------
- Dachstärke 0,25 m (Dachüberstand 0,30 m ist vorgegeben)
- Deckenstärke 0,20 m, Bodenplatte 0,25 m
- Fenster: wie im DXF-Skript (Liste FENSTER), Brüstung 0,90 m, Höhe 1,26 m
"""

import math

import ifcopenshell
import ifcopenshell.api.aggregate
import ifcopenshell.api.context
import ifcopenshell.api.feature
import ifcopenshell.api.material
import ifcopenshell.api.owner
import ifcopenshell.api.project
import ifcopenshell.api.pset
import ifcopenshell.api.root
import ifcopenshell.api.spatial
import ifcopenshell.api.unit

from grundriss_dxf import (BREITE, FENSTER, TIEFE, TUER_BREITE,
                           TUER_HOEHE, TUER_X, WAND, X_ANBAU, Y_ANBAU_OBEN,
                           Y_ANBAU_UNTEN, aussenkontur, innenkontur)

# --------------------------------------------------------------------------
# Parameter für die 3. Dimension (Meter, Grad)
# --------------------------------------------------------------------------
WANDHOEHE = 3.00          # Oberkante Decke
DREMPEL = 0.45            # Kniestock über der Decke (Hauptkörper)
DACHNEIGUNG = 40.0        # Satteldach
DACHUEBERSTAND = 0.30     # waagerecht gemessen, an Traufe und Giebel
DACHSTAERKE = 0.25        # Annahme
DECKENSTAERKE = 0.20      # Annahme
BODENPLATTE = 0.25        # Annahme
FENSTER_BRUESTUNG = 0.90  # Annahme
FENSTER_HOEHE = 1.26      # Annahme

# Schema -> Dateiname. IFC2X3 wird zusätzlich erzeugt, weil viele Viewer
# (besonders ältere und mobile) nur dieses Schema lesen.
AUSGABE = {"IFC4": "Grundriss.ifc", "IFC2X3": "Grundriss_IFC2X3.ifc"}

TRAUFHOEHE = WANDHOEHE + DREMPEL   # Oberkante Außenwände Hauptkörper


# --------------------------------------------------------------------------
# Geometrie-Helfer (Low-Level-IFC, unabhängig von der ifcopenshell-Version)
# --------------------------------------------------------------------------
class Geo:
    def __init__(self, f, body):
        self.f = f
        self.body = body

    def pt(self, *c):
        return self.f.createIfcCartesianPoint([float(v) for v in c])

    def dir(self, *c):
        return self.f.createIfcDirection([float(v) for v in c])

    def profil(self, pts):
        """Geschlossenes Polygon-Profil aus 2D-Punkten."""
        p = [self.pt(x, y) for x, y in pts]
        return self.f.createIfcArbitraryClosedProfileDef(
            "AREA", None, self.f.createIfcPolyline(p + [p[0]]))

    def extrusion(self, pts, z0, hoehe):
        """Polygon in der XY-Ebene, auf Höhe z0 senkrecht nach oben extrudiert."""
        pos = self.f.createIfcAxis2Placement3D(self.pt(0, 0, z0), None, None)
        return self.f.createIfcExtrudedAreaSolid(
            self.profil(pts), pos, self.dir(0, 0, 1), float(hoehe))

    def quader(self, x0, y0, x1, y1, z0, z1):
        return self.extrusion([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], z0, z1 - z0)

    def extrusion_xz(self, pts_xz, y0, laenge):
        """Polygon in der XZ-Ebene (Ansicht), von y0 aus über 'laenge' in +Y extrudiert."""
        pos = self.f.createIfcAxis2Placement3D(
            self.pt(0, y0 + laenge, 0), self.dir(0, -1, 0), self.dir(1, 0, 0))
        return self.f.createIfcExtrudedAreaSolid(
            self.profil(pts_xz), pos, self.dir(0, 0, 1), float(laenge))

    def form(self, *koerper):
        rep = self.f.createIfcShapeRepresentation(
            self.body, "Body", "SweptSolid", list(koerper))
        return self.f.createIfcProductDefinitionShape(None, None, [rep])

    def platzierung(self, relativ_zu=None):
        achse = self.f.createIfcAxis2Placement3D(self.pt(0, 0, 0), None, None)
        return self.f.createIfcLocalPlacement(relativ_zu, achse)


# --------------------------------------------------------------------------
# Modell
# --------------------------------------------------------------------------
def setze(e, **attribute):
    """Setzt nur Attribute, die es im Schema der Datei gibt (IFC4 vs. IFC2X3)."""
    vorhanden = e.get_info(recursive=False)
    for k, v in attribute.items():
        if k in vorhanden:
            setattr(e, k, v)


def erzeuge(schema, dateiname):
    f = ifcopenshell.api.project.create_file(version=schema)
    ifc4 = schema != "IFC2X3"

    # Kopfdaten und Owner History (Ersteller, Programm). In IFC2X3 Pflicht,
    # in IFC4 optional – viele Viewer verlangen sie aber trotzdem.
    f.header.file_name.name = dateiname
    if not ifc4:
        f.header.file_description.description = ("ViewDefinition [CoordinationView_V2.0]",)
    f.header.file_name.author = ("Planer",)
    f.header.file_name.organization = ("Grundriss-Skript",)
    f.header.file_name.preprocessor_version = f"IfcOpenShell {ifcopenshell.version}"
    f.header.file_name.originating_system = "grundriss_ifc.py"
    f.header.file_name.authorization = "keine"
    person = ifcopenshell.api.owner.add_person(
        f, identification="Planer", family_name="Planer", given_name="")
    org = ifcopenshell.api.owner.add_organisation(
        f, identification="Grundriss", name="Grundriss-Skript")
    ifcopenshell.api.owner.add_person_and_organisation(f, person=person, organisation=org)
    ifcopenshell.api.owner.add_application(
        f, application_developer=org, version="1.0",
        application_full_name="grundriss_ifc.py (IfcOpenShell)",
        application_identifier="grundriss_ifc")

    def neu(cls, name=None, predefined=None):
        """Neues IfcRoot-Objekt; Typangaben schemagerecht ablegen."""
        e = ifcopenshell.api.root.create_entity(
            f, ifc_class=cls, name=name, predefined_type=predefined if ifc4 else None)
        if predefined and not ifc4:
            if cls == "IfcRoof":
                e.ShapeType = predefined
            elif cls == "IfcSpace":
                e.InteriorOrExteriorSpace = predefined
            elif cls == "IfcSlab":
                e.PredefinedType = predefined
        return e

    projekt = neu("IfcProject", "Grundriss")

    # Einheiten: Meter, m², m³, Grad
    einheiten = [
        f.createIfcSIUnit(None, "LENGTHUNIT", None, "METRE"),
        f.createIfcSIUnit(None, "AREAUNIT", None, "SQUARE_METRE"),
        f.createIfcSIUnit(None, "VOLUMEUNIT", None, "CUBIC_METRE"),
    ]
    rad = f.createIfcSIUnit(None, "PLANEANGLEUNIT", None, "RADIAN")
    grad = f.createIfcConversionBasedUnit(
        f.createIfcDimensionalExponents(0, 0, 0, 0, 0, 0, 0), "PLANEANGLEUNIT",
        "DEGREE", f.createIfcMeasureWithUnit(f.createIfcPlaneAngleMeasure(math.pi / 180), rad))
    ifcopenshell.api.unit.assign_unit(f, units=einheiten + [grad])

    modell = ifcopenshell.api.context.add_context(f, context_type="Model")
    body = ifcopenshell.api.context.add_context(
        f, context_type="Model", context_identifier="Body",
        target_view="MODEL_VIEW", parent=modell)
    g = Geo(f, body)

    # Räumliche Struktur: Grundstück > Gebäude > Erdgeschoss
    def raum_element(cls, name, eltern, **attr):
        e = neu(cls, name)
        setze(e, CompositionType="ELEMENT", **attr)
        ifcopenshell.api.aggregate.assign_object(f, products=[e], relating_object=eltern)
        return e

    site = raum_element("IfcSite", "Grundstück", projekt)
    site.ObjectPlacement = g.platzierung()
    gebaeude = raum_element("IfcBuilding", "Gebäude", site)
    gebaeude.ObjectPlacement = g.platzierung(site.ObjectPlacement)
    eg = raum_element("IfcBuildingStorey", "Erdgeschoss", gebaeude, Elevation=0.0)
    eg.ObjectPlacement = g.platzierung(gebaeude.ObjectPlacement)
    p_eg = eg.ObjectPlacement

    # Materialien
    mat = {n: ifcopenshell.api.material.add_material(f, name=n, category=k if ifc4 else None)
           for n, k in [("Mauerwerk", "masonry"), ("Stahlbeton", "concrete"),
                        ("Holz", "wood"), ("Glas", "glass")]}

    im_geschoss = []

    def bauteil(cls, name, form, material, predefined=None, psets=None, im_eg=True):
        e = neu(cls, name, predefined)
        e.ObjectPlacement = g.platzierung(p_eg)
        e.Representation = form
        if material:
            ifcopenshell.api.material.assign_material(f, products=[e], material=mat[material])
        for pset_name, werte in (psets or {}).items():
            ps = ifcopenshell.api.pset.add_pset(f, product=e, name=pset_name)
            ifcopenshell.api.pset.edit_pset(f, pset=ps, properties=werte)
        if im_eg:
            im_geschoss.append(e)
        return e

    wand_pset = {"Pset_WallCommon": {"IsExternal": True, "LoadBearing": True}}

    tan = math.tan(math.radians(DACHNEIGUNG))

    def z_dach_ost(x):
        """Unterkante der Ost-Dachfläche an der Stelle x (x >= Firstlinie)."""
        return TRAUFHOEHE - (x - BREITE) * tan

    def wand(name, x0, y0, x1, y1, z0, z1):
        return bauteil("IfcWall", name, g.form(g.quader(x0, y0, x1, y1, z0, z1)),
                       "Mauerwerk", "SOLIDWALL", wand_pset)

    def erkerwand(name, x0, x1, y0, y1):
        """Erkerwand, deren Oberkante der heruntergezogenen Dachfläche folgt."""
        profil = [(x0, 0), (x1, 0), (x1, z_dach_ost(x1)), (x0, z_dach_ost(x0))]
        return bauteil("IfcWall", name, g.form(g.extrusion_xz(profil, y0, y1 - y0)),
                       "Mauerwerk", "SOLIDWALL", wand_pset)

    # ---------------- Außenwände (gleiche Aufteilung wie im Grundriss) -----
    B, D, t, H = BREITE, TIEFE, WAND, TRAUFHOEHE
    yu, yo = Y_ANBAU_UNTEN, Y_ANBAU_OBEN
    waende = {
        "unten": wand("Außenwand Süd", 0, 0, B, t, 0, H),
        "rechts_unten": wand("Außenwand Ost unten", B - t, t, B, yu + t, 0, H),
        "rechts_oben": wand("Außenwand Ost oben", B - t, yo - t, B, D - t, 0, H),
        "oben": wand("Außenwand Nord", 0, D - t, B, D, 0, H),
        "links": wand("Außenwand West", 0, t, t, D - t, 0, H),
        "anbau_sued": erkerwand("Anbau Wand Süd", B, X_ANBAU, yu, yu + t),
        "anbau_ost": erkerwand("Anbau Wand Ost", X_ANBAU - t, X_ANBAU, yu + t, yo - t),
        "anbau_nord": erkerwand("Anbau Wand Nord", B, X_ANBAU, yo - t, yo),
        # Drempel über der Öffnung zum Anbau (trägt die Traufe)
        "drempel_anbau": wand("Drempel über Anbauöffnung", B - t, yu + t, B, yo - t,
                              WANDHOEHE, H),
    }

    # ---------------- Giebelwände (Dreieck über der Traufe) ---------------
    xf = B / 2                       # First in der Mitte
    zf = H + xf * tan                # Unterkante Dach am First
    giebel = [(0, H), (B, H), (xf, zf)]
    for name, y0 in [("Giebelwand Süd", 0.0), ("Giebelwand Nord", D - t)]:
        bauteil("IfcWall", name, g.form(g.extrusion_xz(giebel, y0, t)),
                "Mauerwerk", "SOLIDWALL", wand_pset)

    # ---------------- Bodenplatte, Decke ----------------------------------
    bauteil("IfcSlab", "Bodenplatte", g.form(g.extrusion(aussenkontur(), -BODENPLATTE, BODENPLATTE)),
            "Stahlbeton", "BASESLAB")
    bauteil("IfcSlab", "Decke über EG", g.form(
        g.extrusion(innenkontur(), WANDHOEHE - DECKENSTAERKE, DECKENSTAERKE)),
        "Stahlbeton", "FLOOR")

    # ---------------- Satteldach -------------------------------------------
    o, dv = DACHUEBERSTAND, DACHSTAERKE / math.cos(math.radians(DACHNEIGUNG))
    z_traufe = H - o * tan
    links = [(-o, z_traufe), (xf, zf), (xf, zf + dv), (-o, z_traufe + dv)]
    rechts = [(B + o, z_traufe), (B + o, z_traufe + dv), (xf, zf + dv), (xf, zf)]
    dach = neu("IfcRoof", "Satteldach", "GABLE_ROOF")
    dach.ObjectPlacement = g.platzierung(p_eg)
    im_geschoss.append(dach)
    # Schleppe über dem Erker: dieselbe Ebene wie die Ost-Dachfläche,
    # von deren Traufe bis Erker-Außenwand + Überstand heruntergezogen
    xa, xe = B + o, X_ANBAU + o
    schleppe = [(xa, z_dach_ost(xa)), (xe, z_dach_ost(xe)),
                (xe, z_dach_ost(xe) + dv), (xa, z_dach_ost(xa) + dv)]
    dach_pset = {"Pset_SlabCommon": {"IsExternal": True, "PitchAngle": DACHNEIGUNG}}
    dachflaechen = [
        bauteil("IfcSlab", "Dachfläche West", g.form(g.extrusion_xz(links, -o, D + 2 * o)),
                "Holz", "ROOF", dach_pset, im_eg=False),
        bauteil("IfcSlab", "Dachfläche Ost", g.form(
            g.extrusion_xz(rechts, -o, D + 2 * o),
            g.extrusion_xz(schleppe, yu - o, (yo - yu) + 2 * o)),
                "Holz", "ROOF", dach_pset, im_eg=False),
    ]
    ifcopenshell.api.aggregate.assign_object(f, products=dachflaechen, relating_object=dach)

    # ---------------- Öffnungen, Tür, Fenster ------------------------------
    def oeffnung(name, wand_el, x0, y0, x1, y1, z0, z1):
        op = neu("IfcOpeningElement", name, "OPENING")
        op.ObjectPlacement = g.platzierung(wand_el.ObjectPlacement)
        op.Representation = g.form(g.quader(x0, y0, x1, y1, z0, z1))
        ifcopenshell.api.feature.add_feature(f, feature=op, element=wand_el)
        return op

    eps = 0.05  # Öffnung etwas dicker als die Wand, damit sie sauber durchschneidet
    op = oeffnung("Öffnung Tür", waende["unten"], TUER_X, -eps, TUER_X + TUER_BREITE, t + eps,
                  0, TUER_HOEHE)
    zarge = 0.06
    x0, x1 = TUER_X, TUER_X + TUER_BREITE
    tuer = bauteil("IfcDoor", "Haustür", g.form(
        g.quader(x0, 0.10, x0 + zarge, t - 0.10, 0, TUER_HOEHE),              # Zarge links
        g.quader(x1 - zarge, 0.10, x1, t - 0.10, 0, TUER_HOEHE),              # Zarge rechts
        g.quader(x0, 0.10, x1, t - 0.10, TUER_HOEHE - zarge, TUER_HOEHE),     # Zarge oben
        g.quader(x0 + zarge, t / 2 - 0.02, x1 - zarge, t / 2 + 0.02, 0, TUER_HOEHE - zarge),  # Blatt
    ), "Holz", "DOOR", {"Pset_DoorCommon": {"IsExternal": True}})
    setze(tuer, OverallWidth=TUER_BREITE, OverallHeight=TUER_HOEHE,
          OperationType="SINGLE_SWING_LEFT")
    ifcopenshell.api.feature.add_filling(f, opening=op, element=tuer)

    for i, (seite, abstand, breite) in enumerate(FENSTER, start=1):
        z0, z1 = FENSTER_BRUESTUNG, FENSTER_BRUESTUNG + FENSTER_HOEHE
        if seite in ("unten", "oben"):
            ya, yb = (0.0, t) if seite == "unten" else (D - t, D)
            box = (abstand, ya, abstand + breite, yb)
            glas = (abstand, (ya + yb) / 2 - 0.02, abstand + breite, (ya + yb) / 2 + 0.02)
            ob = (box[0], ya - eps, box[2], yb + eps)
        elif seite == "links":
            box = (0.0, abstand, t, abstand + breite)
            glas = (t / 2 - 0.02, abstand, t / 2 + 0.02, abstand + breite)
            ob = (-eps, box[1], t + eps, box[3])
        else:
            raise ValueError(f"Unbekannte Wand: {seite}")
        op = oeffnung(f"Öffnung Fenster {i}", waende[seite], *ob, z0, z1)
        fe = bauteil("IfcWindow", f"Fenster {i}", g.form(g.quader(*glas, z0, z1)),
                     "Glas", "WINDOW", {"Pset_WindowCommon": {"IsExternal": True}})
        fe.OverallWidth, fe.OverallHeight = breite, FENSTER_HOEHE
        ifcopenshell.api.feature.add_filling(f, opening=op, element=fe)

    # ---------------- Raum --------------------------------------------------
    raum = neu("IfcSpace", "EG-01", "INTERNAL")
    raum.LongName = "Wohnraum"
    raum.ObjectPlacement = g.platzierung(p_eg)
    raum.Representation = g.form(g.extrusion(innenkontur(), 0, WANDHOEHE - DECKENSTAERKE))
    ifcopenshell.api.aggregate.assign_object(f, products=[raum], relating_object=eg)

    ifcopenshell.api.spatial.assign_container(f, products=im_geschoss, relating_structure=eg)

    # Objekte ohne Owner History (z. B. manche Beziehungen) nachträglich versorgen
    oh = next((e.OwnerHistory for e in f.by_type("IfcRoot") if e.OwnerHistory), None)
    for e in f.by_type("IfcRoot"):
        if e.OwnerHistory is None:
            e.OwnerHistory = oh

    f.write(dateiname)
    print(f"{dateiname} geschrieben ({schema}, {len(f.by_type('IfcProduct'))} Objekte).")


def main():
    for schema, dateiname in AUSGABE.items():
        erzeuge(schema, dateiname)


if __name__ == "__main__":
    main()
