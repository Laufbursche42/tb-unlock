'use strict';
// ZYD driver (zyd) - serves ONLY Trittbrett (tb) and VMAX classic (vmax). EPF dropped from the tool.
// Family: zydtech / HobbyWing MODBUS register protocol (zyd-modbus) on F1F0 data + F2F0 AT,
// plus Trittbrett-only legacy FF55/LEN transport (ff55-legacy) on service 7777.
// Everything below is reconciled 1:1 to the proven old tools tb-unlock/app.js and vmax-unlock/app.js:
// where a spec says UNSURE/UNVERIFIED the decode is tagged unverified; where a wire is not
// proven the method returns {ok:false} via _todo with a TODO(unproven) note.
window.DRIVERS = window.DRIVERS || {};
// Diag redaction on the DATA channel: mask the serial (01 08) and the ESC-info uniquecode (01 07, off 64..79).
function zydRedactData(arr) {
  if (arr[0] !== 0x01) return arr;
  if (arr[1] === 0x08) { for (let i = 5; i < arr.length; i++) arr[i] = 'XX'; return arr; }
  if (arr[1] === 0x07) {
    const off = ((arr[2] & 0xFF) << 8) | (arr[3] & 0xFF);
    if (off >= 64 && off < 80) for (let i = 5; i < arr.length; i++) arr[i] = 'XX';
  }
  return arr;
}

