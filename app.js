// Laufbursche Trittbrett Tool: a model-dynamic Web Bluetooth client for the Trittbrett BLE protocols.
// Copyright (c) 2026 Laufbursche (https://github.com/Laufbursche42)
// The page picks the protocol from the advertised BLE name, exactly like the app com.planm.trittbrett:
//   - ZYD family (newer models FRITZ / PAUL / SULTAN / HILDE / KALLE v2 / EMMA v2, name "zyd.." / "hw_..").
//     Binary frames, CRC-16/MODBUS. Speed via the global limit register 0x20 (km/h * 10).
//   - Legacy family (older KALLE v1 / EMMA v1, name "Scooter"). FF 55 frames, additive checksum.
//     Only a gear switch, no BLE speed command.
//
// Everything about the protocols is from static analysis of the Trittbrett app (com.planm.trittbrett
// 2.1.0), not verified on a vehicle. Runs in a Web Bluetooth browser: Bluefy on iOS, Chrome on
// Android/desktop. Safari has no Web Bluetooth.

'use strict';

const BUILD = 'v3';   // logged on load so a tester's log reveals which deployed build is running

// --------------------------- helpers ---------------------------

function hexToBytes(h) { h = (h || '').replace(/[^0-9a-fA-F]/g, ''); const a = []; for (let i = 0; i + 1 < h.length; i += 2) a.push(parseInt(h.substr(i, 2), 16)); return a; }
function bytesToHex(b) { return [...b].map(x => x.toString(16).padStart(2, '0').toUpperCase()).join(' '); }

// --------------------------- CRC-16/MODBUS (poly 0x8005, init 0xFFFF, refin/refout, xorout 0) ---------------------------
// Belegt: com.zydtech.library.help.CRC16.MODBUS. Appended low byte first.
function crc16Modbus(bytes, len) {
  let crc = 0xFFFF;
  const n = (len === undefined) ? bytes.length : len;
  for (let i = 0; i < n; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) crc = (crc & 1) ? ((crc >>> 1) ^ 0xA001) : (crc >>> 1);
  }
  return crc & 0xFFFF;
}

// --------------------------- ZYD frame builders (belegt aus BleCore.java) ---------------------------
function zydAppendCrc(head) { const c = crc16Modbus(head, head.length); return new Uint8Array([...head, c & 0xFF, (c >>> 8) & 0xFF]); }
// 8-byte read/request: 01 cmd addrHi addrLo cntHi cntLo crcLo crcHi
function zydReadFrame(cmd, addr, cnt) { return zydAppendCrc([0x01, cmd & 0xFF, (addr >>> 8) & 0xFF, addr & 0xFF, (cnt >>> 8) & 0xFF, cnt & 0xFF]); }
// 10-byte monitor/base-params: AB 00 0A value limitCruise m1 m2 m3 crc
function zydMonitorFrame(valueByte, limitCruise, m1, m2, m3) { return zydAppendCrc([0xAB, 0x00, 0x0A, valueByte & 0xFF, limitCruise & 0xFF, m1 & 0xFF, m2 & 0xFF, m3 & 0xFF]); }
// register write (adv-parameter): 01 17 addrBE wcntBE addrBE wcntBE bcount value.. crc
function zydRwParamFrame(addr, valueBytes) {
  const words = Math.floor(valueBytes.length / 2);
  const head = [0x01, 0x17, (addr >>> 8) & 0xFF, addr & 0xFF, (words >>> 8) & 0xFF, words & 0xFF,
    (addr >>> 8) & 0xFF, addr & 0xFF, (words >>> 8) & 0xFF, words & 0xFF, valueBytes.length & 0xFF, ...valueBytes];
  return zydAppendCrc(head);
}
// global speed limit: register 0x20, value km/h*10 as uint16 BE (opv 10, app max 60)
function zydSpeedFrame(kmh) { const v = Math.round(kmh * 10) & 0xFFFF; return zydRwParamFrame(0x20, [(v >>> 8) & 0xFF, v & 0xFF]); }
// control frame (no CRC): A5 cmd ~cmd 00 00 00 00 5A
function zydTranFrame(cmd) { return new Uint8Array([0xA5, cmd & 0xFF, (~cmd) & 0xFF, 0, 0, 0, 0, 0x5A]); }
// status byte: bit0-1 gear, bit2 headlight, bit3 ambient, bit4 cruise, bit5 boot, bit6 imperial, bit7 lock
function zydStatusByte(o) { o = o || {}; return ((o.gear || 0) & 3) | ((o.headlight ? 1 : 0) << 2) | ((o.ambient ? 1 : 0) << 3) | ((o.cruise ? 1 : 0) << 4) | ((o.boot ? 1 : 0) << 5) | ((o.imperial ? 1 : 0) << 6) | ((o.lock ? 1 : 0) << 7); }

// --------------------------- Legacy FF55 builders (belegt aus ScooterViewModel) ---------------------------
function ff55Checksum(bytes) { let s = 0; for (const b of bytes) s = (s + b) & 0xFF; return s; }
function ff55Frame(opcode, payload) {
  payload = payload || [];
  const head = [0xFF, 0x55, opcode & 0xFF, payload.length & 0xFF, ...payload.map(x => x & 0xFF)];
  return new Uint8Array([...head, ff55Checksum(head)]);
}

// --------------------------- self-test against belegte vectors ---------------------------
let PROTO_OK = false;
(function protoSelfTest() {
  const eq = (a, h) => bytesToHex(a) === h;
  const ok = [
    eq(ff55Frame(0x1F, [0x02]), 'FF 55 1F 01 02 76'),   // gear D1
    eq(ff55Frame(0x1F, [0x03]), 'FF 55 1F 01 03 77'),   // gear D2
    eq(ff55Frame(0x17, [0x01]), 'FF 55 17 01 01 6D'),   // unlock
    eq(ff55Frame(0x01, []), 'FF 55 01 00 55'),          // confirm
    eq(zydTranFrame(0x00), 'A5 00 FF 00 00 00 00 5A'),  // tran
    (function () { const f = zydSpeedFrame(20); return f[0] === 0x01 && f[1] === 0x17 && f[2] === 0x00 && f[3] === 0x20 && f[f.length - 4] === 0x00 && f[f.length - 3] === 0xC8; })(),
    crc16Modbus([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]) === 0x4B37,   // MODBUS "123456789"
  ];
  PROTO_OK = ok.every(Boolean);
})();

// --------------------------- BLE transport constants ---------------------------
const U = s => '0000' + s + '-0000-1000-8000-00805f9b34fb';
const TRANSPORTS = {
  zyd:    { name: 'ZYD data', service: U('f1f0'), write: U('f1f1'), notify: U('f1f2'), atService: U('f2f0'), atWrite: U('f2f1'), atNotify: U('f2f2') },
  legacy: { name: 'Legacy',   service: U('7777'), write: U('8877'), notify: U('8888') },
};
const ALL_SERVICES = [TRANSPORTS.zyd.service, TRANSPORTS.zyd.atService, TRANSPORTS.legacy.service];

