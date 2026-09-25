> 🚨 **This tool is moving.** This repository is **no longer maintained** - please switch to the new tool: **[lb-tool-web.pages.dev](https://lb-tool-web.pages.dev/)**. Trouble switching? Open an [issue on GitHub](https://github.com/Laufbursche42/Laufbursche42/issues/new) or send a [PM on the eScooter-Stammtisch forum](https://www.escooter-stammtisch.de/index.php?user/6497-laufbursche/).

# Laufbursche Trittbrett Tool

A static web page that talks to a Trittbrett e-scooter over Web Bluetooth. It reads the live telemetry
and, on the newer ZYD models, writes the global speed-limit register straight from the browser. Nothing
to install: no app store, no signing, no developer account. It runs in **Bluefy** on iOS and in
**Chrome** or **Edge** on Android or desktop.

> **This is a feasibility study.** It exists to show what a Trittbrett scooter's Bluetooth protocol
> makes possible, not to be a finished product. Error-free operation is not promised and there is no
> warranty of any kind. Whatever you do with it, you do at your own risk. Read the
> [Disclaimer](#DISCLAIMER) before you connect a scooter.

**Open the web app: [laufbursche42.github.io/tb-unlock](https://laufbursche42.github.io/tb-unlock/)**

Or run it yourself, no build step, no dependencies: clone the repo and serve the folder over a local
HTTP server. Opening `index.html` directly as a `file://` URL will not work, the page fetches its own
documents and browsers block that over `file://`.

```
git clone https://github.com/Laufbursche42/tb-unlock.git
cd tb-unlock
python -m http.server 8000
```

Then open the printed address in a browser that supports Web Bluetooth.

**Guide: [Deutsch](GUIDE.de.md) | [English](GUIDE.md)** covers every step, from the first connect to
lock and unlock.

**On Android?** There is a native Android app that does the same over Bluetooth, without a browser:
**[tb-lb-edition](https://github.com/Laufbursche42/tb-lb-edition)**. It sidesteps the Web Bluetooth
quirks - some phones, for example Samsung with Auto Blocker on, block the browser connection.

## What it does

- **Live telemetry** from the scooter: speed, mode, battery, lock, turn signal, voltage, current, power,
  controller and motor temperature, trip and total distance, cruise, error, firmware, capacity and
  display version, decoded from the ZYD monitor frames. Only the values the model reports appear.
- **Speed limiter (the Drossel)** on the ZYD models (FRITZ, PAUL, SULTAN, Hilde 1, Hilde 2, KALLE v2,
  EMMA v2): "Limiter off" and "Limiter on" write the global limit register `0x20` (value km/h times 10).
  The values are editable; the tool's own ceiling is 60 km/h. That register has no readback on the wire,
  so the button state is local memory only and resets on every fresh connect. It is a different thing
  from the immobilizer lock, which is the scooter's own separate vehicle lock.
- **Immobilizer** (anti-theft lock) as an Unlock / Lock pair on the ZYD models; on the legacy `Scooter`
  units it is the simple `FF 55 17` lock. Its live state is shown as the Lock tile.
- **Settings and advanced settings:** headlight, ambient light, gear (D / T), zero-start, cruise off,
  unit, cruise limit, device name and four sound tracks; plus the register writes (throttle response,
  modulation depth, pole pairs, currents, undervoltage protection, wheel size, carrier frequency, timers,
  service interval), each confirmed first.
- **A full protocol log** you can copy, clear or save, with an anonymize toggle for public sharing and a
  diagnostic toggle that logs every frame TX and RX as hex.

The page picks the protocol from the advertised BLE name, exactly like the manufacturer app
(`com.planm.trittbrett`): a name starting with `zyd` or `hw_` is a ZYD model, the name `Scooter` is the
legacy path. There is no encryption and no session key in either family; the only optional
authentication is a plaintext module PIN over `AT+PWD` (default `888888`), which the tool sends only when
you fill in the PIN field.

> **Unlocking the app is not the same as unlocking the scooter.** Writing a higher value into register
> `0x20` only means the app sends it. Whether the setting takes effect is decided by the firmware on the
> controller, which validates every value and can silently cap or reject it. A controller-firmware string
> suggests a possible clamp near 22 km/h, so whether the register actually raises the top speed is an
> open question that only a test on a real vehicle answers.

## License

PolyForm Noncommercial 1.0.0 with additional terms, in full in [LICENSE.md](LICENSE.md).

## Privacy

Nothing leaves your device but the page load itself. The details are in [PRIVACY.md](PRIVACY.md).

## Trademarks

An independent project, not affiliated with Trittbrett. "Trittbrett" and other product names are
trademarks of their respective owners and are used here only to say which scooters this page works with.
See [TRADEMARKS.md](TRADEMARKS.md).
