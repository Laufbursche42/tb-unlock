# Changelog

## 2026-09-25
- Standard rebuild: all telemetry/settings/advanced, full log; functional lock/unlock for Hilde 1 and Hilde 2 (documented ZYD path).
- Security headers (_headers: HSTS/CSP, robots findable) and a functional pre-commit hook (scan-ok allowlist).


Newest first. The version (vNN) is in the footer and goes up on every commit.

## v22
- Rebuilt on the lb-tool-web shell (the tool is live again): modern collapsible-card layout, the full
  bottom log panel (timestamped, TX/RX hex, autoscroll, anonymize + diagnostic toggles, copy/clear/save),
  the dynamic live-tile grid and the driver `controls()` settings + advanced settings.
- Functional lock/unlock (tuning) for Hilde 1 and Hilde 2: both are selectable tested models and take the
  identical proven ZYD path (Drossel = register 0x20, immobilizer = monitor bit 7).
- Ported the proven ZYD driver (drivers/zyd.js) and the driver contract (drivers/base.js) from
  lb-tool-web; nothing on the wire is invented. Added a diagnostic raw TX-hex log line to match RX.
- Removed the sunset banner, the manufacturer picker, the hand-built settings UI, the fixed tile grid,
  the copy-paste shortcut card (the `?do=fast`/`?do=slow` deep link still works) and the Python PoC.

## v20 and earlier
- Standalone Trittbrett tool: connect, live telemetry, register-0x20 speed limiter, gear switch on the
  legacy models, immobilizer, cruise and device name; anonymized log with a diagnostics scan.