// --------------------------- model register ---------------------------
// family: 'ZYD' | 'LEGACY'. The advertised BLE name decides the path at runtime, exactly like the app
// (ScanFragment): "zyd.." / "hw_.." -> ZYD, "Scooter" -> Legacy. KALLE and EMMA exist in both
// generations, so their real family is only known from the name; auto detect handles that.
const PROTOCOLS = {
  fritz:  { name: 'FRITZ',  family: 'ZYD',    prefixes: ['zyd', 'hw_'], transport: 'zyd',    speed: true },
  paul:   { name: 'PAUL',   family: 'ZYD',    prefixes: ['zyd', 'hw_'], transport: 'zyd',    speed: true },
  sultan: { name: 'SULTAN', family: 'ZYD',    prefixes: ['zyd', 'hw_'], transport: 'zyd',    speed: true },
  hilde:  { name: 'HILDE',  family: 'ZYD',    prefixes: ['zyd', 'hw_'], transport: 'zyd',    speed: true },
  kalle:  { name: 'KALLE',  family: 'ZYD',    prefixes: ['zyd', 'hw_', 'Scooter'], transport: 'zyd', speed: true },
  emma:   { name: 'EMMA',   family: 'ZYD',    prefixes: ['zyd', 'hw_', 'Scooter'], transport: 'zyd', speed: true },
  legacy: { name: 'KALLE v1 / EMMA v1 (Scooter)', family: 'LEGACY', prefixes: ['Scooter'], transport: 'legacy', speed: false },
};
const MODEL_ORDER = ['auto', 'fritz', 'paul', 'sultan', 'hilde', 'kalle', 'emma', 'legacy'];
function modelDef(key) {
  if (key === 'auto') return { key: 'auto', label: '', proto: null };
  const p = PROTOCOLS[key];
  return p ? { key, label: p.name, proto: key, prefixes: p.prefixes } : null;
}
function protoFor(key) {
  const d = modelDef(key);
  if (!d || !d.proto) return null;
  const base = PROTOCOLS[d.proto];
  return Object.assign({}, base, { id: key, baseId: d.proto });
}
// Classify an advertised device name to a family, 1:1 with ScanFragment (belegt).
function classifyByName(name) {
  if (!name) return null;
  const n = String(name).trim().toLowerCase();
  if (n === 'scooter') return 'legacy';
  // Real Trittbrett ZYD units advertise varied names, e.g. "ePFHilde", not just "zyd"/"hw_".
  if (n.startsWith('zyd') || n.startsWith('hw_') || n.startsWith('epf')) return 'zyd';
  if (/(hilde|fritz|paul|sultan|kalle|emma)/.test(n)) return 'zyd';
  return null;
}
const AUTO_PROTO = { id: 'auto', baseId: null, name: 'auto', family: null, prefixes: [], transport: 'zyd', speed: false };
const DEFAULT_MODEL = 'auto';

const LS_THEME = 'tbu_theme', LS_DEVICE = 'tbu_device', LS_MODEL = 'tbu_model', LS_SPEED = 'tbu_speed', LS_EKFV = 'tbu_ekfv', LS_PIN = 'tbu_pin';
let speedUnlocked = false;   // local speed lock/unlock state; the scooter reports the cap only in frame B

// --------------------------- state ---------------------------
let activeProto = AUTO_PROTO;
let autoDetect = false;
let usedTransport = TRANSPORTS[activeProto.transport];
let device = null, server = null, writeChar = null, notifyChar = null, atWriteChar = null;
let connected = false, connecting = false;
let modelChosen = false;
let keepTimer = null;   // ZYD 500 ms sendTran / Legacy 500 ms confirm keep-alive
// Tracked base-params state (ZYD). One monitor frame carries them all, so a single change must
// resend the others unchanged. Filled from the incoming 0xAB frames (A: switches+gear, B: limits).
let bp = { gear: 0, headlight: 0, ambient: 0, cruise: 0, boot: 0, imperial: 0, lock: 0, limitCruise: 3, m1: 6, m2: 10, m3: 20 };

// --------------------------- UI helpers ---------------------------
function $(id) { return document.getElementById(id); }

const logLines = [];
function ts() { const d = new Date(); const p = (n, w) => String(n).padStart(w || 2, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3); }
function log(m, cls) {
  const line = '[' + ts() + '] ' + m;
  logLines.push(line);
  const el = $('log'); if (!el) return;
  const span = document.createElement('div');
  if (cls) span.className = cls;
  span.textContent = line;
  el.insertBefore(span, el.firstChild);
}
function logDiagnosticHeader() {
  const nav = (typeof navigator !== 'undefined') ? navigator : {};
  log('=== tb-unlock diagnostic ===');
  log('build: ' + BUILD);
  log('time: ' + new Date().toISOString());
  log('userAgent: ' + (nav.userAgent || '(unknown)'));
  log('platform: ' + (nav.platform || '(unknown)'));
  log('webBluetooth: ' + (nav.bluetooth ? 'yes' : 'no'));
  log('============================');
}
async function copyLog() {
  const text = logLines.join('\n');
  let ok = false;
  try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); ok = true; } } catch (e) { ok = false; }
  if (!ok) ok = copyLogFallback(text);
  log(ok ? 'log copied (' + logLines.length + ' lines)' : 'log copy failed, please select the log text manually', ok ? 'log-ok' : 'log-err');
}
function copyLogFallback(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.className = 'copy-offscreen';
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand && document.execCommand('copy');
    document.body.removeChild(ta); return !!ok;
  } catch (e) { return false; }
}
const HELP = { speed: ['s3Title', 'settingsHint'], gear: ['gearTitle', 'gearHint'], more: ['moreTitle', 'moreHint'], disclaimer: ['footDisclaimer', 'disclaimerText'] };
function openHelp(key) {
  const m = HELP[key]; if (!m) return;
  const dlg = $('help'); if (!dlg) return;
  const ti = $('help-title'); if (ti) ti.textContent = t(m[0]);
  const bo = $('help-body'); if (bo) bo.textContent = t(m[1]);
  setHelpWarn('');
  if (dlg.showModal) { try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); } } else dlg.setAttribute('open', '');
}
function closeHelp() { const dlg = $('help'); if (!dlg) return; if (dlg.close) dlg.close(); else dlg.removeAttribute('open'); }
function clearLog() { logLines.length = 0; const el = $('log'); if (el) el.textContent = ''; logDiagnosticHeader(); log('log cleared'); }
function setTile(id, val) { const el = $(id); if (el) el.textContent = (val == null ? '-' : val); }
function resetTiles() { ['t-speed', 't-batt', 't-volt', 't-cur', 't-temp', 't-lock'].forEach(id => setTile(id, null)); }
function statusLabel(s) {
  const map = { disconnected: 'stDisconnected', connecting: 'stConnecting', linking: 'stLinking', connected: 'stConnected', 'no-service': 'stNoService', 'no-char': 'stNoChar' };
  return t(map[s] || 'stDisconnected') || s;
}
function setStatus(s) {
  const el = $('status'); if (el) { el.dataset.state = s; el.textContent = statusLabel(s); }
  const cb = $('btn-conn');
  if (cb) { const on = (s === 'connecting' || s === 'linking' || s === 'connected'); cb.textContent = on ? t('btnDisconnect') : t('btnConnect'); cb.dataset.act = on ? 'disconnect' : 'connect'; }
}
function setControlsEnabled(on) {
  const speedOn = on && activeProto.speed;
  const legacyOn = on && activeProto.family === 'LEGACY';
  const list = [['btn-toggle', speedOn], ['speed-in', speedOn], ['ekfv-in', speedOn], ['btn-gear1', legacyOn], ['btn-gear2', legacyOn]];
  list.forEach(([id, en]) => { const el = $(id); if (el) el.disabled = !en; });
  setSettingsEnabled(on && activeProto.family === 'ZYD');
  updateToggleButton();
}
function openSpeedValue() { const v = parseInt(($('speed-in') || {}).value, 10); return isNaN(v) ? 30 : v; }
function ekfvSpeedValue() { const v = parseInt(($('ekfv-in') || {}).value, 10); return isNaN(v) ? 22 : v; }
function updateToggleButton() { const b = $('btn-toggle'); if (!b) return; b.textContent = speedUnlocked ? t('btnLock') : t('btnUnlock'); }
function doSpeedToggle() {
  if (!activeProto.speed) { log('this model has no BLE speed command (legacy path).', 'log-err'); return; }
  if (speedUnlocked) { cmdSetMaxSpeed(ekfvSpeedValue(), false); speedUnlocked = false; }
  else { cmdSetMaxSpeed(openSpeedValue(), true); speedUnlocked = true; }
  updateToggleButton();
}

