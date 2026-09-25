# Trittbrett guide

The Trittbrett tool connects to your scooter over Web Bluetooth, reads its live values and, on the newer ZYD models, takes the limiter off. Everything runs from this page, with nothing to install.

## What you need

- A Trittbrett e-scooter. The newer ZYD models (FRITZ, PAUL, SULTAN, Hilde 1, Hilde 2, KALLE v2, EMMA v2) advertise a Bluetooth name starting with `zyd` or `hw_`. The older KALLE v1 and EMMA v1 advertise the name `Scooter`.
- A browser with Web Bluetooth: Chrome or Edge on Android and desktop, Bluefy on iPhone and iPad. Safari has no Web Bluetooth.
- The scooter switched on and within range. Close the Trittbrett app first, because it holds the single Bluetooth connection and hides the scooter.

## Choose your model

- Open the Connection section. Remembered scooters appear at the top for one-tap reconnect where the platform allows it.
- Set the model filter to tested, untested or all. The model list is alphabetical.
- Leave the model on Auto detect (recommended): the tool reads the Bluetooth name and chooses the ZYD or the legacy path by itself. To be explicit, pick **Hilde 1** or **Hilde 2** from the list (set the filter to "tested" to see just the two Hildes). Both take the identical ZYD path, so either choice works the same.
- The module PIN is optional. Leave it empty unless your scooter refuses the connection without it; the app default is `888888`. An empty field sends no PIN.

## Supported models

Which devices are supported, with their test status (from the model registry):

{{DEVICES:tb}}

## Connect

- Tap Connect. On iPhone and iPad this runs in Bluefy, on Android and desktop in Chrome or Edge. The system asks to pair the first time.
- Pick your scooter in the chooser. Trittbrett names are unstable (for example "Hilde 135..." or "ePFHilde"), so the tool shows all nearby devices; choose yours by name.
- Once linked, the status reads connected and the live values start to update. The rest of the page appears now.
- If the scooter does not show up, check that it is on, in range and not still held by the Trittbrett app. The Log card at the bottom records every message; use Copy, Clear or Save as .txt to keep a diagnostic log.

## Unlock (Drossel)

- The Speed limiter section has two values: Open (km/h) is the value you want, Legal (km/h) is the approved eKFV value (default 22).
- "Limiter off" (Drossel raus) writes the Open value; "Limiter on" (Drossel rein) writes the Legal value. Raising the top speed asks for a confirmation first. Both numbers are remembered in your browser.
- Under the hood this writes the global limit register `0x20` (internally km/h times ten). The tool's own ceiling is 60 km/h. Hilde 1 and Hilde 2 use exactly this path.
- That register has no readback, so the button state is local memory only and resets on every fresh connect.
- An echo in the log only means the controller accepted the command. Whether it actually rides the higher value or caps it shows only in the live speed while riding; the real top-speed cap sits in the controller firmware.
- Legacy Scooter models have no speed command over Bluetooth. For them the limiter stays inactive; use the Gear control (D / T) in Settings instead.

## Live values

- The tiles show only the values your scooter actually reports: typically speed, mode, battery, lock, turn signal, voltage, current, power, controller and motor temperature, trip and total distance, cruise, error, firmware, capacity and display version. A value the model does not send stays hidden.
- Hide a tile with its X and drag the tiles to reorder them; the set and order are remembered on your device.
- The Lock tile is the scooter's own vehicle immobilizer (display only). It is a different thing from the Speed limiter in the previous step.

## Settings

- Settings and Advanced settings appear once you are connected. Toggle settings use an explicit ON and OFF button, never a dropdown.
- Settings offers the immobilizer (anti-theft lock, an Unlock / Lock pair), headlight, ambient light, gear (D / T), zero-start, cruise off, the unit (km/h or mph), the cruise limit, the device name and four sound tracks (start, shutdown, horn, alarm).
- Advanced settings are register writes and each asks for confirmation first: throttle acceleration and braking, modulation depth, pole pairs, discharge and brake current, undervoltage protection, wheel size, carrier frequency, cruise time, shutdown time and the service interval. A wrong value here can misconfigure the controller.
- On the legacy Scooter models only the gear switch and the simple immobilizer are available.

## Shortcuts

- `?do=fast` runs "Limiter off" (the Open value) and `?do=slow` runs "Limiter on" (the Legal value) once after the scooter reconnects. Add a home-screen shortcut (Android) or a Bluefy shortcut (iOS) to one of these for a one-tap unlock or lock.

## Legal

Raising the top speed removes the throttle limit. The road approval (ABE) lapses and riding on public roads is then not allowed. Use the tool only on your own vehicle on private ground and at your own risk.
