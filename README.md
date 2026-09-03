# Laufbursche Trittbrett Tool

A static web page that talks to a Trittbrett e-scooter over Web Bluetooth. It reads the live telemetry
and, on the newer ZYD models, writes the global speed-limit register straight from the browser. Nothing
to install: no app store, no signing, no developer account. It runs in **Bluefy** on iOS and in
**Chrome** on Android or desktop.

> **This is a feasibility study.** It exists to show what a Trittbrett scooter's Bluetooth protocol
> makes possible, not to be a finished product. Error-free operation is not promised and there is no
> warranty of any kind. Whatever you do with it, you do at your own risk. Read the
> [Disclaimer](#disclaimer) before you connect a scooter.

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

**Guide: [Deutsch](GUIDE.de.md) | [English](GUIDE.en.md)** covers every step, from the first connect to
lock and unlock.

**On Android?** There is a native Android app that does the same over Bluetooth, without a browser:
**[tb-lb-edition](https://github.com/Laufbursche42/tb-lb-edition)**. It sidesteps the Web Bluetooth
quirks - some phones, for example Samsung with Auto Blocker on, block the browser connection.

## What it does

- **Live telemetry** from the scooter: speed, battery, voltage, current, controller and motor
  temperature and the lock state, decoded from the ZYD monitor frames.
- **Set the speed limit** on the ZYD models (FRITZ, PAUL, SULTAN, HILDE, KALLE v2, EMMA v2): the
  Unlock/Lock button writes the global limit register `0x20` (value km/h times 10). The values are
  editable; the app's own ceiling is 60 km/h.
- **Gear switch** on the legacy models (KALLE v1 / EMMA v1, Bluetooth name "Scooter"), which have no
  BLE speed command.
- **Immobilizer, cruise control and Bluetooth name** where the model supports them.
- **A full protocol log** you can copy and share, plus a diagnostics scan that lists every device and
  its GATT services.

The page picks the protocol from the advertised BLE name, exactly like the manufacturer app
(`com.planm.trittbrett`): a name starting with `zyd` or `hw_` is a ZYD model, the name `Scooter` is the
legacy path.

> **Unlocking the app is not the same as unlocking the scooter.** Writing a higher value into register
> `0x20` only means the app sends it. Whether the setting takes effect is decided by the firmware on the
> controller, which validates every value and can silently cap or reject it. The real top-speed cap sits
> in the controller firmware. Whether the BLE register raises it is an open question that only a test on
> a real vehicle answers.

## Disclaimer

**Please read this in full before you unlock a scooter.**

- **This is a feasibility study**, not a finished product. It shows what the scooter's Bluetooth
  protocol makes possible. Nothing here promises that it works with your scooter, your phone or your
  browser, or that it still works after the next controller firmware or browser release.
- **Unlocking ends the road approval.** A scooter that no longer holds the eKFV limit is not a road-legal
  eKFV any more. The operating permit (Betriebserlaubnis) is void, and the insurance cover goes with it.
- **Ride it on private property only.** Riding a derestricted scooter in public traffic is an offence in
  Germany: no operating permit, no insurance. The liability is entirely yours.
- **No liability** and **no warranty** of function, correctness or fitness for a particular purpose.
- Everything you do with this page is **at your own risk**.

By using this page you accept these terms.

## License

PolyForm Noncommercial 1.0.0 with two additional terms, in full in [LICENSE.md](LICENSE.md).

## Privacy

Nothing leaves your device but the page load itself. The details are in [PRIVACY.md](PRIVACY.md).

## Trademarks

An independent project, not affiliated with Trittbrett. "Trittbrett" and other product names are
trademarks of their respective owners and are used here only to say which scooters this page works with.
See [TRADEMARKS.md](TRADEMARKS.md).