// --------------------------- model selection ---------------------------
function buildModelDropdown() {
  const sel = $('model-in'); if (!sel) return;
  sel.textContent = '';
  const ph = document.createElement('option');
  ph.value = ''; ph.setAttribute('data-t', 'modelChoose'); ph.textContent = t('modelChoose');
  sel.appendChild(ph);
  MODEL_ORDER.forEach(key => {
    const opt = document.createElement('option');
    opt.value = key;
    if (key === 'auto') { opt.setAttribute('data-t', 'modelAuto'); opt.textContent = t('modelAuto'); }
    else { const d = modelDef(key); if (!d) return; opt.textContent = d.label; }
    sel.appendChild(opt);
  });
}
function applyModelUi() {
  const on = modelChosen;
  const auto = autoDetect && !connected;
  // In auto-detect preview (no scooter yet) show the speed card so it is discoverable; its controls
  // stay disabled until a connection. Once connected/chosen it follows whether the model has BLE speed.
  const speedCard = $('speed-card'); if (speedCard) speedCard.hidden = !on || (!auto && !activeProto.speed);
  const gearCard = $('gear-card'); if (gearCard) gearCard.hidden = !on || auto || activeProto.family !== 'LEGACY';
  const noSpeed = $('nospeed-card'); if (noSpeed) noSpeed.hidden = !on || auto || activeProto.speed;
  renderSettings();
  const moreCard = $('more-card'); if (moreCard) moreCard.hidden = !on || (!auto && activeProto.family === 'LEGACY');
  const sel = $('model-in'); if (sel && on && !autoDetect && sel.value !== activeProto.id) sel.value = activeProto.id;
  const cb = $('btn-conn'); if (cb && !connected) cb.disabled = !on;
  setControlsEnabled(connected);
}
function setModel(id, quiet) {
  if (id === 'auto') {
    if (connected) { log('model changed while connected -> disconnecting'); disconnectBle(); }
    autoDetect = true; modelChosen = true; activeProto = AUTO_PROTO; usedTransport = TRANSPORTS.zyd;
    resetTiles();
    try { localStorage.setItem(LS_MODEL, 'auto'); } catch (e) {}
    const sel = $('model-in'); if (sel) sel.value = 'auto';
    applyModelUi();
    if (!quiet) log('auto detect: the page scans all Trittbrett scooters and picks the protocol from the advertised name (zyd../hw_.. -> ZYD, "Scooter" -> Legacy), exactly like the app.', 'log-ok');
    return;
  }
  const p = protoFor(id);
  if (!p) {
    autoDetect = false; modelChosen = false;
    if (connected) { log('model cleared while connected -> disconnecting'); disconnectBle(); }
    const sel = $('model-in'); if (sel) sel.value = '';
    applyModelUi();
    if (!quiet) log('no model selected. Pick your model or use auto detect.');
    return;
  }
  if (connected) { log('model changed while connected -> disconnecting to switch protocol'); disconnectBle(); }
  autoDetect = false; modelChosen = true; activeProto = p; usedTransport = TRANSPORTS[p.transport];
  resetTiles();
  try { localStorage.setItem(LS_MODEL, id); } catch (e) {}
  applyModelUi();
  if (!quiet) log('model set: ' + p.name + '  [family ' + p.family + ', transport ' + TRANSPORTS[p.transport].name + ', speed ' + (p.speed ? 'yes' : 'no') + ']', 'log-ok');
}
function applyDetectedProto(family, note) {
  // family is 'zyd' or 'legacy'. Keep the chosen model name if it matches, else use a generic.
  const proto = (family === 'legacy') ? PROTOCOLS.legacy : (PROTOCOLS[activeProto.id] && activeProto.family === 'ZYD' ? PROTOCOLS[activeProto.id] : PROTOCOLS.fritz);
  activeProto = Object.assign({}, proto, { id: activeProto.id || (family === 'legacy' ? 'legacy' : 'fritz'), baseId: family === 'legacy' ? 'legacy' : (activeProto.baseId || 'fritz') });
  activeProto.family = (family === 'legacy') ? 'LEGACY' : 'ZYD';
  activeProto.transport = (family === 'legacy') ? 'legacy' : 'zyd';
  activeProto.speed = (family !== 'legacy');
  usedTransport = TRANSPORTS[activeProto.transport];
  if (note) log(note, 'log-ok');
}

// --------------------------- connect / disconnect ---------------------------
async function pickAndConnect() {
  if (!navigator.bluetooth) { log('Web Bluetooth not available. Use Bluefy (iOS) or Chrome/Edge.', 'log-err'); return; }
  try {
    // Real Trittbrett units advertise unpredictable names (e.g. "ePFHilde", not "zyd"/"hw_"), and
    // Web Bluetooth name filters are case-sensitive, so a name filter is unreliable. Auto detect
    // therefore shows ALL devices (like the diagnostics) and classifies afterwards from the name and
    // the GATT service. A manual model pick keeps a filtered chooser for a tidier list.
    let options;
    if (autoDetect) {
      log('auto detect: showing all Bluetooth devices - pick your scooter (e.g. "ePFHilde" or "Scooter"). Close the official Trittbrett app first, otherwise it holds the connection and the scooter stays invisible.');
      options = { acceptAllDevices: true, optionalServices: ALL_SERVICES };
    } else {
      log('scanning for ' + activeProto.name + ' ...');
      const zydPfx = ['zyd', 'ZYD', 'Zyd', 'hw_', 'HW_', 'Hw_', 'ePF', 'EPF', 'epf', 'ePf'].map(p => ({ namePrefix: p }));
      const svcFilters = [{ services: [TRANSPORTS.zyd.service] }, { services: [TRANSPORTS.legacy.service] }];
      const pfx = (activeProto.family === 'LEGACY') ? [{ name: 'Scooter' }] : zydPfx;
      options = { filters: pfx.concat(svcFilters), optionalServices: ALL_SERVICES };
    }
    device = await navigator.bluetooth.requestDevice(options);
    log('selected: ' + (device.name || '(no name)') + ' [' + device.id + ']');
    const fam = classifyByName(device.name);
    if (autoDetect) {
      if (fam) applyDetectedProto(fam, 'detected ' + (fam === 'legacy' ? 'Legacy (Scooter)' : 'ZYD') + ' from name "' + device.name + '"');
      else log('name "' + (device.name || '(no name)') + '" is not a known Trittbrett name. Connecting and classifying from the GATT service instead.', 'log-ok');
    } else if (fam) {
      const want = activeProto.family === 'LEGACY' ? 'legacy' : 'zyd';
      if (fam !== want) applyDetectedProto(fam, 'note: this device advertises as ' + (fam === 'legacy' ? 'Legacy' : 'ZYD') + ', using that protocol instead of the picked one (the name is authoritative, like the app).');
    }
    await connectGatt(device);
  } catch (e) { log('scan/connect cancelled: ' + e, 'log-err'); }
}

function charProps(c) { const p = c.properties || {}; return ['read', 'write', 'writeWithoutResponse', 'notify', 'indicate'].filter(k => p[k]).join(',') || '-'; }
async function scanAllDevicesDiagnostic() {
  if (!navigator.bluetooth) { log('Web Bluetooth not available. Use Bluefy (iOS) or Chrome (Android/desktop).', 'log-err'); return; }
  let dev = null;
  try {
    log('DIAG: showing ALL Bluetooth devices. Pick your scooter, even if the name looks wrong or missing.', 'log-ok');
    dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: ALL_SERVICES });
  } catch (e) { log('DIAG cancelled: ' + e, 'log-err'); return; }
  log('DIAG selected: name="' + (dev.name || '(no name)') + '"  id=' + dev.id);
  const cls = classifyByName(dev.name);
  log('DIAG classify: ' + (cls ? (cls === 'legacy' ? 'Legacy (Scooter)' : 'ZYD') : 'NOT recognized - the advertised name matches no known Trittbrett name'), cls ? 'log-ok' : 'log-err');
  try {
    log('DIAG: connecting to read the GATT services ...');
    const srv = await dev.gatt.connect();
    let svcs = [];
    try { svcs = await srv.getPrimaryServices(); } catch (e) { log('DIAG getPrimaryServices error: ' + e, 'log-err'); }
    if (!svcs || !svcs.length) log('DIAG: none of the known services is present (ZYD F1F0, AT F2F0, Legacy 7777).', 'log-err');
    else for (const s of svcs) {
      log('DIAG service ' + s.uuid, 'log-ok');
      try { const chs = await s.getCharacteristics(); for (const c of chs) log('DIAG   char ' + c.uuid + '  [' + charProps(c) + ']'); }
      catch (e) { log('DIAG   (characteristics unreadable: ' + e + ')'); }
    }
    try { dev.gatt.disconnect(); } catch (e) {}
    log('DIAG done. Copy the log and send it. For the full picture use nRF Connect on Android.', 'log-ok');
  } catch (e) { log('DIAG connect failed: ' + e, 'log-err'); }
}

