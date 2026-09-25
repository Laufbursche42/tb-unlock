'use strict';
// Common driver contract for the Laufbursche Tool, transcribed from DRIVER-INTERFACE.md (v2).
// Every interactive manufacturer driver extends BaseDriver and fills the pieces its family needs.
// Static manufacturers (info pages) do NOT use this - see StaticEntry in the registry.
//
// Honesty rule: a driver never invents values. Anything unproven is marked verify.status = 'unverified'
// and its control stays hidden (expose:false) until confirmed on a device.

// ---- enums / confidence -----------------------------------------------------
const Confidence = Object.freeze({ PROVEN: 'proven', INFERRED: 'inferred', UNVERIFIED: 'unverified' });

const LockKind = Object.freeze({
  Immobilizer: 'immobilizer',
  SpeedLimiter: 'speedLimiter',
  BatteryLock: 'batteryLock',
  DisplayPin: 'displayPin',
  RegionLock: 'regionLock',
  SeatRelease: 'seatRelease',
  ElectronicLock: 'electronicLock',
  IoTLock: 'iotLock',
  Lock4: 'lock4',
  Fingerprint: 'fingerprint',
  CodeLock: 'codeLock',
});
const LockState = Object.freeze({ LOCKED: 'locked', UNLOCKED: 'unlocked', UNKNOWN: 'unknown' });

// Wrap a decoded value with its provenance so the UI can badge unverified data.
function value(v, raw, status, opts) {
  return Object.assign({ value: v, raw: raw == null ? null : raw, verify: { verified: status === Confidence.PROVEN, status: status || Confidence.PROVEN } }, opts || {});
}

// ---- base driver ------------------------------------------------------------
// A concrete driver overrides the wire-level bits; the shell only ever calls this contract.
class BaseDriver {
  constructor(cfg) {
    this.cfg = cfg || {};              // the manufacturer registry entry
    this.id = this.cfg.driver || 'base';
    this.kind = 'interactive';
    this.model = null;                 // resolved ModelProfile after detect/override
    this.device = null;
    this.server = null;
    this.channels = {};                // id -> { char map }
    this._log = (m, cls) => {};        // injected by the shell
    this._onTelemetry = () => {};      // injected by the shell
    this.diag = false;                 // diagnostic raw-frame log (protocol-free; drivers supply the tap)
    this._diagTaps = [];               // extra notify chars tapped only while diag is on
  }

  // shell wiring
  bind(hooks) { this._log = hooks.log || this._log; this._onTelemetry = hooks.onTelemetry || this._onTelemetry; return this; }

  // ---- capability surface (shell reads these) ----
  // Which features to show for the resolved model. Only what is necessary/relevant per model
  // is exposed; everything else stays expose:false (retained in the driver, hidden in the UI).
  capabilities() { return this.model ? (this.model.caps || {}) : {}; }
  models() { return this.cfg.models || []; }

  // ---- controls surface (shell renders these) ----
  // Ordered list of control descriptors for the currently resolved model (this.model), per
  // CONTROLS-CONTRACT.md. Each descriptor carries { key, kind, group, labelKey?, risky?, ...kind
  // fields }, with kind one of 'toggle'|'stepper'|'segmented'|'text'|'action'|'lock' and group one of
  // 'lock'|'settings'|'advanced'. The shell renders each kind (no dropdowns) and routes every write
  // back by the control's own key: setSetting(key, value) for the settings/advanced kinds, and
  // setLock(lockKind, on) for kind:'lock'. BaseDriver advertises nothing; every interactive driver
  // overrides this. Unproven or device-only actions are omitted (honesty rule, DRIVER-INTERFACE.md
  // §9) so they can never be triggered from the assembled tool.
  controls() { return []; }

  // ---- detection / model ----
  detectModel(advName, gatt, mfrData) {
    // Default: first model; families with real name/UUID rules override this.
    const ms = this.models();
    return this.model = (ms[0] || { key: 'auto', label: 'Auto', caps: {}, tested: false });
  }
  setModelOverride(key) {
    const m = this.models().find(x => x.key === key);
    if (m) this.model = m;
    return this.model;
  }
  // overrideRequired models (Egret EY/GT/GTs/GTc, ...) cannot be told apart by device name.
  overrideRequired() { return !!(this.model && this.model.overrideRequired); }
  refineModelProfile(mp, tel, firmware) { return mp; }

  // ---- connect lifecycle ----
  // requestDevice options come from the registry (namePrefixes / optionalServices / acceptAllDevices).
  requestOptions() {
    const b = this.cfg.ble || {};
    if (b.acceptAllDevices) return { acceptAllDevices: true, optionalServices: b.optionalServices || [] };
    const filters = (b.deviceNamePrefixes || []).map(p => ({ namePrefix: p }));
    if (b.serviceUUIDs && b.serviceUUIDs.length) filters.push({ services: b.serviceUUIDs });
    return filters.length ? { filters, optionalServices: b.optionalServices || [] }
                          : { acceptAllDevices: true, optionalServices: b.optionalServices || [] };
  }
  async connect(device) {
    this.device = device;
    this.server = await device.gatt.connect();
    await this.discover();
    if (this.handshakeRequired && this.handshakeRequired()) await this.handshake();
    if (this.postConnectConfig) await this.postConnectConfig();
    this.startTelemetry();
  }
  async discover() { /* families map their channels/characteristics here */ }

