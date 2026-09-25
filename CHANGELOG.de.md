# Änderungen

## 2026-09-25
- Standard-Rebuild: alle Telemetrie/Settings/erweiterten Settings, volles Log; Lock/Unlock funktional fuer Hilde 1 und Hilde 2 (belegter ZYD-Pfad).
- Security-Header (_headers: HSTS/CSP, robots findbar) und ein funktionaler pre-commit-Hook (scan-ok-Allowlist).


Neueste zuerst. Die Version (vNN) steht in der Fußzeile und steigt bei jedem Commit.

## v22
- Neu aufgebaut auf der lb-tool-web-Basis (das Tool ist wieder live): modernes Layout mit
  einklappbaren Karten, das komplette Log-Panel unten (Zeitstempel, TX/RX-Hex, Autoscroll,
  Anonymisieren- und Diagnose-Schalter, Kopieren/Leeren/Speichern), das dynamische Kachelraster und die
  aus dem Treiber (`controls()`) gerenderten Einstellungen und erweiterten Einstellungen.
- Funktionierendes Sperren/Entsperren (Tuning) für Hilde 1 und Hilde 2: beide sind als getestete Modelle
  wählbar und nehmen den identischen, belegten ZYD-Weg (Drossel = Register 0x20, Diebstahlsperre =
  Monitor-Bit 7).
- Der belegte ZYD-Treiber (drivers/zyd.js) und der Treiber-Kontrakt (drivers/base.js) aus lb-tool-web
  übernommen; nichts auf dem Draht ist erfunden. Eine Diagnose-Zeile für rohes TX-Hex ergänzt (passend
  zum RX).
- Entfernt: das Sunset-Banner, die Herstellerauswahl, die handgebaute Einstellungs-UI, das feste
  Kachelraster, die Copy-Paste-Shortcut-Karte (der `?do=fast`/`?do=slow`-Deeplink funktioniert weiter)
  und das Python-PoC.

## v20 und früher
- Eigenständiges Trittbrett-Tool: Verbinden, Live-Telemetrie, Drossel über Register 0x20, Gang-Schalter
  bei den Legacy-Modellen, Diebstahlsperre, Tempomat und Gerätename; anonymisiertes Log mit Geräte-Scan.