async function resolveService(srv) {
  // Try the family transport first, then the other, so a mislabeled pick still connects.
  const order = activeProto.family === 'LEGACY' ? ['legacy', 'zyd'] : ['zyd', 'legacy'];
  for (const key of order) {
    const cand = TRANSPORTS[key];
    const svc = await srv.getPrimaryService(cand.service).catch(() => null);
    if (svc) {
      if (key !== (activeProto.family === 'LEGACY' ? 'legacy' : 'zyd')) {
        applyDetectedProto(key, 'note: expected service not found, using ' + cand.name + ' (' + (key === 'legacy' ? 'Legacy' : 'ZYD') + ') instead.');
      }
      usedTransport = cand; return svc;
    }
  }
  return null;
}
async function connectGatt(dev) {
  if (connecting) { log('connect already in progress'); return; }
  connecting = true;
  try {
    if (device && device !== dev) { try { device.removeEventListener('gattserverdisconnected', onDisconnected); } catch (e) {} }
    device = dev;
    device.removeEventListener('gattserverdisconnected', onDisconnected);
    device.addEventListener('gattserverdisconnected', onDisconnected);
    setStatus('connecting');
    connected = false;
    server = await device.gatt.connect();
    const svc = await resolveService(server);
    if (!svc) { try { device.gatt.disconnect(); } catch (e) {} setStatus('no-service'); log('no known service found. Wrong model? Please report.', 'log-err'); return; }
    // If the advertised name gave no family (e.g. "ePFHilde"), take it from the service that was found.
    if (activeProto.family !== 'LEGACY' && activeProto.family !== 'ZYD') {
      applyDetectedProto(usedTransport === TRANSPORTS.legacy ? 'legacy' : 'zyd', 'classified from the ' + usedTransport.name + ' service (name carried no model).');
    }
    writeChar = await svc.getCharacteristic(usedTransport.write).catch(() => null);
    notifyChar = await svc.getCharacteristic(usedTransport.notify).catch(() => null);
    if (!writeChar || !notifyChar) { try { device.gatt.disconnect(); } catch (e) {} setStatus('no-char'); log('write/notify characteristic missing on ' + usedTransport.name, 'log-err'); return; }
    atWriteChar = null;
    if (activeProto.family === 'ZYD') {
      const atSvc = await server.getPrimaryService(TRANSPORTS.zyd.atService).catch(() => null);
      if (atSvc) atWriteChar = await atSvc.getCharacteristic(TRANSPORTS.zyd.atWrite).catch(() => null);
    }
    await notifyChar.startNotifications();
    notifyChar.removeEventListener('characteristicvaluechanged', onCharacteristicValue);
    notifyChar.addEventListener('characteristicvaluechanged', onCharacteristicValue);
    connected = true;
    speedUnlocked = false;
    setControlsEnabled(true);
    const info = $('devinfo');
    if (info) info.textContent = t('devPrefix') + ' ' + (device.name || '(no name)') + '  -  ' + t(activeProto.family === 'LEGACY' ? 'genOlder' : 'genNewer') + ', ' + t('devConnected');
    try { if (device.id) localStorage.setItem(LS_DEVICE, device.id); } catch (e) {}
    log('connected: ' + (device.name || '(no name)') + ' [' + device.id + ']', 'log-ok');
    log('family ' + activeProto.family + '  service ' + usedTransport.service, 'log-ok');
    log('char  write=' + writeChar.uuid + '  notify=' + notifyChar.uuid + (atWriteChar ? '  at=' + atWriteChar.uuid : ''), 'log-ok');
    applyModelUi();
    afterConnect();
  } catch (e) {
    setStatus('disconnected');
    log('connect failed: ' + e, 'log-err');
  } finally { connecting = false; }
}

// Post-connect handshake, per family.
//   ZYD: optional AT+PWD, then a 500 ms sendTran keep-alive that drives the 0xAB monitoring, plus one
//        ESC-info request for the firmware version.
//   Legacy: a 500 ms FF 55 01 00 55 confirmation keep-alive (belegt: onServicesDiscovered timer).
function afterConnect() {
  setStatus('connected');
  stopKeep();
  if (activeProto.family === 'ZYD') {
    const pin = ($('pin-in') && $('pin-in').value.trim()) || '';
    if (pin && atWriteChar) { atWriteChar.writeValue(new TextEncoder().encode('AT+PWD[' + pin + ']')).then(() => log('TX  AT+PWD[' + pin + '] (AT F2F1)', 'log-tx')).catch(e => log('AT+PWD failed: ' + e, 'log-err')); }
    keepTimer = setInterval(() => { if (connected) writeFrame(zydTranFrame(0x00)).catch(() => {}); }, 500);
    transmit(zydTranFrame(0x00), 'sendTran (nudge)');
    transmit(zydReadFrame(0x07, 0, 4), 'ESC-info request 0x07', 'zyd:esc');
  } else {
    keepTimer = setInterval(() => { if (connected) writeFrame(ff55Frame(0x01, [])).catch(() => {}); }, 500);
    transmit(ff55Frame(0x01, []), 'confirm keep-alive FF5501');
  }
  maybeRunDeepAction();
}
function stopKeep() { if (keepTimer) { clearInterval(keepTimer); keepTimer = null; } }

function onDisconnected(ev) {
  if (ev && ev.target && ev.target !== device) return;
  connected = false; speedUnlocked = false; clearAcks(); stopKeep();
  setStatus('disconnected');
  const cb = $('btn-conn'); if (cb) cb.disabled = !modelChosen;
  setControlsEnabled(false); resetTiles();
  const info = $('devinfo'); if (info) info.textContent = '';
  log('disconnected.', 'log-err');
}
function disconnectBle() {
  const d = device;
  if (d) { try { d.removeEventListener('gattserverdisconnected', onDisconnected); } catch (e) {} }
  try { if (d && d.gatt && d.gatt.connected) d.gatt.disconnect(); } catch (e) {}
  device = null; server = null; writeChar = null; notifyChar = null; atWriteChar = null;
  connected = false; clearAcks(); stopKeep();
  setStatus('disconnected'); setControlsEnabled(false); resetTiles();
  const info = $('devinfo'); if (info) info.textContent = '';
}

function onCharacteristicValue(ev) {
  try { const b = new Uint8Array(ev.target.value.buffer); log('RX  ' + bytesToHex(b), 'log-rx'); handleFrame(b); }
  catch (e) { log('RX parse error: ' + e, 'log-err'); }
}

// --------------------------- inbound dispatch + telemetry ---------------------------
const rdU16BE = (d, o) => ((d[o] << 8) | d[o + 1]) >>> 0;
const rdS16BE = (d, o) => { const v = rdU16BE(d, o); return v & 0x8000 ? v - 0x10000 : v; };
const rdS8 = v => (v & 0x80 ? v - 0x100 : v);