  handshakeRequired() { return false; }         // Egret EY overrides -> true (14-byte + PIN 0000, MANDATORY)
  async handshake(keys) { /* family-specific pairing/handshake */ }
  async postConnectConfig() { /* SoFlow fixed-40 + maxCapableSpeed, etc. */ }

  startTelemetry() { /* subscribe to notify chars or start pollTelemetry */ }
  // MANDATORY safe teardown - ZYD families must leave transparent/UF mode or the scooter latches.
  async stopTelemetry() { /* families override (sendStopTran, etc.) */ }
  async disconnect() {
    try { await this.stopTelemetry(); } catch (e) {}
    try { if (this.server && this.server.connected) this.server.disconnect(); } catch (e) {}
    this.device = this.server = null;
  }

  // ---- actions (families implement the wire; the shell calls these) ----
  // Speed limiter (in/out). risky writes are confirmation-gated by the shell.
  async setSpeedOpen(kmh) { return this._todo('setSpeedOpen'); }
  async setSpeedLegal(kmh) { return this._todo('setSpeedLegal'); }
  async setSetting(key, value) { return this._todo('setSetting:' + key); }

  // Lock family. VR/VMAX lock semantics stay unverified+gated until on-device confirmed.
  async setLock(kind, on, opts) { return this._todo('setLock:' + kind); }
  async queryLockState(kind) { return LockState.UNKNOWN; }

  async readTelemetry() { return {}; }
  async sendRawFrame(bytes, channel) { return this._todo('sendRawFrame'); }

  _todo(what) { this._log('not implemented in this driver: ' + what, 'log-err'); return { ok: false }; }

  // ---- diagnostic raw-frame logging (drivers call _rawRx from their own reassembly) ----
  _hexBytes(arr) {   // bytes -> "55 71 03 .."; non-numbers (masked 'XX') printed as-is
    return Array.prototype.map.call(arr, function (b) {
      return (typeof b === 'number') ? (b & 0xFF).toString(16).toUpperCase().padStart(2, '0') : String(b);
    }).join(' ');
  }
  _shortUuid(uuid) {   // 16-bit alias -> "XXXX", else last 4 nibbles
    var u = String(uuid || '').toLowerCase();
    var m = u.match(/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/);
    if (m) return m[1].toUpperCase();
    return (u.replace(/[^0-9a-f]/g, '').slice(-4).toUpperCase()) || 'RX';
  }
  // redact(arr) may mask personal bytes (e.g. to 'XX'); space-separated keeps it readable past the anonymizer.
  _rawRx(label, bytes, redact) {
    if (!this.diag) return;
    var arr = Array.prototype.slice.call(bytes);
    if (typeof redact === 'function') { try { arr = redact(arr) || arr; } catch (e) {} }
    this._log('RX ' + (label || 'rx') + ' ' + this._hexBytes(arr), 'log-rx');
  }
  _diagSkipUuids() { return []; }   // drivers return their own notify uuid(s) so base does not double-tap
  setDiag(on) {   // on: tap every other notify char; off: remove taps. Safe before connect.
    this.diag = !!on;
    if (this.diag) { this._diagTapExtraNotify().catch(function () {}); }
    else { this._diagUntap(); }
    return this.diag;
  }
  // Tap every other notify/indicate char for raw logging (no redaction: format unknown).
  async _diagTapExtraNotify(skipUuids) {
    if (!this.diag || !this.server) return;
    var skip = {};
    (skipUuids || this._diagSkipUuids() || []).forEach(function (u) { if (u) skip[String(u).toLowerCase()] = true; });
    this._diagTaps = this._diagTaps || [];
    var have = {}; this._diagTaps.forEach(function (t) { have[t.uuid] = true; });
    var services = [];
    try { services = await this.server.getPrimaryServices(); } catch (e) { services = []; }
    for (var i = 0; i < services.length; i++) {
      var chars = [];
      try { chars = await services[i].getCharacteristics(); } catch (e) { chars = []; }
      for (var j = 0; j < chars.length; j++) {
        var c = chars[j], uuid = String(c.uuid || '').toLowerCase(), p = c.properties || {};
        if ((!p.notify && !p.indicate) || skip[uuid] || have[uuid]) continue;
        var label = this._shortUuid(uuid), self = this;
        var handler = (function (lbl) {
          return function (ev) {
            var dv = ev.target.value, a = [];
            for (var k = 0; k < dv.byteLength; k++) a.push(dv.getUint8(k));
            self._rawRx(lbl, a);
          };
        })(label);
        try {
          c.addEventListener('characteristicvaluechanged', handler);
          c.startNotifications().catch(function () {});
          this._diagTaps.push({ uuid: uuid, char: c, handler: handler });
          have[uuid] = true;
          this._log('diag: tapping extra notify ' + label, 'log-rx');
        } catch (e) {}
      }
    }
  }
  _diagUntap() {
    var taps = this._diagTaps || [];
    for (var i = 0; i < taps.length; i++) {
      try { taps[i].char.removeEventListener('characteristicvaluechanged', taps[i].handler); } catch (e) {}
      try { taps[i].char.stopNotifications().catch(function () {}); } catch (e) {}
    }
    this._diagTaps = [];
  }
}

// Firmware patchers are NOT part of this interface (decision 9.1): they live in separate webpatcher
// repos and are loaded into a modal iframe by the shell. No patchFirmware/otaFlash here.

const LB = { Confidence, LockKind, LockState, value, BaseDriver };
if (typeof window !== 'undefined') window.LB = LB;
if (typeof module !== 'undefined') module.exports = LB;