window.DRIVERS['zyd'] = class extends LB.BaseDriver {
  constructor(cfg) {
    super(cfg);
    this._family = 'zyd';          // 'zyd' | 'legacy' (legacy = Trittbrett "Scooter" LEN path only)
    this.pin = null;               // optional plaintext module PIN (AT+PWD); default 888888 per spec, not auto-sent
    this._chars = {};              // resolved GATT characteristics
    this._tel = {};                // last decoded telemetry
    // cached base-param switch state (from Frame A) + per-mode limits (from Frame B)
    this._bp = { gear: 0, head: false, ambient: false, cruise: false, boot: false, unit: false, lock: false };
    this._limitCruise = 0; this._m1 = 0; this._m2 = 0; this._m3 = 0;
    this._thousandUnits = false;
    this._swSeen = false; this._baseSeen = false; this._baseReady = false;
    this._hb = null;               // heartbeat interval handle
    this._atWaiters = [];          // pending AT-reply resolvers
    this._pwd = { ok: null };      // AT+PWD acceptance state
    this._ekfv = 22;               // eKFV legal-limit target; vmax derives live unlock from it (app.js:545)
    this._esc = [];                // streamed ESC-info (0x07) reassembly buffer
  }

  // ---- helpers: UUIDs / CRC / frame builders -------------------------------
  _u(short) { return '0000' + short.toString(16).padStart(4, '0') + '-0000-1000-8000-00805f9b34fb'; }
  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  _ascii(s) { return Array.prototype.map.call(String(s), c => c.charCodeAt(0) & 0xff); }
  _u16(v) { return [(v >> 8) & 0xff, v & 0xff]; }

  _crc16(bytes) {                  // CRC-16/MODBUS, appended low byte first
    let crc = 0xFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i] & 0xff;
      for (let b = 0; b < 8; b++) crc = (crc & 1) ? (crc >>> 1) ^ 0xA001 : crc >>> 1;
    }
    return [crc & 0xff, (crc >> 8) & 0xff];
  }
  _withCrc(body) { return body.concat(this._crc16(body)); }

  // 8-byte read/request: 01 cmd addrHi addrLo cntHi cntLo crcLo crcHi
  _read(cmd, addr, cnt) { return this._withCrc([0x01, cmd & 0xff].concat(this._u16(addr), this._u16(cnt))); }
  // RW parameter write (0x17): 01 17 addr words addr words bcount <value..> crc
  _rwParam(addr, valueBytes) {
    const words = valueBytes.length / 2;
    const a = this._u16(addr), w = this._u16(words);
    return this._withCrc([0x01, 0x17].concat(a, w, a, w, [valueBytes.length], valueBytes));
  }
  // 10-byte monitor/base-param write: AB 00 0A status limitCruise m1 m2 m3 crc (crc over 0..7)
  _monitor(status, limitCruise, m1, m2, m3) {
    return this._withCrc([0xAB, 0x00, 0x0A, status & 0xff, limitCruise & 0xff, m1 & 0xff, m2 & 0xff, m3 & 0xff]);
  }
  // control frame (no CRC): A5 cmd ~cmd 00 00 00 00 5A
  _ctrl(cmd) { return [0xA5, cmd & 0xff, (~cmd) & 0xff, 0, 0, 0, 0, 0x5A]; }
  _keep() { return [0xA5, 0x02, 0xFD, 0x5A]; }
  // legacy FF55: FF 55 op len <payload..> checksum (additive 8-bit of all preceding)
  _ff55(op, payload) {
    const b = [0xFF, 0x55, op & 0xff, payload.length].concat(payload);
    let s = 0; for (let i = 0; i < b.length; i++) s = (s + b[i]) & 0xff;
    return b.concat([s]);
  }
  _statusByte() {
    const b = this._bp;
    let s = b.gear & 0x03;
    if (b.head) s |= 1 << 2; if (b.ambient) s |= 1 << 3; if (b.cruise) s |= 1 << 4;
    if (b.boot) s |= 1 << 5; if (b.unit) s |= 1 << 6; if (b.lock) s |= 1 << 7;
    return s;
  }
  _monitorFrame() { return this._monitor(this._statusByte(), this._limitCruise, this._m1, this._m2, this._m3); }

  // ---- write plumbing ------------------------------------------------------
  // Prefer writeValueWithResponse (WRITE_TYPE_DEFAULT), like tb-unlock writeFrame: the ZYD controller can
  // silently drop a no-response register write (setSpeed/lock, param writes), so never inherit no-response.
  async _writeChar(ch, bytes) {
    const u8 = Uint8Array.from(bytes);
    if (ch.writeValueWithResponse) { try { return await ch.writeValueWithResponse(u8); } catch (e) {} }
    if (ch.writeValueWithoutResponse) { try { return await ch.writeValueWithoutResponse(u8); } catch (e) {} }
    return ch.writeValue(u8);
  }
  // Raw TX-hex diag line, mirroring base._rawRx (DATA/LEG). Log-only, gated by diag; no wire change.
  _rawTx(label, bytes) {
    if (!this.diag) return;
    this._log('TX ' + (label || 'tx') + ' ' + this._hexBytes(Array.prototype.slice.call(bytes)), 'log-tx');
  }
  _writeData(bytes) { this._rawTx('DATA', bytes); return this._writeChar(this._chars.dataTx, bytes); }
  _writeLegacy(bytes) { this._rawTx('LEG', bytes); return this._writeChar(this._chars.legTx, bytes); }
  async _at(cmd) {
    if (this._family === 'legacy' || !this._chars.atTx) return this._todo('AT channel unavailable');
    await this._writeChar(this._chars.atTx, this._ascii(cmd)); return { ok: true };
  }

  // ---- detection / model ---------------------------------------------------
  detectModel(advName, gatt, mfrData) {
    const id = this.cfg.id, name = advName || '';
    if (id === 'tb') {
      if (name === 'Scooter') { this._family = 'legacy'; this.model = this.models().find(m => m.key === 'legacy') || null; }
      else { this._family = 'zyd'; this.model = this.models().find(m => m.caps && m.caps.bleSpeed) || this.models()[0] || null; }
    } else {
      // vmax: single model, name gating by hw_/zyd_ in the shell; legacy path unverified -> unused.
      this._family = 'zyd'; this.model = this.models()[0] || null;
    }
    return this.model;
  }
  setModelOverride(key) {
    const m = this.models().find(x => x.key === key);
    if (m) { this.model = m; if (this.cfg.id === 'tb') this._family = (key === 'legacy') ? 'legacy' : 'zyd'; }
    return this.model;
  }
  setPin(p) { this.pin = p; return this; }

  // ---- capabilities: expose only what the resolved model proves; retain rest hidden ----
  capabilities() {
    if (this._family === 'legacy') {
      // Trittbrett legacy "Scooter": gear switch + simple immobilizer only; no BLE speed.
      return { gearShift: true, immobilizer: true, speedLimitOpenLock: false, codeLock: false /*app-only, not in web tool -> hidden*/ };
    }
    // tb and vmax expose the same set: monitor switches + reg writes + AT sound/name.
    // No advanced-param READ (old tb/vmax never issue a 0x03 read); no password setter
    // (old tb/vmax only auth via AT+PWD at connect, never AT+PWDM); codeLock is app-only -> hidden.
    // Keys are ALIGNED 1:1 with the setSetting() case names / controls() keys (contract parity item
    // capkey-vs-setsetting-key-mismatch): ambientLight->ambient, unitToggle->unit, cruiseMode->cruise,
    // deviceRename->name, rideMode->gear. No wire byte/opcode/characteristic changes - names only.
    return {
      speedLimitOpenLock: true, gear: true,   // gear = ride mode (monitor bits 0-1); speed limiter = speedLimitOpenLock
      headlight: true, ambient: true, cruise: true, zeroStart: true,
      unit: true, immobilizer: true, name: true,
      advancedParamsWrite: true,   // register writes (CMD_RW_PARAMETER 0x17) proven for tb/vmax
      soundPack: true,             // exposed as controls startSound/shutdownSound/hornSound/alarmSound (AT+MP3/31/32/34)
    };
  }

  // ---- controls (contract §1): ordered descriptors for the RESOLVED model (this.model) only ----
  // Mined 1:1 from the proven old tools (tb-unlock / vmax-unlock SETTINGS[]). Every non-lock key here
  // is an exact setSetting() case that routes to a real wire write (no _todo default); the unified
  // immobilizer is the single kind:'lock' control (setLock(Immobilizer,...), zyd monitor bit7 /
  // legacy FF55 0x17). The speed limiter (register 0x20 max speed) stays the hard-wired Lock-section limiter
  // (setSpeedOpen / setSpeedLegal) and is NOT a control. Gated/unproven items emit no control:
  // per-mode limits m1/m2/m3 (ecoLimit/comfortLimit/sportLimit), cruise-ON, and the legacy app-only
  // codeLock - all stay _todo-gated in the driver.
  controls() {
    if (!this.model) return [];
    const K = LB.LockKind;
    // Unified immobilizer: proven on both families (zyd monitor bit7, legacy FF55 0x17).
    const immo = { key: 'immobilizer', kind: 'lock', group: 'lock', lockKind: K.Immobilizer, labelKey: 'ctlImmobilizer' };
    const gear = {
      key: 'gear', kind: 'segmented', group: 'settings', labelKey: 'ctlGear',
      options: [{ value: 0, labelKey: 'ctlGearD' }, { value: 1, labelKey: 'ctlGearT' }],
    };
    if (this._family === 'legacy') {
      // Trittbrett legacy "Scooter": gear switch + immobilizer only. No BLE speed, no AT, no registers.
      return [immo, gear];
    }
    // ZYD models (tb FRITZ/PAUL/SULTAN/HILDE/KALLE v2/EMMA v2 + vmax): monitor switches, AT name/sound,
    // register writes. serviceKm register differs per model (vmax 0x49 / tb 0x4A) - handled in setSetting.
    return [
      immo,
      // -- everyday (group:'settings') --
      { key: 'headlight', kind: 'toggle', group: 'settings', labelKey: 'ctlHeadlight' },
      { key: 'ambient',   kind: 'toggle', group: 'settings', labelKey: 'ctlAmbient' },
      gear,
      { key: 'zeroStart', kind: 'toggle', group: 'settings', labelKey: 'ctlZeroStart' },
      // cruise is OFF-only in the old tools (cruise-ON gated); a one-shot "turn cruise off" action.
      { key: 'cruise', kind: 'action', group: 'settings', labelKey: 'ctlCruise', actionLabelKey: 'ctlCruiseOff' },
      {
        key: 'unit', kind: 'segmented', group: 'settings', labelKey: 'ctlUnit',
        options: [{ value: 'kmh', labelKey: 'ctlUnitKmh' }, { value: 'mph', labelKey: 'ctlUnitMph' }],
      },
      { key: 'limitCruise', kind: 'stepper', group: 'settings', labelKey: 'ctlLimitCruise', min: 0, max: 60, step: 1, unit: 'km/h' },
      { key: 'name', kind: 'text', group: 'settings', labelKey: 'ctlName', maxLength: 16, placeholderKey: 'ctlNamePlaceholder' },
      // Sound tracks: four independent numeric selectors (1..30) per event, each routing to setSoundPack.
      { key: 'startSound',    kind: 'stepper', group: 'settings', labelKey: 'ctlStartSound',    min: 1, max: 30, step: 1 },
      { key: 'shutdownSound', kind: 'stepper', group: 'settings', labelKey: 'ctlShutdownSound', min: 1, max: 30, step: 1 },
      { key: 'hornSound',     kind: 'stepper', group: 'settings', labelKey: 'ctlHornSound',     min: 1, max: 30, step: 1 },
      { key: 'alarmSound',    kind: 'stepper', group: 'settings', labelKey: 'ctlAlarmSound',    min: 1, max: 30, step: 1 },
      // -- register / expert writes (group:'advanced', risky) - CMD_RW_PARAMETER 0x17 --
      { key: 'throttleAccel', kind: 'stepper', group: 'advanced', risky: true, labelKey: 'ctlThrottleAccel', min: 0, max: 10, step: 1 },
      { key: 'throttleBrake', kind: 'stepper', group: 'advanced', risky: true, labelKey: 'ctlThrottleBrake', min: 0, max: 10, step: 1 },
      { key: 'modDepth',      kind: 'stepper', group: 'advanced', risky: true, labelKey: 'ctlModDepth',      min: 1, max: 50, step: 1 },
      { key: 'polePairs',     kind: 'stepper', group: 'advanced', risky: true, labelKey: 'ctlPolePairs',     min: 1, max: 30, step: 1 },
      { key: 'dischargeCur',  kind: 'stepper', group: 'advanced', risky: true, labelKey: 'ctlDischargeCur',  min: 0.5, max: 20, step: 0.5, unit: 'A', decimals: 1 },
      { key: 'brakeCur',      kind: 'stepper', group: 'advanced', risky: true, labelKey: 'ctlBrakeCur',      min: 0.5, max: 30, step: 0.5, unit: 'A', decimals: 1 },
      { key: 'voltProt',      kind: 'stepper', group: 'advanced', risky: true, labelKey: 'ctlVoltProt',      min: 18, max: 44, step: 0.5, unit: 'V', decimals: 1 },
      { key: 'wheel',         kind: 'stepper', group: 'advanced', risky: true, labelKey: 'ctlWheel',         min: 0.5, max: 15, step: 0.5, unit: 'inch', decimals: 1 },
      {
        key: 'carrier', kind: 'segmented', group: 'advanced', risky: true, labelKey: 'ctlCarrier',
        options: [
          { value: 0, labelKey: 'ctlCarrier8k' }, { value: 1, labelKey: 'ctlCarrier10k' },
          { value: 2, labelKey: 'ctlCarrier12k' }, { value: 3, labelKey: 'ctlCarrier15k' },
          { value: 4, labelKey: 'ctlCarrierAuto' },
        ],
      },
      { key: 'cruiseTime',    kind: 'stepper', group: 'advanced', risky: true, labelKey: 'ctlCruiseTime',    min: 2, max: 30, step: 1, unit: 's' },
      { key: 'shutdownTime',  kind: 'stepper', group: 'advanced', risky: true, labelKey: 'ctlShutdownTime',  min: 2, max: 30, step: 1, unit: 'min' },
      { key: 'serviceKm',     kind: 'stepper', group: 'advanced', risky: true, labelKey: 'ctlServiceKm',     min: 50, max: 60000, step: 50, unit: 'km' },
    ];
  }

  // ---- connect lifecycle ---------------------------------------------------
  async discover() {
    const S = (u) => this.server.getPrimaryService(u);
    if (this._family === 'legacy') {
      const s = await S(this._u(0x7777));
      this._chars.legTx = await s.getCharacteristic(this._u(0x8877));
      this._chars.legRx = await s.getCharacteristic(this._u(0x8888));
      await this._chars.legRx.startNotifications();
      this._chars.legRx.addEventListener('characteristicvaluechanged', e => this._onLegacy(e.target.value));
      this.channels.legacy = { role: 'data', service: this._u(0x7777), write: this._u(0x8877), notify: this._u(0x8888), concurrent: true };
      return;
    }
    // ZYD: concurrent data (F1F0) + AT (F2F0) channels kept open for the whole session.
    const ds = await S(this._u(0xF1F0));
    this._chars.dataTx = await ds.getCharacteristic(this._u(0xF1F1));
    this._chars.dataRx = await ds.getCharacteristic(this._u(0xF1F2));
    await this._chars.dataRx.startNotifications();
    this._chars.dataRx.addEventListener('characteristicvaluechanged', e => this._onData(e.target.value));
    this.channels.data = { role: 'data', service: this._u(0xF1F0), write: this._u(0xF1F1), notify: this._u(0xF1F2), concurrent: true };
    try {
      const cs = await S(this._u(0xF2F0));
      this._chars.atTx = await cs.getCharacteristic(this._u(0xF2F1));
      this._chars.atRx = await cs.getCharacteristic(this._u(0xF2F2));
      await this._chars.atRx.startNotifications();
      this._chars.atRx.addEventListener('characteristicvaluechanged', e => this._onAt(e.target.value));
      this.channels.at = { role: 'at', service: this._u(0xF2F0), write: this._u(0xF2F1), notify: this._u(0xF2F2), concurrent: true };
    } catch (e) { this._log('AT service (F2F0) unavailable', 'log-warn'); }
  }

  // AT+PWD auth is NOT a pre-discovery handshake: old tb/vmax afterConnect release UF mode FIRST
  // (5x stopTran + 3x keep) and only THEN send AT+PWD, so it lives in postConnectConfig below.
  async _authPin() {
    if (this._family !== 'zyd' || !this.pin) return;   // no pin -> no-op (old tools: AT+PWD only when a pin is set)
    await this._at('AT+PWD[' + this.pin + ']');
    const r = await this._awaitAt(x => /^OK\+PWD:[YN]/.test(x) || /^ERR\+AT/.test(x), 1000);
    if (this._pwd.ok === false) this._log('AT+PWD rejected (OK+PWD:N) - controller will refuse writes', 'log-warn');
    if (r == null) await this._sleep(150);             // no reply seen; fall back to the fixed settle
  }
  // Old tb/vmax afterConnect order (app.js:414-435 / 407-428): 5x stopTran + 3x keep to leave UF mode,
  // THEN optional AT+PWD, THEN a single PLAIN ESC-info read (transmit 0x07,0,4) - no sendTran wrap, no
  // second stop/keep batch, and never a 0x03 param read.
  async postConnectConfig() {
    if (this._family === 'legacy') return;
    for (let i = 0; i < 5; i++) { await this._writeData(this._ctrl(0xFF)); await this._sleep(50); }
    for (let i = 0; i < 3; i++) { await this._writeData(this._keep()); await this._sleep(50); }
    await this._authPin();                                                       // AT+PWD after UF release (old order)
    try { await this.readFirmware(); } catch (e) {}                              // plain ESC-info read (firmware)
  }

  _diagSkipUuids() { return [this.channels.data, this.channels.at, this.channels.legacy].filter(c => c && c.notify).map(c => c.notify); }
  startTelemetry() {
    if (this._hb) return;
    if (this.diag) this._diagTapExtraNotify().catch(() => {});
    if (this._family === 'legacy') {
      this._writeLegacy(this._ff55(0x01, [])).catch(() => {});                    // immediate first confirm (old afterConnect)
      this._hb = setInterval(() => { this._writeLegacy(this._ff55(0x01, [])).catch(() => {}); }, 500); // FF 55 01 00 55
    } else {
      this._hb = setInterval(() => { this._writeData(this._keep()).catch(() => {}); }, 500); // tb/vmax startZydKeep 500ms
    }
  }
  // MANDATORY safe teardown: stop heartbeat, then 5x sendStopTran so the controller leaves UF/transparent mode.
  async stopTelemetry() {
    if (this._hb) { clearInterval(this._hb); this._hb = null; }
    this._diagUntap();
    if (this._family === 'legacy') return;
    try { for (let i = 0; i < 5; i++) { await this._writeData(this._ctrl(0xFF)); await this._sleep(50); } } catch (e) {}
  }
  async enterTransparentMode() { await this._writeData(this._ctrl(0x00)); return { ok: true }; }
  async leaveTransparentMode() { await this._writeData(this._ctrl(0xFF)); return { ok: true }; }

  // Register write with the tran-nudge interleave (never leave the scooter latched in UF mode).
  async _zydSendParam(frame) {
    const hadHb = !!this._hb;
    if (this._hb) { clearInterval(this._hb); this._hb = null; }
    try {
      await this._sleep(150);
      await this._writeData(this._ctrl(0x00)); // sendTran
      await this._sleep(30);
      await this._writeData(frame);
      await this._sleep(30);
      await this._writeData(this._ctrl(0xFF)); // sendStopTran
    } finally { if (hadHb) this.startTelemetry(); }
    return { ok: true, raw: Uint8Array.from(frame) };
  }
  async _writeMonitorFrame() {
    if (!this._baseReady) { this._log('base state not read yet (guard) - refusing monitor write', 'log-warn'); return { ok: false }; }
    await this._writeData(this._monitorFrame()); return { ok: true };
  }

  // ---- telemetry -----------------------------------------------------------
  _bytes(dv) { const a = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength); return Array.from(a); }
  _onData(dv) {
    const buf = this._bytes(dv);
    this._rawRx('DATA', buf, zydRedactData);
    if (buf[0] === 0xAB) { this._decodeMonitor(buf); return; }
    if (buf[0] === 0x01) this._stream(buf);          // 0x07 ESC-info / 0x08 serial / 0x03 adv-params reply
  }
  _onAt(dv) {
    const s = String.fromCharCode.apply(null, this._bytes(dv)).replace(/\0+$/, '');
    this._log('AT<- ' + s, 'log-rx');
    this._parseAt(s);
    for (let i = this._atWaiters.length - 1; i >= 0; i--) {
      if (this._atWaiters[i].test(s)) { const w = this._atWaiters.splice(i, 1)[0]; w.done(s); }
    }
  }
  // Parse AT replies: only AT+PWD acceptance (used by _authPin). tb/vmax old tools parse no other AT reply.
  _parseAt(s) {
    if (/^OK\+PWD:Y/.test(s) || /^ERR\+AT/.test(s)) this._pwd.ok = true;   // accepted
    else if (/^OK\+PWD:N/.test(s)) this._pwd.ok = false;                   // wrong password
  }
  // Resolve when a matching AT reply arrives, or null after ms (so a mute device never hangs connect).
  _awaitAt(test, ms) {
    return new Promise(resolve => {
      const w = { test, done: resolve }; this._atWaiters.push(w);
      setTimeout(() => { const i = this._atWaiters.indexOf(w); if (i >= 0) { this._atWaiters.splice(i, 1); resolve(null); } }, ms || 900);
    });
  }
  // Reassemble the streamed ESC-info (0x07) reply. Frame: 01 07 offHi offLo bcount <up to 8 data @buf[5..]>.
  // Offset field at buf[2..3] (tb/vmax rdU16BE(b,2)); copy the available data bytes into the byte offset,
  // 1:1 with old handleFrame (app.js:501-503: for i<8 while 5+i<len). Only 0x07 is read by tb/vmax.
  _stream(buf) {
    if (buf[1] !== 0x07 || buf.length < 6) return;
    const off = (buf[2] << 8) | buf[3];
    for (let i = 0; i < 8 && (5 + i) < buf.length; i++) this._esc[off + i] = buf[5 + i];
    this._decodeEscInfo(this._esc);
  }
  _ascii16(buf, start) {
    let s = ''; for (let i = start; i < start + 16 && i < buf.length; i++) { const c = buf[i] & 0xff; if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c); }
    return s.trim();
  }
  _decodeEscInfo(buf) {                                // model@0 hw@16 boot@32 fw@48 uniquecode@64 (16B ASCII each)
    if (buf.length < 64) return;
    const V = LB.value, P = LB.Confidence.PROVEN, t = this._tel; t.config = t.config || {};
    t.config.model = V(this._ascii16(buf, 0), null, P);
    t.config.hardware = V(this._ascii16(buf, 16), null, P);
    t.config.boot = V(this._ascii16(buf, 32), null, P);
    t.firmware = V(this._ascii16(buf, 48), null, P);   // FW tile
    if (buf.length >= 80) t.config.uniqueCode = V(this._ascii16(buf, 64), null, P);
    if (!this._escLogged && buf.length >= 80) {   // log the identity once; uniquecode masked by Anonymize log
      this._escLogged = true;
      const uniq = this._ascii16(buf, 64);
      this._log('ESC info: model=' + this._ascii16(buf, 0) + ' hardware=' + this._ascii16(buf, 16) + ' boot=' + this._ascii16(buf, 32) + ' firmware=' + this._ascii16(buf, 48) + (uniq ? ' uniquecode=\x01' + uniq + '\x01' : ''), 'log-ok');
    }
    this._onTelemetry(t);
  }
  // Live unlock state. vmax old tool derives it from the streamed per-mode limits:
  // max(m1,m2,m3) > eKFV+2 (app.js:545). tb has no live reg-0x20 readback (README: local flag only) -> null.
  _isUnlocked() {
    if (this.cfg.id === 'vmax') {
      if (!this._baseSeen) return null;
      return Math.max(this._m1, this._m2, this._m3) > (this._ekfv + 2);
    }
    return null;
  }
  isUnlocked() { return this._isUnlocked(); }
  _onLegacy(dv) {
    const buf = this._bytes(dv);                 // FF 55 op len payload... ; web tool decodes only op 0x0A/0x0E
    this._rawRx('LEG', buf);
    if (buf[0] !== 0xFF || buf[1] !== 0x55) return;
    const P = LB.Confidence.PROVEN, op = buf[2], v = (buf[4] << 8) | buf[5];
    if (op === 0x0A) { this._tel.speed = LB.value(v * 0.001, v, P, { unitLabel: 'km/h' }); }
    else if (op === 0x0E) { this._tel.voltage = LB.value(v * 0.001, v, P, { unitLabel: 'V' }); }
    this._onTelemetry(this._tel);
  }

  _faultList(w) {
    const m = { 1: 'E1', 2: 'E2', 3: 'E3', 4: 'E4', 7: 'E7', 9: 'E9', 10: 'F1', 11: 'F2' }, out = [];
    for (const b in m) if (w & (1 << b)) out.push(m[b]);
    return out;
  }
  _decodeMonitor(buf) {
    const V = LB.value, P = LB.Confidence.PROVEN, U = LB.Confidence.UNVERIFIED, LS = LB.LockState;
    const u16 = (o) => (buf[o] << 8) | buf[o + 1];
    const s16 = (o) => { const v = u16(o); return v > 32767 ? v - 65536 : v; };
    const s8 = (o) => buf[o] > 127 ? buf[o] - 256 : buf[o];
    const t = this._tel;
    if (buf[1] === 0x00 && buf.length >= 23) {            // Frame A - live monitor (verified)
      const r6 = u16(6), r8 = u16(8), sraw = Math.max(r6, r8);
      const scale = this._thousandUnits ? 10 : 1000;     // Frame B bit12 thousandUnits: /10 == /1000*100 (smali-verified)
      t.speed = V(sraw / scale, [r6, r8], P, { scaleMode: this._thousandUnits ? 'thousandUnits' : 'default', unitLabel: 'km/h' });
      t.batteryPct = V(buf[5], buf[5], P, { unitLabel: '%' });
      t.gearOrMode = V(buf[4] & 0x03, buf[4], P);
      t.voltage = V(u16(10) / 10, u16(10), P, { unitLabel: 'V' });
      t.current = V(s16(12) / 64, u16(12), P, { unitLabel: 'A' });
      t.escTemp = V(s8(14), buf[14], P, { unitLabel: 'C' });
      t.motorTemp = V(s8(15), buf[15], P, { unitLabel: 'C' });
      t.tripKm = V(u16(16) / 10, u16(16), P, { unitLabel: 'km' });
      t.totalKm = V(((buf[18] << 16) | (buf[19] << 8) | buf[20]) / 10, [buf[18], buf[19], buf[20]], P, { unitLabel: 'km' });
      t.power = V((u16(10) / 10) * (s16(12) / 64), null, P, { unitLabel: 'W' });
      const sw = u16(21); t.statusWord = V(sw, sw, P);
      t.headlightState = V(!!(sw & (1 << 2)), sw, P);
      t.zeroStartState = V(!!(sw & (1 << 5)), sw, P);
      t.unitState = V((sw & (1 << 6)) ? 'mph' : 'kmh', sw, P);
      t.cruiseState = V(!!(sw & (1 << 9)), sw, P);
      t.immobilizerState = V((sw & (1 << 11)) ? LS.LOCKED : LS.UNLOCKED, sw, P);
      t.ambientState = V(!!(sw & (1 << 15)), sw, P);
      if (this.cfg.id === 'tb') t.turnIndicatorState = V(['turnOff', 'turnRight', 'turnLeft', 'turnBoth'][(sw >> 13) & 0x03], sw, P); // bit13 R / bit14 L (tb only)
      t.faultBits = V(null, null, U, { note: 'faultCode byte range unsure (spec)' });
      // sync switch cache so a later single-switch write preserves the others
      this._bp = { gear: buf[4] & 0x03, head: !!(sw & (1 << 2)), ambient: !!(sw & (1 << 15)), cruise: !!(sw & (1 << 9)), boot: !!(sw & (1 << 5)), unit: !!(sw & (1 << 6)), lock: !!(sw & (1 << 11)) };
      this._swSeen = true;
    } else if (buf[1] === 0x01 && buf.length >= 16) {      // Frame B - base params / per-mode limits
      const st = P;                                        // both tb and vmax old tools decode+display Frame B -> proven
      this._limitCruise = buf[3]; this._m1 = buf[4]; this._m2 = buf[5]; this._m3 = buf[6];
      if (this.cfg.id === 'tb') this._thousandUnits = ((u16(10) >> 12) & 1) === 1; // vmax old tool has no thousandUnits
      t.speedLimits = t.speedLimits || {};
      t.speedLimits.perMode = V([buf[4], buf[5], buf[6]], [buf[4], buf[5], buf[6]], st, { unitLabel: 'km/h' });
      t.cruiseLimit = V(buf[3], buf[3], st, { unitLabel: 'km/h' });
      t.config = t.config || {};
      if (buf.length >= 23) t.config.displayVersion = V('V' + buf[20] + '.' + buf[21] + '.' + buf[22], [buf[20], buf[21], buf[22]], st);
      if (this.cfg.id === 'tb' || this.cfg.id === 'vmax') { // Frame B extras: both old tools decode battTemp/fault/cap -> proven
        t.batteryTemp = V(s8(7), buf[7], st, { unitLabel: 'C' });
        const fw = u16(8); t.faultBits = V(fw, fw, st); t.errorCodes = V(this._faultList(fw), fw, st);
        t.errorCode = V(fw, fw, st);   // canonical alias (contract §2 'err' tile) for the decoded fault word
        t.bms = t.bms || {}; t.bms.capacityRemaining = V(u16(14), u16(14), st); t.bms.capacityTotal = V(u16(12), u16(12), st);
        t.capacity = V(u16(14) + '/' + u16(12), [u16(14), u16(12)], st);   // remaining/total tile (old t-cap)
      }
      this._baseSeen = true;
    }
    this._baseReady = !!(this._swSeen && this._baseSeen);
    this._tel = t; this._onTelemetry(t);
  }
  async readTelemetry() { return this._tel || {}; }

  // ESC-info read: a PLAIN transmit of 0x07,0,4, exactly like old tb/vmax afterConnect (app.js:429/422).
  // No sendTran wrap - the reply streams as head-0x01 fragments, reassembled in _stream.
  async readFirmware() {
    if (this._family === 'legacy') return this._todo('readFirmware(legacy)');
    this._esc = []; this._escLogged = false; await this._writeData(this._read(0x07, 0, 4)); return { ok: true };
  }

  // ---- speed limiter -------------------------------------------------------
  // Old tb/vmax cmdSetMaxSpeed writes ONLY register 0x20 (zydSpeedFrame -> zydSendParam); it never
  // touches the monitor frame or the per-mode limits. No m3 side-effect (that was EPF-only, now dropped).
  async setSpeedOpen(kmh) { return this._applyDrossel(kmh); }
  async setSpeedLegal(kmh) { const v = kmh == null ? 22 : kmh; this._ekfv = v; return this._applyDrossel(v); } // eKFV default 22
  async _applyDrossel(kmh) {
    if (this._family === 'legacy') return this._todo('setSpeed: legacy Scooter has no BLE speed command');
    const v = Math.round(kmh * 10);                    // register 0x20 = km/h*10, uint16 BE (proven)
    return this._zydSendParam(this._rwParam(0x20, this._u16(v)));
  }

  // ---- lock family ---------------------------------------------------------
  async setLock(kind, on, opts) {
    const K = LB.LockKind;
    if (kind === K.CodeLock) return this._todo('codeLock: legacy code-protected lock is app-only, not in web tool // TODO(unproven)');
    if (kind && kind !== K.Immobilizer) return this._todo('setLock:' + kind);
    if (this._family === 'legacy') { await this._writeLegacy(this._ff55(0x17, [on ? 0x02 : 0x01])); return { ok: true }; } // 17 01 01 unlock / 02 lock
    if (!this._baseReady) return { ok: false };
    this._bp.lock = !!on; return this._writeMonitorFrame();  // ZYD immobilizer = monitor bit7
  }
  async setImmobilizer(on) { return this.setLock(LB.LockKind.Immobilizer, on); }
  async queryLockState(kind) {
    if (kind && kind !== LB.LockKind.Immobilizer) return LB.LockState.UNKNOWN;
    const s = this._tel && this._tel.immobilizerState; return (s && s.value) || LB.LockState.UNKNOWN;
  }

  // ---- switch / ride settings (monitor frame) ------------------------------
  async _setSwitch(field, on) {
    if (this._family === 'legacy') return this._todo('switch(legacy): ' + field);
    if (!this._baseReady) return { ok: false };
    this._bp[field] = !!on; return this._writeMonitorFrame();
  }
  setHeadlight(on) { return this._setSwitch('head', on); }
  setAmbientLight(on) { return this._setSwitch('ambient', on); }
  // Old tb/vmax only ever emit cruise-OFF (status bit4=0); a cruise-ON monitor frame is not proven -> gated.
  setCruise(on) { return on ? this._todo('setCruise(on): only cruise-off is proven in the old tools // TODO(unproven)') : this._setSwitch('cruise', false); }
  // zero-start: tb/vmax invert the boot/kickstart bit (SETTINGS zeroStart invert:true).
  setZeroStart(on) { return this._setSwitch('boot', !on); }
  setUnit(u) { return this._setSwitch('unit', u === 'mph' || u === true); }
  async setGear(g) {
    if (this._family === 'legacy') { await this._writeLegacy(this._ff55(0x1F, [(g | 0) >= 1 ? 0x03 : 0x02])); return { ok: true }; } // gear low(0)->D1 0x02, high(>=1)->D2 0x03
    if (!this._baseReady) return { ok: false };
    this._bp.gear = (g | 0) & 0x03; return this._writeMonitorFrame();
  }

  // ---- register (advanced) settings - proven for tb/vmax (old cmdRegister/encodeReg) ----
  _encodeReg(mode, v, factor) {
    let raw;
    if (mode === 'opv') raw = Math.round(v * factor);
    else if (mode === 'realmax') raw = Math.round(v) * factor;
    else raw = Math.round(v);                    // int / index
    raw &= 0xffff; return [(raw >> 8) & 0xff, raw & 0xff];
  }
  async _writeReg(addr, mode, v, factor) {
    return this._zydSendParam(this._rwParam(addr, this._encodeReg(mode, v, factor)));
  }

  // ---- setting router ------------------------------------------------------
  _2d(n) { n = Math.max(0, Math.min(99, n | 0)); return (n < 10 ? '0' : '') + n; }
  async setSetting(key, value) {
    switch (key) {
      // monitor switches
      case 'headlight': return this.setHeadlight(!!value);
      case 'ambient': return this.setAmbientLight(!!value);
      case 'cruise': return this.setCruise(!!value);
      case 'zeroStart': return this.setZeroStart(!!value);
      case 'unit': return this.setUnit(value);
      case 'gear': return this.setGear(value | 0);
      case 'immobilizer': return this.setLock(LB.LockKind.Immobilizer, !!value);
      case 'limitCruise': if (!this._baseReady) return { ok: false }; this._limitCruise = value & 0xff; return this._writeMonitorFrame();
      // per-mode limits m1/m2/m3: old tb/vmax only READ and resend them unchanged, never write user values -> gated.
      case 'ecoLimit': case 'comfortLimit': case 'sportLimit':
        return this._todo('setSetting:' + key + ': per-mode limit write not proven in the old tools // TODO(unproven)');
      // AT settings wired in both old tools: device name + sound pack. (No password/nfc/driveType/
      // passwordProtection setter - those were EPF-only, now dropped.)
      case 'name': return this.setDeviceName(value);
      case 'startSound': case 'shutdownSound': case 'hornSound': case 'alarmSound':
        return this.setSoundPack({ startSound: 'start', shutdownSound: 'shutdown', hornSound: 'horn', alarmSound: 'alarm' }[key], value | 0);
      // register (risky) settings - tb/vmax proven (old SETTINGS reg addrs)
      case 'modDepth': return this._writeReg(0x02, 'realmax', value, 436);
      case 'polePairs': return this._writeReg(0x04, 'int', value);
      case 'throttleAccel': return this._writeReg(0x09, 'realmax', value, 3000);
      case 'throttleBrake': return this._writeReg(0x0A, 'realmax', value, 3000);
      case 'dischargeCur': return this._writeReg(0x0B, 'opv', value, 64);
      case 'brakeCur': return this._writeReg(0x0C, 'opv', value, 64);
      case 'voltProt': return this._writeReg(0x13, 'opv', value, 10);
      case 'wheel': return this._writeReg(0x17, 'opv', value, 25.4);
      case 'carrier': return this._writeReg(0x21, 'index', value);
      case 'cruiseTime': return this._writeReg(0x33, 'int', value);
      case 'shutdownTime': return this._writeReg(0x34, 'int', value);
      case 'serviceKm': return this._writeReg(this.cfg.id === 'vmax' ? 0x49 : 0x4A, 'int', value); // vmax reg 0x49, tb 0x4A
      default: return this._todo('setSetting:' + key);
    }
  }

  // ---- identity / sound / resets -------------------------------------------
  setDeviceName(s) { return this._at('AT+NAME[' + String(s).slice(0, 16) + ']'); } // <=16 chars (old cmdSetName)
  async setSoundPack(kind, track) {
    // tb + vmax both wire cmdSound (AT+MP3/31/32/34, 2-digit track).
    const c = { start: 'AT+MP3', shutdown: 'AT+MP31', horn: 'AT+MP32', alarm: 'AT+MP34' }[kind];
    return c ? this._at(c + '[' + this._2d(track) + ']') : this._todo('soundPack kind:' + kind);
  }
  async resetTrip() { return this._todo('resetTrip: intentional no-op (not proven as its own frame)'); }
  async resetTotal() { return this._todo('resetTotal // TODO(unproven)'); }
  async factoryReset() { return this._todo('factoryReset // TODO(unproven)'); }

  // ---- generic escape hatches ----------------------------------------------
  async sendAtCommand(cmd) { return this._at(cmd); }
  async sendRawFrame(bytes, channel) {
    const ch = channel === 'at' ? this._chars.atTx : channel === 'legacy' ? this._chars.legTx : this._chars.dataTx;
    if (!ch) return this._todo('sendRawFrame: no channel "' + channel + '"');
    await this._writeChar(ch, bytes); return { ok: true, raw: Uint8Array.from(bytes) };
  }
};