function handleFrame(b) {
  if (!b || b.length < 2) return;
  if (activeProto.family === 'LEGACY') { handleLegacy(b); return; }
  const head = b[0];
  if (head === 0xAB) { decodeZydMonitor(b); return; }
  if (head === 0x01) { resolveAck('zyd:esc', bytesToHex(b)); log('  ZYD info/cmd frame (head 01, cmd 0x' + (b[1] || 0).toString(16) + ').'); return; }
  log('  note: unrecognized ZYD head 0x' + head.toString(16) + ' (raw hex above).');
}
function decodeZydMonitor(b) {
  const sub = b[1];
  if (sub === 0x00 && b.length >= 23) {
    const status = rdU16BE(b, 21);
    const speed = Math.max(rdU16BE(b, 6), rdU16BE(b, 8)) / 1000;
    const volt = rdU16BE(b, 10) / 10;
    const cur = rdS16BE(b, 12) / 64;
    const batt = b[5];
    const escT = rdS8(b[14]), motT = rdS8(b[15]);
    const lock = (status >> 11) & 1;
    // keep the tracked base-params in step so a single-setting write resends the others unchanged
    bp.gear = b[4] & 0x03; bp.lock = lock;
    bp.headlight = (status >> 2) & 1; bp.boot = (status >> 5) & 1; bp.imperial = (status >> 6) & 1;
    bp.cruise = (status >> 9) & 1; bp.ambient = (status >> 15) & 1;
    setTile('t-speed', speed.toFixed(1) + ' km/h');
    setTile('t-batt', batt + ' %');
    setTile('t-volt', volt.toFixed(1) + ' V');
    setTile('t-cur', cur.toFixed(1) + ' A');
    setTile('t-temp', escT + '/' + motT + ' C');
    setTile('t-lock', t(lock ? 'valLocked' : 'valUnlocked'));
    log('  monitorA: speed=' + speed.toFixed(1) + 'km/h batt=' + batt + '% ' + volt.toFixed(1) + 'V ' + cur.toFixed(1) + 'A escT=' + escT + ' motT=' + motT + ' gear=' + b[4] + ' lock=' + lock + ' trip=' + (rdU16BE(b, 16) / 10).toFixed(1) + 'km', 'log-ok');
  } else if (sub === 0x01 && b.length >= 16) {
    const fault = rdU16BE(b, 8);
    const faults = faultList(fault);
    bp.limitCruise = b[3]; bp.m1 = b[4]; bp.m2 = b[5]; bp.m3 = b[6];
    log('  monitorB: limits=' + b[4] + '/' + b[5] + '/' + b[6] + 'km/h cruiseLimit=' + b[3] + ' battTemp=' + rdS8(b[7]) + ' fault=' + (faults.length ? faults.join(',') : 'none') + ' cap=' + rdU16BE(b, 14) + '/' + rdU16BE(b, 12), 'log-ok');
  } else { log('  monitor frame sub=' + sub + ' len=' + b.length + ' (not decoded).'); }
}
function faultList(w) { const map = { 1: 'E1', 2: 'E2', 3: 'E3', 4: 'E4', 7: 'E7', 9: 'E9', 10: 'F1', 11: 'F2' }; const out = []; for (const bit in map) if ((w >> bit) & 1) out.push(map[bit]); return out; }
function handleLegacy(b) {
  if (b[0] !== 0xFF) { log('  note: legacy frame does not start with 0xFF (raw hex above).'); return; }
  const op = b[2];
  resolveAck('ff:' + op, bytesToHex(b));
  if (op === 0x0A && b.length > 4) { let v = 0; for (let i = 4; i < b.length - 1; i++) v = (v << 8) | b[i]; const sp = v * 0.001; setTile('t-speed', sp.toFixed(1) + ' km/h'); log('  legacy speed=' + sp.toFixed(1) + 'km/h', 'log-ok'); }
  else if (op === 0x0E && b.length > 4) { let v = 0; for (let i = 4; i < b.length - 1; i++) v = (v << 8) | b[i]; setTile('t-volt', (v * 0.001).toFixed(1) + ' V'); }
}

// --------------------------- writing frames + commands ---------------------------
async function writeFrame(bytes) {
  const wc = writeChar;
  if (!wc) throw new Error('not connected');
  if (wc.writeValueWithResponse) return wc.writeValueWithResponse(bytes);
  if (wc.writeValueWithoutResponse) return wc.writeValueWithoutResponse(bytes);
  return wc.writeValue(bytes);
}

const ACK_TIMEOUT_MS = 3000;
const pendingAcks = new Map();
function armAck(key, label) {
  const prev = pendingAcks.get(key); if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => { pendingAcks.delete(key); log('  no confirmation for "' + label + '" within ' + (ACK_TIMEOUT_MS / 1000) + 's (scooter sent no matching echo).', 'log-err'); }, ACK_TIMEOUT_MS);
  pendingAcks.set(key, { label, timer });
}
function resolveAck(key, echoHex) {
  const p = pendingAcks.get(key); if (!p) return false;
  clearTimeout(p.timer); pendingAcks.delete(key);
  log('  confirmed: scooter acknowledged "' + p.label + '" (echo ' + echoHex + ').', 'log-ok');
  return true;
}
function clearAcks() { pendingAcks.forEach(p => clearTimeout(p.timer)); pendingAcks.clear(); }

async function transmit(frame, label, ackKey) {
  if (!connected || !writeChar) { log('not connected', 'log-err'); return; }
  try {
    log('TX  ' + bytesToHex(frame) + '   (' + label + ')', 'log-tx');
    if (ackKey) armAck(ackKey, label);
    await writeFrame(frame);
    log('sent.', 'log-ok');
  } catch (e) { log('send failed: ' + e, 'log-err'); }
}

function cmdSetMaxSpeed(kmh, persist) {
  if (!activeProto.speed) { log('this model has no BLE speed command.', 'log-err'); return; }
  if (persist !== false) { try { localStorage.setItem(LS_SPEED, String(kmh)); } catch (e) {} }
  const frame = zydSpeedFrame(kmh);
  transmit(frame, 'max speed ' + kmh + ' km/h -> register 0x20', 'zyd:speed');
  log('  note: an echo means the controller accepted the write. Whether it actually rides the value shows only in the live telemetry.', 'log-ok');
}
function cmdGear(d2) {
  if (activeProto.family !== 'LEGACY') { log('gear switch is a legacy-only command.', 'log-err'); return; }
  transmit(ff55Frame(0x1F, [d2 ? 0x03 : 0x02]), 'gear ' + (d2 ? 'D2' : 'D1') + ' 0x1F', 'ff:' + 0x1F);
}
// Build the 10-byte monitor frame from the tracked base-params, changing one field first.
function monitorFromBp() {
  const vb = zydStatusByte({ gear: bp.gear, headlight: bp.headlight, ambient: bp.ambient, cruise: bp.cruise, boot: bp.boot, imperial: bp.imperial, lock: bp.lock });
  return zydMonitorFrame(vb, bp.limitCruise, bp.m1, bp.m2, bp.m3);
}
function cmdBaseParam(field, value, label) {
  bp[field] = value;
  transmit(monitorFromBp(), label);
}
function cmdVLock(lock) {
  if (activeProto.family === 'LEGACY') { transmit(ff55Frame(0x17, [lock ? 0x02 : 0x01]), (lock ? 'lock' : 'unlock') + ' 0x17', 'ff:' + 0x17); return; }
  cmdBaseParam('lock', lock ? 1 : 0, (lock ? 'lock' : 'unlock') + ' via monitor');
}
function cmdSetName(name) {
  const s = (name || '').trim().slice(0, 16);
  if (!s) { log('name is empty.', 'log-err'); return; }
  if (activeProto.family !== 'ZYD' || !atWriteChar) { log('setting the name needs the AT channel (newer models).', 'log-err'); return; }
  const cmd = 'AT+NAME[' + s + ']';
  atWriteChar.writeValue(new TextEncoder().encode(cmd)).then(() => log('TX  ' + cmd + ' (AT F2F1)', 'log-tx')).catch(e => log('set name failed: ' + e, 'log-err'));
}
// Register write (adv-parameter, CMD_RW_PARAMETER 0x17). Encoding per parameter, belegt from
// BleCore$setAdvParams: opv -> round(v*opv); int -> round(v); realmax -> round(v)*floor(real/max);
// index -> the raw index. All 16-bit big-endian at the register address.
function encodeReg(reg, v) {
  let n;
  if (reg.enc === 'opv') n = Math.round(v * reg.opv);
  else if (reg.enc === 'realmax') n = Math.round(v) * reg.factor;
  else n = Math.round(v);   // 'int' and 'index'
  n &= 0xFFFF;
  return zydRwParamFrame(reg.addr, [(n >> 8) & 0xFF, n & 0xFF]);
}
function cmdRegister(reg, v, label) { transmit(encodeReg(reg, v), label + ' -> register 0x' + reg.addr.toString(16), 'zyd:reg' + reg.addr); }

