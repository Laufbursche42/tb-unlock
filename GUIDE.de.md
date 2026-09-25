# Trittbrett Anleitung

Das Trittbrett Tool verbindet sich per Web Bluetooth mit deinem Scooter, liest die Live-Werte und nimmt bei den neueren ZYD-Modellen die Drossel heraus. Alles läuft direkt auf dieser Seite, ohne Installation.

## Was du brauchst

- Einen Trittbrett-E-Scooter. Die neueren ZYD-Modelle (FRITZ, PAUL, SULTAN, Hilde 1, Hilde 2, KALLE v2, EMMA v2) melden sich per Bluetooth mit einem Namen, der mit `zyd` oder `hw_` beginnt. Die älteren KALLE v1 und EMMA v1 melden sich als `Scooter`.
- Einen Browser mit Web Bluetooth: Chrome oder Edge auf Android und Desktop, Bluefy auf iPhone und iPad. Safari hat kein Web Bluetooth.
- Den Scooter eingeschaltet und in Reichweite. Schließe zuerst die Trittbrett-App, denn sie hält die einzige Bluetooth-Verbindung und verdeckt den Scooter.

## Modell wählen

- Öffne den Abschnitt Verbindung. Oben erscheinen gemerkte Scooter für das Wiederverbinden mit einem Tipp, sofern die Plattform es zulässt.
- Stelle den Modellfilter auf getestet, ungetestet oder alle. Die Modellliste ist alphabetisch.
- Lass das Modell auf Auto-Erkennung (empfohlen): Das Tool liest den Bluetooth-Namen und wählt selbst den ZYD- oder den Legacy-Weg. Zum Festlegen wähle **Hilde 1** oder **Hilde 2** aus der Liste (Filter "getestet" zeigt nur die beiden Hildes). Beide nehmen den identischen ZYD-Weg, die Auswahl wirkt also gleich.
- Die Modul-PIN ist optional. Leer lassen, außer dein Scooter lehnt die Verbindung ohne PIN ab; der Standard der App ist `888888`. Ein leeres Feld sendet keine PIN.

## Unterstützte Modelle

Welche Geräte unterstützt werden, mit ihrem Teststatus (aus der Modell-Registry):

{{DEVICES:tb}}

## Verbinden

- Tippe auf Verbinden. Auf iPhone und iPad läuft das in Bluefy, auf Android und Desktop in Chrome oder Edge. Beim ersten Mal fragt das System nach dem Koppeln.
- Wähle deinen Scooter in der Liste. Trittbrett-Namen sind instabil (zum Beispiel "Hilde 135..." oder "ePFHilde"), deshalb zeigt das Tool alle Geräte in der Nähe; wähle deinen anhand des Namens.
- Nach dem Verbinden steht der Status auf verbunden und die Live-Werte beginnen zu laufen. Der Rest der Seite erscheint jetzt.
- Taucht der Scooter nicht auf, prüfe, ob er an, in Reichweite und nicht noch von der Trittbrett-App belegt ist. Die Log-Karte unten hält jede Meldung fest; nutze Kopieren, Leeren oder Als .txt speichern, um ein Diagnose-Log zu sichern.

## Entsperren (Drossel)

- Der Abschnitt Drossel hat zwei Werte: Offen (km/h) ist der Wert, den du willst, Legal (km/h) ist der zugelassene eKFV-Wert (Standard 22).
- "Drossel raus" schreibt den Wert Offen, "Drossel rein" schreibt den Wert Legal. Das Anheben der Höchstgeschwindigkeit fragt vorher nach einer Bestätigung. Beide Zahlen merkt sich der Browser auf deinem Gerät.
- Im Hintergrund schreibt das den globalen Limit-Register `0x20` (intern km/h mal zehn). Die tool-eigene Grenze liegt bei 60 km/h. Hilde 1 und Hilde 2 nutzen genau diesen Weg.
- Dieses Register hat keine Rückmeldung, deshalb ist der Knopfzustand nur ein lokaler Merker und wird bei jedem neuen Verbinden zurückgesetzt.
- Ein Echo im Log heißt nur, dass der Controller das Kommando angenommen hat. Ob er den höheren Wert wirklich fährt oder ihn klemmt, zeigt allein die Live-Geschwindigkeit beim Fahren; der eigentliche Deckel für die Höchstgeschwindigkeit sitzt in der Controller-Firmware.
- Legacy-Modelle mit Namen `Scooter` haben kein Speed-Kommando über Bluetooth. Für sie bleibt die Drossel inaktiv; nutze stattdessen den Gang-Schalter (D / T) in den Einstellungen.

## Live-Werte

- Die Kacheln zeigen nur die Werte, die dein Scooter wirklich meldet: meist Tempo, Modus, Akku, Sperre, Blinker, Spannung, Strom, Leistung, Controller- und Motortemperatur, Tages- und Gesamtstrecke, Tempomat, Fehler, Firmware, Kapazität und Display-Version. Einen Wert, den das Modell nicht sendet, blendet das Tool aus.
- Blende eine Kachel über ihr X aus und ziehe die Kacheln zum Umordnen; Auswahl und Reihenfolge merkt sich dein Gerät.
- Die Kachel Sperre ist die Fahrzeug-Sperre des Scooters selbst (nur Anzeige). Sie ist etwas anderes als die Drossel im vorigen Schritt.

## Einstellungen

- Einstellungen und Erweiterte Einstellungen erscheinen, sobald du verbunden bist. Schalter-Einstellungen nutzen einen eigenen AN- und AUS-Knopf, nie ein Auswahlfeld.
- Die Einstellungen bieten die Diebstahlsperre (Entsperren / Sperren), Scheinwerfer, Umgebungslicht, Gang (D / T), Nullstart, Tempomat aus, die Einheit (km/h oder mph), das Tempomat-Limit, den Gerätenamen und vier Tonspuren (Start, Abschaltung, Hupe, Alarm).
- Die Erweiterten Einstellungen sind Register-Schreibvorgänge und fragen jeweils zuerst nach einer Bestätigung: Gas-Beschleunigung und Gas-Bremsung, Modulationstiefe, Polpaare, Entlade- und Bremsstrom, Unterspannungsschutz, Radgröße, Trägerfrequenz, Tempomat-Zeit, Abschaltzeit und das Wartungsintervall. Ein falscher Wert kann den Controller fehlkonfigurieren.
- Bei den Legacy-Modellen (Scooter) gibt es nur den Gang-Schalter und die einfache Diebstahlsperre.

## Shortcuts

- `?do=fast` löst "Drossel raus" (den Offen-Wert) aus, `?do=slow` löst "Drossel rein" (den Legal-Wert) aus, einmal nach dem Wiederverbinden. Lege einen Startbildschirm-Shortcut (Android) oder einen Bluefy-Shortcut (iOS) auf einen davon für ein Entsperren oder Sperren mit einem Tipp.

## Rechtliches

Das Anheben der Höchstgeschwindigkeit entfernt die Drossel. Die Betriebserlaubnis (ABE) erlischt und der Betrieb auf öffentlichen Wegen ist dann nicht erlaubt. Nutze das Tool nur am eigenen Fahrzeug auf privatem Grund und auf eigenes Risiko.
