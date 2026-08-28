# Guide

This guide walks through the Trittbrett tool step by step, from the first connect to lock and unlock.
It assumes nothing.

## What you need

- A Trittbrett e-scooter. The newer models (FRITZ, PAUL, SULTAN, HILDE, KALLE v2, EMMA v2) advertise a
  Bluetooth name starting with `zyd` or `hw_`. The older ones (KALLE v1, EMMA v1) are named `Scooter`.
- A browser with Web Bluetooth: **Chrome** on Android or desktop, **Bluefy** on iPhone. Safari has no
  Web Bluetooth.
- The scooter on and in range.

## 1. Open the page

Open the page in the right browser. The header at the top shows the connection status, the light/dark
toggle and the DE/EN language switch.

## 2. Pick your model

The **Connection** card has a dropdown. The easiest choice is **Auto detect**: the page scans all
Trittbrett scooters and picks the protocol from the Bluetooth name, exactly like the manufacturer app.
Or pick your model yourself.

The ZYD models may need a module PIN. The default is `888888` and already filled in.

## 3. Connect

Tap **Connect**. The browser shows a device list. Pick your scooter. After connecting the status reads
**connected** and the live values start to update.

## 4. Read the live values

The **Live values** card shows speed, battery, voltage, current, controller and motor temperature and
the lock state. The raw messages are also logged as hex. Where a model does not provide a field, a dash
is shown.

## 5. Set the speed (ZYD models only)

The **Speed** card has two values:

- **Open (km/h):** the value that **Unlock** writes.
- **eKFV (km/h):** the value that **Lock** writes (default 22).

The button writes the respective value into the global limit register `0x20` (internally km/h times 10).
The app's own ceiling is 60 km/h. Both values are remembered in your browser.

Important: an echo in the log only means the controller accepted the command. Whether it actually rides
the higher value or caps it shows only in the live speed while riding. The real top-speed cap sits in
the controller firmware.

## 6. Switch gears (legacy models only)

The older models named `Scooter` have no speed command over Bluetooth. For them the **Gear** card
appears with the Gear D1 and Gear D2 buttons.

## 7. More settings

The **More settings** card offers, depending on the model, the immobilizer (anti-theft), cruise control
(ZYD, via `AT+CRUISE`) and the Bluetooth name.

## 8. Shortcuts

At the bottom you find shortcut addresses. Add a home-screen shortcut (Android) or a Bluefy shortcut
(iOS) to one, and opening it reconnects to the last scooter and sets the speed at once: one shortcut for
unlock, one for lock.

## If something does not work

- **The scooter does not appear in the list.** Is it on and in range? Use the **Diagnostics: all
  devices** button in the log card. It shows every Bluetooth device, reads the real name and lists the
  GATT services after connecting. Then copy the log and send it.
- **The connection drops.** On the ZYD models a keep-alive holds the link. Keep the phone in range and
  the page open.
- **No field fills in.** Check the log for incoming RX lines. Some models only start after a short
  warm-up.

## Legal

Raising the top speed removes the throttle limit. The road approval lapses and riding on public roads is
then not allowed. Use the tool only on your own vehicle on private ground and at your own risk.