// Every setting the ZYD protocol exposes, grouped. base -> a bit/field in the monitor frame;
// reg -> a CMD_RW_PARAMETER register; special -> a hand-written command. risky -> confirm first.
const SETTINGS = [
  { g: 'light', id: 'headlight', type: 'switch', base: 'headlight' },
  { g: 'light', id: 'ambient', type: 'switch', base: 'ambient' },
  { g: 'ride', id: 'gear', type: 'select', base: 'gear', options: [['0', '1'], ['1', '2'], ['2', '3']] },
  { g: 'ride', id: 'cruise', type: 'switch', base: 'cruise' },
  { g: 'ride', id: 'zeroStart', type: 'switch', base: 'boot' },
  { g: 'ride', id: 'unit', type: 'switch', base: 'imperial' },
  { g: 'ride', id: 'limit1', type: 'number', base: 'm1', min: 1, max: 60, step: 1, unit: 'km/h' },
  { g: 'ride', id: 'limit2', type: 'number', base: 'm2', min: 1, max: 60, step: 1, unit: 'km/h' },
  { g: 'ride', id: 'limit3', type: 'number', base: 'm3', min: 1, max: 60, step: 1, unit: 'km/h' },
  { g: 'ride', id: 'throttleAccel', type: 'number', reg: { addr: 0x09, enc: 'realmax', factor: 3000 }, min: 0, max: 10, step: 1 },
  { g: 'ride', id: 'throttleBrake', type: 'number', reg: { addr: 0x0a, enc: 'realmax', factor: 3000 }, min: 0, max: 10, step: 1 },
  { g: 'system', id: 'cruiseTime', type: 'number', reg: { addr: 0x33, enc: 'int' }, min: 2, max: 30, step: 1, unit: 's' },
  { g: 'system', id: 'shutdownTime', type: 'number', reg: { addr: 0x34, enc: 'int' }, min: 2, max: 30, step: 1, unit: 'min' },
  { g: 'system', id: 'wheel', type: 'number', reg: { addr: 0x17, enc: 'opv', opv: 25.4 }, min: 0.5, max: 15, step: 0.5, unit: 'inch', risky: true },
  { g: 'system', id: 'carrier', type: 'select', reg: { addr: 0x21, enc: 'index' }, options: [['0', '8K'], ['1', '10K'], ['2', '12K'], ['3', '15K'], ['4', 'AUTO']], risky: true },
  { g: 'system', id: 'serviceKm', type: 'number', reg: { addr: 0x4a, enc: 'int' }, min: 50, max: 60000, step: 50, unit: 'km' },
  { g: 'system', id: 'vlock', type: 'select', special: 'vlock', options: [['0', 'unlock'], ['1', 'lock']] },
  { g: 'system', id: 'name', type: 'text', special: 'name', max: 16 },
  { g: 'motor', id: 'modDepth', type: 'number', reg: { addr: 0x02, enc: 'realmax', factor: 436 }, min: 1, max: 50, step: 1, risky: true },
  { g: 'motor', id: 'polePairs', type: 'number', reg: { addr: 0x04, enc: 'int' }, min: 1, max: 30, step: 1, risky: true },
  { g: 'motor', id: 'dischargeCur', type: 'number', reg: { addr: 0x0b, enc: 'opv', opv: 64 }, min: 0.5, max: 20, step: 0.5, unit: 'A', risky: true },
  { g: 'motor', id: 'brakeCur', type: 'number', reg: { addr: 0x0c, enc: 'opv', opv: 64 }, min: 0.5, max: 30, step: 0.5, unit: 'A', risky: true },
  { g: 'motor', id: 'voltProt', type: 'number', reg: { addr: 0x13, enc: 'opv', opv: 10 }, min: 18, max: 44, step: 0.5, unit: 'V', risky: true },
];
const SETTING_GROUPS = ['light', 'ride', 'system', 'motor'];

function sendSetting(s) {
  let label = t('set_' + s.id) || s.id;
  if (s.special === 'vlock') { cmdVLock($('set-' + s.id).value === '1'); return; }
  if (s.special === 'name') { cmdSetName($('set-' + s.id).value); return; }
  if (s.type === 'switch') { const on = $('set-' + s.id).value === '1'; cmdBaseParam(s.base, on ? 1 : 0, label + ' ' + (on ? 'on' : 'off')); return; }
  if (s.base) { const v = parseInt($('set-' + s.id).value, 10); if (isNaN(v)) return; cmdBaseParam(s.base, v, label + ' ' + v); return; }
  if (s.reg) { const raw = $('set-' + s.id).value; const v = (s.reg.enc === 'index') ? parseInt(raw, 10) : parseFloat(raw); if (isNaN(v)) return; cmdRegister(s.reg, v, label + ' ' + raw); }
}
function trySendSetting(s) {
  if (s.risky) { confirmRisky(t('set_' + s.id) || s.id, () => sendSetting(s)); return; }
  sendSetting(s);
}
function renderSettings() {
  const host = $('settings-list'); if (!host || host.dataset.built) return;
  host.dataset.built = '1';
  SETTING_GROUPS.forEach(gk => {
    const items = SETTINGS.filter(s => s.g === gk);
    if (!items.length) return;
    const h = document.createElement('h3'); h.className = 'set-group'; h.setAttribute('data-t', 'grp_' + gk); h.textContent = t('grp_' + gk);
    host.appendChild(h);
    items.forEach(s => {
      const row = document.createElement('div'); row.className = 'set-row';
      const lab = document.createElement('label'); lab.className = 'set-label';
      const span = document.createElement('span'); span.id = 'setlbl-' + s.id; span.textContent = settingLabelText(s);
      const help = document.createElement('button'); help.type = 'button'; help.className = 'help-btn'; help.textContent = '?'; help.setAttribute('aria-label', 'Info');
      help.addEventListener('click', () => openSettingHelp(s.id));
      lab.appendChild(span); lab.appendChild(help);
      row.appendChild(lab);
      let ctrl;
      if (s.type === 'switch') { ctrl = document.createElement('select'); [['1', t('optOn')], ['0', t('optOff')]].forEach(([v, txt]) => { const o = document.createElement('option'); o.value = v; o.textContent = (s.id === 'unit') ? (v === '1' ? 'mph' : 'km/h') : txt; ctrl.appendChild(o); }); }
      else if (s.type === 'select') { ctrl = document.createElement('select'); s.options.forEach(([v, txt]) => { const o = document.createElement('option'); o.value = v; o.textContent = /^(unlock|lock)$/.test(txt) ? t(txt === 'lock' ? 'btnLock' : 'btnUnlock') : txt; ctrl.appendChild(o); }); }
      else if (s.type === 'text') { ctrl = document.createElement('input'); ctrl.type = 'text'; if (s.max) ctrl.maxLength = s.max; }
      else { ctrl = document.createElement('input'); ctrl.type = 'number'; if (s.min != null) ctrl.min = s.min; if (s.max != null) ctrl.max = s.max; if (s.step != null) ctrl.step = s.step; }
      ctrl.id = 'set-' + s.id; ctrl.disabled = true;
      row.appendChild(ctrl);
      const btn = document.createElement('button'); btn.id = 'setbtn-' + s.id; btn.setAttribute('data-t', 'btnSend'); btn.textContent = t('btnSend'); btn.disabled = true;
      btn.addEventListener('click', () => trySendSetting(s));
      row.appendChild(btn);
      host.appendChild(row);
    });
  });
}
function setSettingsEnabled(on) {
  SETTINGS.forEach(s => { const c = $('set-' + s.id); const b = $('setbtn-' + s.id); if (c) c.disabled = !on; if (b) b.disabled = !on; });
}
function settingLabelText(s) { return t('set_' + s.id) + (s.unit ? ' (' + s.unit + ')' : ''); }
function setHelpWarn(text) { const wn = $('help-warn'); if (!wn) return; if (text) { wn.textContent = text; wn.hidden = false; } else { wn.textContent = ''; wn.hidden = true; } }
// Per-setting "?" explanation, shown in the shared help dialog. Risky settings add a red warning line.
function openSettingHelp(id) {
  const dlg = $('help'); if (!dlg) return;
  const ti = $('help-title'); if (ti) ti.textContent = t('set_' + id);
  const bo = $('help-body'); if (bo) bo.textContent = t('help_' + id);
  setHelpWarn(t('warn_' + id));
  if (dlg.showModal) { try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); } } else dlg.setAttribute('open', '');
}
// Update the dynamically built setting labels/options after a language switch (data-t handles the rest).
function retranslateSettings() {
  SETTINGS.forEach(s => {
    const sp = $('setlbl-' + s.id); if (sp) sp.textContent = settingLabelText(s);
    const c = $('set-' + s.id);
    if (c && c.options && c.options.length >= 2 && s.type === 'switch') { c.options[0].textContent = (s.id === 'unit') ? 'mph' : t('optOn'); c.options[1].textContent = (s.id === 'unit') ? 'km/h' : t('optOff'); }
    if (c && c.options && c.options.length >= 2 && s.special === 'vlock') { c.options[0].textContent = t('btnUnlock'); c.options[1].textContent = t('btnLock'); }
  });
}
// Themed confirm for a risky write. Falls back to window.confirm if the dialog is missing.
function confirmRisky(name, onOk) {
  const dlg = $('confirm');
  if (!dlg || !dlg.showModal) { if (window.confirm(t('riskyText') + '\n\n' + name)) onOk(); return; }
  const body = $('confirm-body'); if (body) body.textContent = t('riskyText') + ' (' + name + ')';
  const ok = $('confirm-ok'), cancel = $('confirm-cancel'), cx = $('confirm-cancel-x');
  const close = () => { try { dlg.close(); } catch (e) { dlg.removeAttribute('open'); } ok.removeEventListener('click', okH); cancel.removeEventListener('click', close); if (cx) cx.removeEventListener('click', close); };
  const okH = () => { close(); onOk(); };
  ok.addEventListener('click', okH); cancel.addEventListener('click', close); if (cx) cx.addEventListener('click', close);
  try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); }
}

