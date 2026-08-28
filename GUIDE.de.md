# Anleitung

Diese Anleitung führt Schritt für Schritt durch das Trittbrett Tool, vom ersten Verbinden bis zum
Sperren und Entsperren. Sie setzt nichts voraus.

## Was du brauchst

- Einen Trittbrett-E-Scooter. Die neueren Modelle (FRITZ, PAUL, SULTAN, HILDE, KALLE v2, EMMA v2) melden
  sich per Bluetooth mit einem Namen, der mit `zyd` oder `hw_` beginnt. Die älteren (KALLE v1, EMMA v1)
  heißen `Scooter`.
- Einen Browser mit Web Bluetooth: **Chrome** auf Android oder Desktop, **Bluefy** auf dem iPhone.
  Safari hat kein Web Bluetooth.
- Den Scooter an und in Reichweite.

## 1. Seite öffnen

Öffne die Seite im passenden Browser. Oben siehst du den Kopf mit dem Verbindungsstatus, dem
Hell/Dunkel-Schalter und der Sprachumschaltung DE/EN.

## 2. Modell wählen

In der Karte **Verbindung** steht ein Auswahlfeld. Am einfachsten lässt du es auf **Automatisch
erkennen**. Die Seite sucht dann alle Trittbrett-Scooter und stellt das Protokoll anhand des
Bluetooth-Namens ein, genau wie die Hersteller-App. Wer will, wählt sein Modell selbst.

Bei den ZYD-Modellen kann eine Modul-PIN nötig sein. Der Standard ist `888888` und schon eingetragen.

## 3. Verbinden

Tippe auf **Verbinden**. Der Browser zeigt eine Geräteliste. Wähle deinen Scooter. Nach dem Verbinden
steht der Status auf **verbunden** und die Live-Werte beginnen zu laufen.

## 4. Live-Werte lesen

Die Karte **Live-Werte** zeigt Geschwindigkeit, Akku, Spannung, Strom, die Temperaturen von Controller
und Motor sowie die Sperre. Die rohen Meldungen stehen zusätzlich als Hex im Protokoll-Log. Liefert dein
Modell ein Feld nicht, steht dort ein Strich.

## 5. Geschwindigkeit setzen (nur ZYD-Modelle)

In der Karte **Geschwindigkeit** stehen zwei Werte:

- **Offen (km/h):** der Wert, den **Entsperren** schreibt.
- **eKFV (km/h):** der Wert, den **Sperren** schreibt (Standard 22).

Der Knopf schreibt den jeweiligen Wert in das globale Limit-Register `0x20` (intern km/h mal 10). Die
App-eigene Grenze liegt bei 60 km/h. Beide Werte merkt sich der Browser auf deinem Gerät.

Wichtig: Ein Echo im Log heißt nur, dass der Controller das Kommando angenommen hat. Ob er den höheren
Wert wirklich fährt oder ihn klemmt, zeigt allein die Live-Geschwindigkeit beim Fahren. Der eigentliche
eKFV-Deckel sitzt in der Controller-Firmware.

## 6. Gang schalten (nur Legacy-Modelle)

Die älteren Modelle mit Namen `Scooter` haben kein Speed-Kommando über Bluetooth. Für sie erscheint die
Karte **Gang** mit den Knöpfen Gang D1 und Gang D2.

## 7. Weitere Einstellungen

Die Karte **Weitere Einstellungen** bietet je nach Modell die Wegfahrsperre (Diebstahlschutz), den
Tempomat (ZYD, über `AT+CRUISE`) und den Bluetooth-Namen.

## 8. Verknüpfungen

Ganz unten stehen Verknüpfungs-Adressen. Legst du dir auf dem Startbildschirm (Android) oder in Bluefy
(iOS) eine Verknüpfung darauf an, verbindet sich die Seite beim Öffnen mit dem zuletzt genutzten Scooter
und setzt sofort die Geschwindigkeit: eine Verknüpfung fürs Entsperren, eine fürs Sperren.

## Wenn etwas nicht klappt

- **Der Scooter taucht nicht in der Liste auf.** Ist er an und in Reichweite? Nutze den Knopf
  **Diagnose: alle Geräte** in der Log-Karte. Er zeigt jedes Bluetooth-Gerät, liest den echten Namen aus
  und listet nach dem Verbinden die GATT-Dienste. Danach den Log kopieren und schicken.
- **Verbindung bricht ab.** Bei den ZYD-Modellen hält ein Keep-Alive die Verbindung. Bleibt das Handy in
  Reichweite und die Seite offen.
- **Kein Feld füllt sich.** Prüfe im Log, ob überhaupt RX-Zeilen ankommen. Manche Modelle senden erst
  nach einer kurzen Anlaufzeit.

## Recht

Das Anheben der Höchstgeschwindigkeit hebt die Drossel auf. Die ABE erlischt und der Betrieb auf
öffentlichen Wegen ist dann nicht erlaubt. Nutze das Werkzeug nur am eigenen Fahrzeug auf privatem
Gelände und auf eigenes Risiko.