// --------------------------- shortcut deep-link + auto-reconnect ---------------------------
let pendingDeepAction = null;
function parseDeepLink() {
  try {
    let a = (new URLSearchParams(location.search).get('do') || '').toLowerCase();
    if (!a && location.hash) a = (new URLSearchParams(location.hash.replace(/^#/, '')).get('do') || '').toLowerCase();
    if (a === 'slow' || a === 'fast') { pendingDeepAction = a; log('shortcut: ' + a + ' requested'); }
  } catch (e) {}
}
function maybeRunDeepAction() {
  if (!pendingDeepAction || !connected) return;
  const a = pendingDeepAction; pendingDeepAction = null;
  if (!activeProto.speed) { log('shortcut ' + a + ' ignored: this model has no BLE speed command.', 'log-err'); return; }
  if (a === 'fast') { const v = openSpeedValue(); log('shortcut: unlock -> ' + v + ' km/h'); cmdSetMaxSpeed(v, true); speedUnlocked = true; }
  else { const v = ekfvSpeedValue(); log('shortcut: lock -> ' + v + ' km/h (eKFV)'); cmdSetMaxSpeed(v, false); speedUnlocked = false; }
  updateToggleButton();
}
async function tryAutoReconnect() {
  if (!navigator.bluetooth || !navigator.bluetooth.getDevices) return;
  try {
    const devs = await navigator.bluetooth.getDevices();
    if (!devs || !devs.length) return;
    const savedId = localStorage.getItem(LS_DEVICE);
    let dev = (savedId && devs.find(d => d.id === savedId)) || null;
    if (!dev && autoDetect) dev = devs.find(d => classifyByName(d.name)) || null;
    if (!dev) return;
    const fam = classifyByName(dev.name);
    if (fam) applyDetectedProto(fam, 'auto-reconnect detected ' + (fam === 'legacy' ? 'Legacy' : 'ZYD') + ' from "' + dev.name + '"');
    log('auto-reconnect: ' + (dev.name || dev.id));
    await connectGatt(dev);
  } catch (e) { setStatus('disconnected'); log('auto-reconnect skipped: ' + e); }
}

// --------------------------- language ---------------------------
let lang = 'de';
function table() { return (window.I18N && window.I18N[lang]) || {}; }
function t(key) { const v = table()[key]; return (typeof v === 'string') ? v : ''; }
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-t]').forEach(n => { const v = t(n.getAttribute('data-t')); if (/[<&]/.test(v)) n.innerHTML = v; else n.textContent = v; });   // scan-ok: our own translation table
  { const el = $('link-guide'); if (el) el.href = docFile('GUIDE'); }
  { const el = $('link-readme'); if (el) el.href = docFile('README'); }
  { const el = $('link-license'); if (el) el.href = docFile('LICENSE'); }
  { const el = $('link-privacy'); if (el) el.href = docFile('PRIVACY'); }
  { const el = $('link-trademarks'); if (el) el.href = docFile('TRADEMARKS'); }
  { const el = $('langs'); if (el) el.setAttribute('aria-label', t('langGroup')); }
  updateToggleButton();
  { const dark = document.documentElement.getAttribute('data-theme') !== 'light'; const el = $('btn-theme'); if (el) { el.setAttribute('aria-label', t(dark ? 'themeToLight' : 'themeToDark')); el.title = el.getAttribute('aria-label'); } }
  { const el = $('build-ver'); if (el) el.textContent = t('buildLabel') + ' ' + BUILD; }
  document.querySelectorAll('#langs button').forEach(b => { b.setAttribute('aria-pressed', String(b.dataset.lang === lang)); });
  retranslateSettings();
  { const el = $('status'); setStatus(el ? el.dataset.state : 'disconnected'); }
}
function initLangSwitch() { document.querySelectorAll('#langs button').forEach(b => { b.addEventListener('click', () => { lang = b.dataset.lang; applyLang(); }); }); }

// --------------------------- theme ---------------------------
function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const b = $('btn-theme');
  if (b) { b.innerHTML = dark ? '&#9728;' : '&#9790;'; b.setAttribute('aria-label', t(dark ? 'themeToLight' : 'themeToDark')); b.title = b.getAttribute('aria-label'); }   // scan-ok: a fixed character, not user input
  try { localStorage.setItem(LS_THEME, dark ? 'dark' : 'light'); } catch (e) {}
}
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(LS_THEME); } catch (e) {}
  applyTheme(saved !== 'light');
  const b = $('btn-theme');
  if (b) b.addEventListener('click', () => { applyTheme(document.documentElement.getAttribute('data-theme') === 'light'); });
}

// --------------------------- document viewer ---------------------------
const DOC_TITLES = {
  'GUIDE.de.md': 'footGuide', 'GUIDE.en.md': 'footGuide',
  'PRIVACY.de.md': 'footPrivacy', 'PRIVACY.md': 'footPrivacy',
  'LICENSE.de.md': 'footLicense', 'LICENSE.md': 'footLicense',
  'TRADEMARKS.de.md': 'footTrademarks', 'TRADEMARKS.md': 'footTrademarks',
  'README.md': 'footReadme',
};
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slug = s => s.toLowerCase().trim().replace(/[^\w\sÀ-ɏ-]/g, '').replace(/ /g, '-');
function mdToHtml(src) {
  const inline = s => escHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, text, href) => {
      if (DOC_TITLES[href]) return `<a href="${href}" data-docfile="${href}">${text}</a>`;
      if (href.startsWith('#')) return `<a href="${href}" data-anchor="${href.slice(1)}">${text}</a>`;
      return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
    });
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let listKind = null, li = null, para = [], inFence = false;
  const sink = () => (li ? li.parts : out);
  const flushPara = () => { if (para.length) { sink().push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const closeNested = () => { if (li && li.nested) { li.parts.push('</ul>'); li.nested = false; } };
  const closeLi = () => { if (!li) return; flushPara(); closeNested(); out.push('<li>' + li.parts.join('\n') + '</li>'); li = null; };
  const closeList = () => { closeLi(); if (listKind) { out.push('</' + listKind + '>'); listKind = null; } };
  const block = () => { flushPara(); closeList(); };
  const openList = kind => { flushPara(); if (listKind !== kind) { closeList(); out.push('<' + kind + '>'); listKind = kind; } else closeLi(); };
  const cells = l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const body = l.trim();
    const indented = /^ {2,}\S/.test(l);
    if (inFence) { if (body.startsWith('```')) { sink().push('</code></pre>'); inFence = false; } else sink().push(escHtml(l)); continue; }
    if (body.startsWith('```')) { if (li) { flushPara(); closeNested(); } else block(); sink().push('<pre><code>'); inFence = true; continue; }
    if (body === '') { if (li && /^ {2,}\S/.test(lines[i + 1] || '')) flushPara(); else block(); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(body)) { block(); out.push('<hr>'); continue; }
    if (body.startsWith('|') && /^\|[\s:|-]+\|?\s*$/.test((lines[i + 1] || '').trim())) {
      if (li) { flushPara(); closeNested(); } else block();
      sink().push('<div class="doc-table"><table><thead><tr>' + cells(body).map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>');
      i++;
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) sink().push('<tr>' + cells(lines[++i].trim()).map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>');
      sink().push('</tbody></table></div>');
      continue;
    }
    let m;
    if ((m = body.match(/^(#{1,4})\s+(.*)$/))) { block(); const n = m[1].length; out.push(`<h${n} id="${slug(m[2])}">${inline(m[2])}</h${n}>`); continue; }
    if ((m = body.match(/^>\s?(.*)$/))) { if (li) { flushPara(); closeNested(); } else block(); sink().push('<blockquote>' + inline(m[1]) + '</blockquote>'); continue; }
    if (indented && li && (m = body.match(/^[-*]\s+(.*)$/))) { flushPara(); if (!li.nested) { li.parts.push('<ul class="nested">'); li.nested = true; } li.parts.push('<li>' + inline(m[1]) + '</li>'); continue; }
    if ((m = body.match(/^[-*]\s+(.*)$/)) && !indented) { openList('ul'); li = { parts: [inline(m[1])], nested: false }; continue; }
    if ((m = body.match(/^\d+\.\s+(.*)$/)) && !indented) { openList('ol'); li = { parts: [inline(m[1])], nested: false }; continue; }
    if (li && !indented) closeList();
    if (li) closeNested();
    para.push(body);
  }
  if (inFence) sink().push('</code></pre>');
  block();
  return out.join('\n').replace(/<pre><code>\n/g, '<pre><code>');
}
const docCache = {};
const docFile = name => {
  if (name === 'GUIDE') return `GUIDE.${lang}.md`;
  if (name === 'README') return 'README.md';
  return lang === 'de' ? `${name}.de.md` : `${name}.md`;
};
function openDoc(name, anchor, titleKey) { openDocFile(docFile(name), anchor, titleKey); }
function openDocFile(file, anchor, titleKey) {
  const dlg = $('doc'), body = $('doc-body');
  if (!dlg || !body) return;
  const mark = (lang === 'de' && !file.includes('.de.') && file !== 'README.md') ? ' ' + t('docEnglish') : '';
  $('doc-title').textContent = (t(titleKey || DOC_TITLES[file] || '') || file) + mark;
  if (typeof dlg.showModal === 'function') dlg.showModal();
  const show = html => {
    body.innerHTML = html;   // scan-ok: markdown of our own documents, rendered by mdToHtml which escapes first
    const h1 = body.querySelector('h1');
    if (h1) { $('doc-title').textContent = h1.textContent.trim() + mark; h1.remove(); }
    body.scrollTop = 0;
    if (!anchor) return;
    const target = body.querySelector('#' + (window.CSS && CSS.escape ? CSS.escape(anchor) : anchor));
    if (target) body.scrollTop = target.offsetTop - body.offsetTop;
  };
  if (docCache[file]) { show(docCache[file]); return; }
  body.innerHTML = '<p>' + escHtml(t('docLoading')) + '</p>';   // scan-ok: escaped
  fetch(file + '?v=' + BUILD)
    .then(r => { if (!r.ok) throw new Error(r.status + ' ' + r.statusText); return r.text(); })
    .then(txt => { docCache[file] = mdToHtml(txt); show(docCache[file]); })
    .catch(e => { body.innerHTML = '<p>' + escHtml(t('docFail')) + '</p><pre class="err">' + escHtml(file + ': ' + (e && e.message ? e.message : e)) + '</pre>'; });   // scan-ok: escaped
}
function wireDocViewer() {
  document.addEventListener('click', e => {
    if (!e.target.closest) return;
    const jump = e.target.closest('[data-anchor]');
    if (jump) { e.preventDefault(); const body = $('doc-body'); const target = body && body.querySelector('#' + CSS.escape(jump.getAttribute('data-anchor'))); if (target) body.scrollTop = target.offsetTop - body.offsetTop; return; }
    const disc = e.target.closest('[data-open-disclaimer]');
    if (disc) { e.preventDefault(); openHelp('disclaimer'); return; }
    const a = e.target.closest('[data-doc], [data-docfile]');
    if (!a) return;
    e.preventDefault();
    const anchor = a.getAttribute('data-doc-anchor') || '';
    const file = a.getAttribute('data-docfile');
    const titleKey = a.getAttribute('data-t') || '';
    if (file) openDocFile(file, anchor, titleKey); else openDoc(a.getAttribute('data-doc'), anchor, titleKey);
  });
  ['doc-x', 'doc-close'].forEach(id => { const b = $(id); if (b) b.addEventListener('click', () => { const d = $('doc'); if (d) d.close(); }); });
}

// --------------------------- init ---------------------------
window.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.help-btn').forEach(btn => btn.addEventListener('click', () => openHelp(btn.getAttribute('data-help'))));
  ['help-x', 'help-close'].forEach(id => { const b = $(id); if (b) b.addEventListener('click', closeHelp); });
  { const b = $('link-disclaimer'); if (b) b.addEventListener('click', e => { e.preventDefault(); openHelp('disclaimer'); }); }
  logDiagnosticHeader();
  initLangSwitch();
  initTheme();
  wireDocViewer();
  buildModelDropdown();

  let saved = null;
  try { saved = localStorage.getItem(LS_MODEL); } catch (e) {}
  const validModel = (saved === 'auto') || !!PROTOCOLS[saved];
  setModel(validModel ? saved : 'auto', true);
  { try { const s = localStorage.getItem(LS_SPEED); if (s && $('speed-in')) $('speed-in').value = s; } catch (e) {} }
  { try { const k = localStorage.getItem(LS_EKFV); if (k && $('ekfv-in')) $('ekfv-in').value = k; } catch (e) {} }
  { try { const pin = localStorage.getItem(LS_PIN); if (pin && $('pin-in')) $('pin-in').value = pin; } catch (e) {} }
  applyLang();

  log('protocol self-test (frame builders vs belegte vectors): ' + (PROTO_OK ? 'OK' : 'FAILED'), PROTO_OK ? 'log-ok' : 'log-err');
  if (!modelChosen) log('no model selected yet. Pick your model to begin.');

  $('btn-conn').addEventListener('click', () => { if ($('btn-conn').dataset.act === 'disconnect') disconnectBle(); else pickAndConnect(); });
  { const sel = $('model-in'); if (sel) sel.addEventListener('change', () => setModel(sel.value)); }
  $('btn-toggle').addEventListener('click', doSpeedToggle);
  { const s = $('speed-in'); if (s) s.addEventListener('change', () => { try { localStorage.setItem(LS_SPEED, s.value); } catch (e) {} }); }
  { const e2 = $('ekfv-in'); if (e2) e2.addEventListener('change', () => { try { localStorage.setItem(LS_EKFV, e2.value); } catch (er) {} }); }
  { const pin = $('pin-in'); if (pin) pin.addEventListener('change', () => { try { localStorage.setItem(LS_PIN, pin.value.trim()); } catch (e) {} }); }
  { const b = $('btn-gear1'); if (b) b.addEventListener('click', () => cmdGear(false)); }
  { const b = $('btn-gear2'); if (b) b.addEventListener('click', () => cmdGear(true)); }
  renderSettings();
  { const b = $('btn-copy-log'); if (b) b.addEventListener('click', copyLog); }
  { const b = $('btn-diag'); if (b) b.addEventListener('click', scanAllDevicesDiagnostic); }
  { const b = $('btn-clear-log'); if (b) b.addEventListener('click', clearLog); }

  setControlsEnabled(false);
  if (!navigator.bluetooth) log('Web Bluetooth not available. On iOS use the Bluefy browser.', 'log-err');
  parseDeepLink();
  if (pendingDeepAction) tryAutoReconnect();
});
