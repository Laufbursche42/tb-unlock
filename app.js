'use strict';
// Trittbrett tool shell. Driver-agnostic: talks to the driver only through the LB.BaseDriver contract.
// Ported from lb-tool-web/app.js and scoped to the single Trittbrett manufacturer (no manufacturer
// picker, no static pages, no firmware patcher, no account auth). The tuning + log panel are identical
// to lb-tool-web; nothing on the wire is invented here.
// Build version - the pre-commit hook bumps it and syncs index.html ?v=; also shown in the footer.
// Kept at column zero so the hook's `^const BUILD = 'vN'` match finds it.
const BUILD = 'v22';

(function () {

  // Single fixed manufacturer config (the 'tb' registry row from lb-tool-web/manufacturers/registry.js).
  var TB_CONFIG = {
    id: 'tb',
    name: 'Trittbrett',
    kind: 'interactive',
    brand: { title: 'Trittbrett' },
    driver: 'zyd',
    models: [
      { key: 'fritz',  label: 'FRITZ (TBT4275)',         caps: { bleSpeed: true },  tested: false },
      { key: 'paul',   label: 'PAUL (TBT4126)',          caps: { bleSpeed: true },  tested: false },
      { key: 'sultan', label: 'SULTAN (TBT4495)',        caps: { bleSpeed: true },  tested: false },
      { key: 'hilde1', label: 'Hilde 1',                 caps: { bleSpeed: true },  tested: true },
      { key: 'hilde2', label: 'Hilde 2',                 caps: { bleSpeed: true },  tested: true },
      { key: 'kalle',  label: 'KALLE v2 (TBT4243)',      caps: { bleSpeed: true },  tested: false },
      { key: 'emma',   label: 'EMMA v2 (TBT4245)',       caps: { bleSpeed: true },  tested: false },
      { key: 'legacy', label: 'KALLE/EMMA v1 (TBT4130)', caps: { bleSpeed: false }, tested: false },
    ],
    ble: {
      serviceUUIDs: [],
      deviceNamePrefixes: ['zyd', 'hw_', 'Scooter'],
      optionalServices: [
        '0000f1f0-0000-1000-8000-00805f9b34fb',   // ZYD data
        '0000f2f0-0000-1000-8000-00805f9b34fb',   // AT
        '00007777-0000-1000-8000-00805f9b34fb',   // legacy FF55
      ],
      acceptAllDevices: true,
    },
    firmware: null,
    trademarks: [
      { n: 'Trittbrett', de: 'eine Marke des jeweiligen Rechteinhabers.', en: 'a trademark of the respective rights holder.' },
      { n: 'HobbyWing',  de: 'Motor-Steuergeräte; eine Marke ihres Herstellers.', en: 'motor controllers; a trademark of its maker.' },
    ],
  };

  // ---- small helpers -------------------------------------------------------
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    getJSON: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    setJSON: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  var SK = { // storage keys
    lang: 'tb.lang', theme: 'tb.theme',
    sect: function (id) { return 'tb.sect.' + id; },
    model: 'tb.model',
    tiles: 'tb.tiles',
    remembered: 'tb.remembered',
    publicLog: 'tb.publiclog',
  };

  // ---- state ---------------------------------------------------------------
  var state = {
    lang: 'de',
    cfg: TB_CONFIG,     // fixed single manufacturer
    driver: null,       // driver instance
    device: null,       // BluetoothDevice
    deviceId: null,     // raw id (redacted in the log)
    modelKey: '',       // manual model override ('' = auto)
    connected: false,
    statusKey: 'stDisconnected',
    pendingAction: null, // deep-link ?do=
    publicLog: true,     // anonymize the log (default on)
    diag: false,         // diagnostic raw-frame log
    currentDoc: null,
    logBuffer: [],       // { raw, cls } lines; raw keeps \x01 sentinels, anonymized on display/copy/save
  };

  // ---- live tiles definition (generic telemetry surface) -------------------
  var TILE_DEFS = [
    { id: 'speed', labelKey: 'tileSpeed' },
    { id: 'mode',  labelKey: 'tileMode' },
    { id: 'batt',  labelKey: 'tileBatt' },
    { id: 'lock',  labelKey: 'tileLock' },
    { id: 'turn',  labelKey: 'tileTurn' },
    { id: 'volt',  labelKey: 'tileVolt' },
    { id: 'curr',  labelKey: 'tileCurr' },
    { id: 'power', labelKey: 'tilePower' },
    { id: 'fw',    labelKey: 'tileFw' },
    { id: 'err',   labelKey: 'tileErr' },
    { id: 'trip',  labelKey: 'tileTrip' },
    { id: 'total', labelKey: 'tileTotal' },
    { id: 'temp',  labelKey: 'tileTemp' },
    { id: 'cruise',   labelKey: 'tileCruise' },
    { id: 'battTemp', labelKey: 'tileBattTemp' },
    { id: 'cap',      labelKey: 'tileCap' },
    { id: 'disp',     labelKey: 'tileDisp' },
  ];

  // ---- i18n ----------------------------------------------------------------
  var HTML_KEY = /Html$/; // ONLY keys ending in "Html" are injected with innerHTML
  function dict() { return (window.UI_I18N && window.UI_I18N[state.lang]) || {}; }
  function t(key) {
    var d = dict();
    if (d[key] != null) return d[key];
    var en = (window.UI_I18N && window.UI_I18N.en) || {};
    return en[key] != null ? en[key] : key;
  }
  function brand() { return state.cfg && state.cfg.brand ? state.cfg.brand.title : ''; }
  function fill(str) { return String(str).replace(/\{brand\}/g, brand()).replace(/\s{2,}/g, ' ').trim(); }

  // Apply all static [data-t] nodes. textContent for everything except *Html keys.
  function applyStaticI18n(root) {
    $$('[data-t]', root || document).forEach(function (el) {
      if (el.id === 'status') return; // status text is dynamic (see setStatus)
      var key = el.getAttribute('data-t');
      var val = fill(t(key));
      if (HTML_KEY.test(key)) el.innerHTML = val; else el.textContent = val;   // scan-ok: only *Html i18n keys are injected as HTML
    });
    $$('[data-t-ph]', root || document).forEach(function (el) {
      el.setAttribute('placeholder', fill(t(el.getAttribute('data-t-ph'))));
    });
    $$('[data-t-title]', root || document).forEach(function (el) {
      var v = fill(t(el.getAttribute('data-t-title')));
      el.setAttribute('title', v); el.setAttribute('aria-label', v);
    });
  }

  // ---- theme ---------------------------------------------------------------
  function applyTheme(theme) {
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    var btn = $('#btn-theme');
    if (btn) btn.innerHTML = theme === 'light' ? '&#9789;' : '&#9728;'; // moon / sun   // scan-ok: literal icon entity
  }
  function toggleTheme() {
    var now = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    LS.set(SK.theme, now); applyTheme(now);
  }

  // ---- language ------------------------------------------------------------
  function setLang(lang) {
    if (!window.UI_I18N || !window.UI_I18N[lang]) return;
    state.lang = lang;
    LS.set(SK.lang, lang);
    document.documentElement.setAttribute('lang', lang);
    $$('#langs button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-lang') === lang)); });
    refreshUI();
  }
  // Re-run every dynamic render so the whole UI follows the language.
  function refreshUI() {
    applyStaticI18n(document);
    setStatus(state.statusKey);
    renderModelOptions(); renderTiles(); renderSettings(); renderAdvanced(); renderLock();
    renderRemembered();
  }

  // ---- status --------------------------------------------------------------
  function setStatus(stateKey, dataState) {
    state.statusKey = stateKey;
    var el = $('#status');
    if (!el) return;
    el.textContent = t(stateKey);
    if (dataState) el.setAttribute('data-state', dataState);
  }

  // ---- log + redaction (one central filter; copy/save use the same redacted text) ----
  function redact(text) {
    var s = String(text);
    if (state.deviceId) s = s.split(state.deviceId).join('[redacted-id]');
    // MAC addresses
    s = s.replace(/\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, '[redacted-mac]');
    // key/token/secret/serial/vin style assignments
    s = s.replace(/\b(secret|token|key|aes|pwd|password|pin|mac|serial|vin|uid|imei)\b(\s*[:=]\s*)("?)([^\s",]+)\3/gi,
      function (m, k, sep) { return k + sep + '[redacted]'; });
    // long hex runs (keys / serials / raw device ids)
    s = s.replace(/\b[0-9A-Fa-f]{16,}\b/g, '[redacted-hex]');
    return s;
  }
  // Anonymize a stored raw line for display/copy/save: mask driver-marked sensitive spans (\x01..\x01,
  // e.g. serial / uniquecode) and run the generic redaction - but ONLY when Public Log is on. Off = the
  // full raw line (local debugging only, do not share).
  function anonymize(s) {
    if (state.publicLog === false) return s.replace(/\x01/g, '');
    return redact(s.replace(/\x01[^\x01]*\x01/g, 'XX').replace(/\x01/g, ''));
  }
  function log(msg, cls) {
    var ts = new Date().toISOString().slice(11, 19);
    var raw = '[' + ts + '] ' + msg;          // stored raw (with sentinels); anonymized on the way out
    state.logBuffer.push({ raw: raw, cls: cls || '' });
    var pre = $('#log');
    if (pre) {
      var span = document.createElement('span');
      if (cls) span.className = cls;
      span.textContent = anonymize(raw) + '\n';
      pre.appendChild(span);
      pre.scrollTop = pre.scrollHeight;
    }
  }
  // Re-render the whole log pane (after the Public Log toggle flips).
  function renderLog() {
    var pre = $('#log'); if (!pre) return;
    pre.textContent = '';
    state.logBuffer.forEach(function (e) {
      var span = document.createElement('span');
      if (e.cls) span.className = e.cls;
      span.textContent = anonymize(e.raw) + '\n';
      pre.appendChild(span);
    });
    pre.scrollTop = pre.scrollHeight;
  }
  function clearLog() { state.logBuffer = []; var pre = $('#log'); if (pre) pre.textContent = ''; log(t('logCleared')); }
  function copyLog() {
    var text = state.logBuffer.map(function (e) { return anonymize(e.raw); }).join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { log(t('logCopied'), 'log-ok'); },
        function () { log('clipboard write failed', 'log-err'); });
    } else { log('clipboard API unavailable', 'log-err'); }
  }
  function saveLog() {
    var text = state.logBuffer.map(function (e) { return anonymize(e.raw); }).join('\n');
    try {
      var blob = new Blob([text], { type: 'text/plain' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'laufbursche-tb-log.txt';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      log(t('logSaved'), 'log-ok');
    } catch (e) { log('save failed: ' + e.message, 'log-err'); }
  }

  // ---- markdown renderer (small; fenced code blocks handled correctly) -----
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function inlineMd(s) {
    return s
      .replace(/`([^`]+)`/g, function (m, c) { return '<code>' + c + '</code>'; })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  function mdToHtml(md) {
    var codeBlocks = [];
    // 1) pull fenced code blocks out first so their content is never treated as markdown
    md = String(md).replace(/```[^\n]*\n?([\s\S]*?)```/g, function (m, code) {
      var i = codeBlocks.length;
      codeBlocks.push('<pre><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>');
      return '\x00CB' + i + '\x00';
    });
    var lines = md.split(/\r?\n/);
    var out = [], para = [], list = null;
    function flushPara() { if (para.length) { out.push('<p>' + inlineMd(esc(para.join(' '))) + '</p>'); para = []; } }
    function flushList() { if (list) { out.push('<' + list.type + '>' + list.items.join('') + '</' + list.type + '>'); list = null; } }
    function isTableSep(s) { var tt = s.replace(/\s/g, ''); return /^\|?:?-+:?(\|:?-+:?)+\|?$/.test(tt); }
    function splitRow(s) { return s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); }); }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var cb = ln.match(/^\x00CB(\d+)\x00$/);
      if (cb) { flushPara(); flushList(); out.push(codeBlocks[Number(cb[1])]); continue; }
      if (/^\s*$/.test(ln)) { flushPara(); flushList(); continue; }
      var h = ln.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flushPara(); flushList(); var lvl = Math.min(h[1].length, 4); out.push('<h' + lvl + '>' + inlineMd(esc(h[2])) + '</h' + lvl + '>'); continue; }
      if (/^---+$/.test(ln.trim())) { flushPara(); flushList(); out.push('<hr>'); continue; }
      if (ln.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {   // GFM table: header, |---| sep, rows
        flushPara(); flushList();
        var head = splitRow(ln); i++;   // consume the separator row
        var body = '';
        while (i + 1 < lines.length && lines[i + 1].indexOf('|') >= 0 && lines[i + 1].trim() !== '') {
          body += '<tr>' + splitRow(lines[++i]).map(function (c) { return '<td>' + inlineMd(esc(c)) + '</td>'; }).join('') + '</tr>';
        }
        out.push('<table><thead><tr>' + head.map(function (c) { return '<th>' + inlineMd(esc(c)) + '</th>'; }).join('') + '</tr></thead><tbody>' + body + '</tbody></table>');
        continue;
      }
      if (/^\s*>/.test(ln)) {                             // merge consecutive > lines into ONE callout
        flushPara(); flushList();
        var q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        i--;                                              // step back; the for-loop re-increments
        while (q.length && /^\s*$/.test(q[0])) q.shift();
        while (q.length && /^\s*$/.test(q[q.length - 1])) q.pop();
        if (q.length) out.push('<blockquote>' + mdToHtml(q.join('\n')) + '</blockquote>');  // inner rendered as markdown
        continue;
      }
      var ul = ln.match(/^\s*[-*]\s+(.*)$/);
      var ol = ln.match(/^\s*\d+\.\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        var type = ul ? 'ul' : 'ol';
        if (!list || list.type !== type) { flushList(); list = { type: type, items: [] }; }
        list.items.push('<li>' + inlineMd(esc((ul ? ul[1] : ol[1]))) + '</li>');
        continue;
      }
      para.push(ln.trim());
    }
    flushPara(); flushList();
    return out.join('\n');
  }

  // ---- doc modal -----------------------------------------------------------
  // Trademarks list is built from the manufacturer config (single Trittbrett entry here).
  function buildTrademarks() {
    var lang = state.lang, seen = {}, items = [];
    (state.cfg.trademarks || []).forEach(function (tm) { if (!seen[tm.n]) { seen[tm.n] = true; items.push(tm); } });
    items.sort(function (a, b) { return a.n.localeCompare(b.n); });
    var md = '# ' + t('trademarksTitle') + '\n\n' + t('trademarksIntro') + '\n\n';
    items.forEach(function (tm) { md += '- ' + tm.n + ' - ' + (tm[lang] || tm.en) + '\n'; });
    return md + '\n' + t('trademarksOutro') + '\n';
  }
  // Supported-model roster generated from the config, so the tested/untested list lives in ONE place.
  // Docs embed {{DEVICES}} or {{DEVICES:tb}}; both resolve to the single Trittbrett table here.
  function deviceRow(m, x) {
    var caps = x.caps || {};
    var status = caps.bleSpeed === false ? t('devUnsupported') : (x.tested ? t('devTested') : t('devUntested'));
    var method = caps.bleSpeed === true ? 'ble' : 'na';   // Trittbrett: ZYD = ble, legacy = na
    var unlock = method === 'ble' ? t('devDrosselBle') : t('devNA');
    var fw = t('devNo');                                  // no firmware patcher for Trittbrett
    return '| ' + status + ' | ' + unlock + ' | ' + fw + ' |';
  }
  function buildDeviceList(scopeId) {
    var m = state.cfg;
    if (scopeId && scopeId !== m.id) return '';
    var cols = [t('devHModel'), t('devHStatus'), t('devHUnlock'), t('devHFw')];
    var out = '| ' + cols.join(' | ') + ' |\n| ' + cols.map(function () { return '---'; }).join(' | ') + ' |\n';
    (m.models || []).forEach(function (x) { out += '| ' + x.label + ' ' + deviceRow(m, x) + '\n'; });
    return out;
  }
  function expandDeviceTokens(md) {
    return String(md).replace(/\{\{DEVICES(?::([a-z0-9]+))?\}\}/g, function (m, id) { return buildDeviceList(id || null); });
  }
  function openDoc(docKey) {
    state.currentDoc = docKey;
    var dlg = $('#doc');
    $('#doc-title').textContent = t('foot' + docKey.charAt(0) + docKey.slice(1).toLowerCase()) || docKey;
    var body = $('#doc-body');
    body.textContent = '';
    var loadingP = document.createElement('p'); loadingP.className = 'hint';
    loadingP.textContent = t('docLoading');
    body.appendChild(loadingP);
    if (dlg.showModal) dlg.showModal();
    if (docKey === 'TRADEMARKS') { body.innerHTML = mdToHtml(buildTrademarks()); return; }  // built from the config   // scan-ok: mdToHtml escapes
    // Root-level bilingual docs: <KEY>.md = EN, <KEY>.de.md = DE; German falls back to English.
    var de = state.lang === 'de';
    var paths = [];
    if (de) paths.push(docKey + '.de.md');
    paths.push(docKey + '.md');
    tryFetchFirst(paths).then(function (txt) { body.innerHTML = mdToHtml(expandDeviceTokens(txt || docPlaceholder(docKey))); })   // scan-ok: mdToHtml escapes
      .catch(function () { body.innerHTML = mdToHtml(expandDeviceTokens(docPlaceholder(docKey))); });   // scan-ok: mdToHtml escapes
  }
  function tryFetchFirst(paths) {
    var i = 0;
    function next() {
      if (i >= paths.length) return Promise.resolve(null);
      var p = paths[i++];
      // no-cache: docs carry no ?v= cache-buster, so always revalidate or a changed .md never refreshes
      return fetch(p, { cache: 'no-cache' }).then(function (r) {
        if (!r.ok) return next();
        // A static host may serve index.html (200) for a missing .md; reject HTML so the viewer never shows the page source.
        if ((r.headers.get('content-type') || '').toLowerCase().indexOf('html') >= 0) return next();
        return r.text().then(function (txt) { return /^\s*<(?:!doctype|html)\b/i.test(txt) ? next() : txt; });
      }).catch(function () { return next(); });
    }
    return next();
  }
  function docPlaceholder(docKey) {
    var name = state.cfg ? state.cfg.name : 'Laufbursche';
    if (docKey === 'DISCLAIMER') {
      return '# ' + t('footDisclaimer') + '\n\n' + fill(t('introDisclaimer'))
        + '\n\n' + fill(t('introWarningHtml').replace(/<\/?b>/g, '**'));
    }
    return '# ' + name + ' - ' + docKey + '\n\n_' + t('docMissing') + '_';
  }

  // ---- confirm modal (risky writes) ---------------------------------------
  function confirmRisky(actionLabel, untested) {
    return new Promise(function (resolve) {
      var dlg = $('#confirm');
      $('#confirm-body').textContent = (untested ? t('untestedScooter') + '\n\n' : '') + t('confirmBody').replace('{action}', actionLabel);
      var done = function (ok) {
        dlg.removeEventListener('close', onClose);
        $('#confirm-ok').removeEventListener('click', onOk);
        $('#confirm-cancel').removeEventListener('click', onCancel);
        $('#confirm-x').removeEventListener('click', onCancel);
        try { if (dlg.open) dlg.close(); } catch (e) {}
        resolve(ok);
      };
      var onOk = function () { done(true); };
      var onCancel = function () { done(false); };
      var onClose = function () { resolve(false); };
      $('#confirm-ok').addEventListener('click', onOk);
      $('#confirm-cancel').addEventListener('click', onCancel);
      $('#confirm-x').addEventListener('click', onCancel);
      dlg.addEventListener('close', onClose, { once: true });
      if (dlg.showModal) dlg.showModal();
    });
  }
  // Wrap any driver call; when risky, require an explicit confirm first.
  function callDriver(method, args, opts) {
    opts = opts || {};
    if (!state.driver || typeof state.driver[method] !== 'function') { log('driver method unavailable: ' + method, 'log-err'); return; }
    var run = function () {
      try {
        log(method + '(' + (args || []).join(', ') + ')', 'log-tx');
        var r = state.driver[method].apply(state.driver, args || []);
        if (r && typeof r.then === 'function') r.catch(function (e) { log(method + ' failed: ' + e.message, 'log-err'); });
      } catch (e) { log(method + ' failed: ' + e.message, 'log-err'); }
    };
    if (opts.risky) { confirmRisky(opts.actionLabel || method, opts.untested).then(function (ok) { if (ok) run(); else log('cancelled: ' + method); }); }
    else run();
  }

  // ---- model select --------------------------------------------------------
  function renderModelOptions() {
    var sel = $('#model-in');
    if (!sel) return;
    var filter = ($('#model-filter') && $('#model-filter').value) || 'all';
    sel.innerHTML = '';   // scan-ok: clears the element
    var auto = document.createElement('option');
    auto.value = ''; auto.textContent = t('modelAuto');
    sel.appendChild(auto);
    var models = (state.cfg.models || []).slice().sort(function (a, b) { return a.label.localeCompare(b.label); });
    models.forEach(function (m) {
      if (filter === 'tested' && !m.tested) return;
      if (filter === 'untested' && m.tested) return;
      var o = document.createElement('option');
      o.value = m.key;
      o.textContent = m.label + '  [' + t(m.tested ? 'testedTag' : 'untestedTag') + ']';
      sel.appendChild(o);
    });
    sel.value = state.modelKey || '';
  }
  // Resolve the model in effect: the manual override, else whatever the driver detected.
  function currentModel() {
    if (state.modelKey) return (state.cfg.models || []).filter(function (m) { return m.key === state.modelKey; })[0] || null;
    return (state.driver && state.driver.model) ? state.driver.model : null;
  }

  // ---- live tiles (show/hide + drag reorder, persisted) --------------------
  // A tile appears only once the connected driver reports a value for it (per-model, not a fixed set).
  var liveSeen = {};
  function resetLiveTiles() { liveSeen = {}; renderTiles(); }
  function tilePrefs() {
    var def = { order: TILE_DEFS.map(function (d) { return d.id; }), hidden: [] };
    var p = LS.getJSON(SK.tiles, def);
    var known = {}; TILE_DEFS.forEach(function (d) { known[d.id] = true; });
    p.order = (p.order || []).filter(function (id) { return known[id]; });
    TILE_DEFS.forEach(function (d) { if (p.order.indexOf(d.id) < 0) p.order.push(d.id); });
    p.hidden = (p.hidden || []).filter(function (id) { return known[id]; });
    return p;
  }
  function saveTilePrefs(p) { LS.setJSON(SK.tiles, p); }
  function renderTiles() {
    var grid = $('#tiles-grid');
    if (!grid) return;
    var p = tilePrefs();
    var byId = {}; TILE_DEFS.forEach(function (d) { byId[d.id] = d; });
    grid.innerHTML = '';   // scan-ok: clears the element
    var shown = 0;
    p.order.forEach(function (id) {
      if (!liveSeen[id]) return;                 // only fields the connected scooter actually reports
      var def = byId[id]; if (!def) return;
      var tile = document.createElement('div');
      tile.className = 'tile' + (p.hidden.indexOf(id) >= 0 ? ' tile-hidden' : '');
      tile.setAttribute('draggable', 'true');
      tile.setAttribute('data-tile', id);
      var hideBtn = document.createElement('button'); hideBtn.type = 'button'; hideBtn.className = 'tile-hide'; hideBtn.title = 'hide'; hideBtn.textContent = '×';
      var valEl = document.createElement('b'); valEl.id = 'tv-' + id; valEl.textContent = '-';
      var lblEl = document.createElement('small'); lblEl.textContent = t(def.labelKey);
      tile.appendChild(hideBtn); tile.appendChild(valEl); tile.appendChild(lblEl);
      grid.appendChild(tile);
      shown++;
    });
    var empty = $('#tiles-empty'); if (empty) empty.hidden = shown > 0;
    var lh = $('#live-hint'); if (lh) lh.hidden = shown === 0;   // the reorder hint only matters with tiles
    wireTileEvents();
    renderTileManager(p);
  }
  function renderTileManager(p) {
    var mgr = $('#tile-manager');
    if (!mgr) return;
    mgr.innerHTML = '';   // scan-ok: clears the element
    var byId = {}; TILE_DEFS.forEach(function (d) { byId[d.id] = d; });
    p.order.forEach(function (id) {
      if (!liveSeen[id]) return;                 // manager lists only revealed tiles
      var def = byId[id]; if (!def) return;
      var lbl = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = p.hidden.indexOf(id) < 0; cb.setAttribute('data-tile', id);
      cb.addEventListener('change', function () {
        var pref = tilePrefs();
        var idx = pref.hidden.indexOf(id);
        if (cb.checked && idx >= 0) pref.hidden.splice(idx, 1);
        else if (!cb.checked && idx < 0) pref.hidden.push(id);
        saveTilePrefs(pref); renderTiles();
      });
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(' ' + t(def.labelKey)));
      mgr.appendChild(lbl);
    });
  }
  var dragId = null;
  function wireTileEvents() {
    $$('#tiles-grid .tile-hide').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = b.parentNode.getAttribute('data-tile');
        var p = tilePrefs(); if (p.hidden.indexOf(id) < 0) p.hidden.push(id);
        saveTilePrefs(p); renderTiles();
      });
    });
    $$('#tiles-grid .tile').forEach(function (tile) {
      tile.addEventListener('dragstart', function () { dragId = tile.getAttribute('data-tile'); tile.classList.add('dragging'); });
      tile.addEventListener('dragend', function () { tile.classList.remove('dragging'); $$('#tiles-grid .tile').forEach(function (x) { x.classList.remove('drag-over'); }); });
      tile.addEventListener('dragover', function (e) { e.preventDefault(); tile.classList.add('drag-over'); });
      tile.addEventListener('dragleave', function () { tile.classList.remove('drag-over'); });
      tile.addEventListener('drop', function (e) {
        e.preventDefault();
        var targetId = tile.getAttribute('data-tile');
        if (!dragId || dragId === targetId) return;
        var p = tilePrefs();
        var from = p.order.indexOf(dragId), to = p.order.indexOf(targetId);
        if (from < 0 || to < 0) return;
        p.order.splice(from, 1); p.order.splice(to, 0, dragId);
        saveTilePrefs(p); renderTiles();
      });
    });
  }
  // Unwrap a telemetry field, localize bool/lock, append its unit; null when there is no value.
  function tileText(raw) {
    if (raw == null) return null;
    var v = (typeof raw === 'object' && 'value' in raw) ? raw.value : raw;
    if (v == null) return null;
    if (typeof v === 'boolean') return v ? t('toggleOn') : t('toggleOff');
    var s = String(v);
    if (s === 'locked') return t('lockStateLocked');
    if (s === 'unlocked') return t('lockStateUnlocked');
    if (s === 'unknown') return '-';
    if (s === 'turnOff' || s === 'turnLeft' || s === 'turnRight' || s === 'turnBoth') return t(s);
    var unit = (typeof raw === 'object' && raw.unitLabel) ? (' ' + raw.unitLabel) : '';
    return s + unit;
  }
  // The single mapping tile id -> telemetry field; used for both reveal-detection and display.
  function tileRawMap(tel) {
    return {
      speed: tel.speed, mode: tel.gearOrMode, batt: tel.batteryPct,
      lock: tel.immobilizerState,
      turn: tel.turnIndicatorState,
      volt: tel.voltage, curr: tel.current, power: tel.power,
      fw: tel.firmware, err: tel.errorCode, trip: tel.tripKm,
      total: tel.totalKm, temp: tel.motorTemp,
      cruise: tel.cruiseState, battTemp: tel.batteryTemp, cap: tel.capacity,
      disp: tel.config && tel.config.displayVersion,
    };
  }
  function updateTiles(tel) {
    if (!tel) return;
    refreshUntested();
    var raw = tileRawMap(tel);
    var appeared = false;
    Object.keys(raw).forEach(function (id) {
      if (tileText(raw[id]) != null && !liveSeen[id]) { liveSeen[id] = true; appeared = true; }
    });
    if (appeared) renderTiles();                 // a new field showed up -> (re)build the grid for it
    Object.keys(raw).forEach(function (id) {
      var el = $('#tv-' + id); if (!el) return;
      var txt = tileText(raw[id]);
      if (txt != null) el.textContent = txt;
    });
  }

  // ---- generic controls (driver.controls() -> settings / advanced / lock; NO dropdowns) ----
  function driverControls() {
    var d = state.driver;
    if (!d || typeof d.controls !== 'function') return [];
    try { var list = d.controls(); return Array.isArray(list) ? list : []; }
    catch (e) { log('controls() failed: ' + e.message, 'log-err'); return []; }
  }
  function controlsInGroup(group) {
    return driverControls().filter(function (c) { return c && c.group === group; });
  }
  function humanizeKey(key) {
    var s = String(key == null ? '' : key)
      .replace(/[_\-]+/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/\s+/g, ' ').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }
  function keyLabel(i18nKey, fallbackKey) {
    if (i18nKey) { var s = t(i18nKey); if (s != null && s !== i18nKey) return s; }
    return humanizeKey(fallbackKey);
  }
  function ctlLabel(ctl) { return keyLabel(ctl.labelKey, ctl.key); }

  // Route every control write through callDriver() so logging / redaction / confirm stay intact.
  function ctlWrite(ctl, args) {
    var opts = ctl.risky ? { risky: true, actionLabel: ctlLabel(ctl) } : {};
    callDriver('setSetting', args, opts);
  }

  // -- shared row / group scaffolding --
  function ctlRow(labelText) {
    var row = document.createElement('div');
    row.className = 'toggle-row';
    var lbl = document.createElement('span');
    lbl.className = 'toggle-label'; lbl.textContent = labelText;
    row.appendChild(lbl);
    return row;
  }
  function buttonGroup() {
    var g = document.createElement('div');
    g.className = 'toggle'; g.setAttribute('role', 'group');
    return g;
  }

  // -- per-kind builders (no dropdowns anywhere) --
  function makeToggle(ctl) { // ON / OFF two buttons -> setSetting(key, true|false)
    var row = ctlRow(ctlLabel(ctl));
    var group = buttonGroup();
    var on = document.createElement('button');
    on.type = 'button'; on.setAttribute('data-val', 'on'); on.setAttribute('aria-pressed', 'false'); on.textContent = t('toggleOn');
    var off = document.createElement('button');
    off.type = 'button'; off.setAttribute('data-val', 'off'); off.setAttribute('aria-pressed', 'false'); off.textContent = t('toggleOff');
    on.addEventListener('click', function () {
      on.setAttribute('aria-pressed', 'true'); off.setAttribute('aria-pressed', 'false');
      ctlWrite(ctl, [ctl.key, true]);
    });
    off.addEventListener('click', function () {
      on.setAttribute('aria-pressed', 'false'); off.setAttribute('aria-pressed', 'true');
      ctlWrite(ctl, [ctl.key, false]);
    });
    group.appendChild(on); group.appendChild(off);
    row.appendChild(group);
    return row;
  }
  function makeStepper(ctl) { // - [value unit] + then Apply -> setSetting(key, <number>)
    var row = ctlRow(ctlLabel(ctl));
    var min = typeof ctl.min === 'number' ? ctl.min : 0;
    var max = typeof ctl.max === 'number' ? ctl.max : 100;
    var step = typeof ctl.step === 'number' && ctl.step > 0 ? ctl.step : 1;
    var decimals = typeof ctl.decimals === 'number' ? ctl.decimals : 0;
    var unit = ctl.unit ? String(ctl.unit) : '';
    var cur = Math.min(max, Math.max(min, min));
    function clamp(v) { return Math.min(max, Math.max(min, v)); }
    function fmt() { return cur.toFixed(decimals) + (unit ? ' ' + unit : ''); }
    var wrap = document.createElement('div'); wrap.className = 'stepper';
    var group = buttonGroup();
    var dec = document.createElement('button'); dec.type = 'button'; dec.textContent = '-';
    var readout = document.createElement('span'); readout.className = 'stepper-readout';
    var inc = document.createElement('button'); inc.type = 'button'; inc.textContent = '+';
    var apply = document.createElement('button'); apply.type = 'button'; apply.className = 'primary'; apply.textContent = t('ctlApply');
    function render() { readout.textContent = fmt(); }
    dec.addEventListener('click', function () { cur = clamp(Number((cur - step).toFixed(decimals))); render(); });
    inc.addEventListener('click', function () { cur = clamp(Number((cur + step).toFixed(decimals))); render(); });
    apply.addEventListener('click', function () { ctlWrite(ctl, [ctl.key, cur]); });
    render();
    group.appendChild(dec); group.appendChild(readout); group.appendChild(inc);
    wrap.appendChild(group); wrap.appendChild(apply);
    row.appendChild(wrap);
    return row;
  }
  function makeSegmented(ctl) { // a row of buttons -> setSetting(key, option.value)
    var row = ctlRow(ctlLabel(ctl));
    var group = buttonGroup();
    (ctl.options || []).forEach(function (opt) {
      var b = document.createElement('button');
      b.type = 'button'; b.setAttribute('aria-pressed', 'false');
      b.textContent = keyLabel(opt.labelKey, opt.label != null ? opt.label : opt.value);
      b.addEventListener('click', function () {
        $$('button', group).forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
        b.setAttribute('aria-pressed', 'true');
        ctlWrite(ctl, [ctl.key, opt.value]);
      });
      group.appendChild(b);
    });
    row.appendChild(group);
    return row;
  }
  function makeText(ctl) { // single-line input + Apply -> setSetting(key, <string>)
    var row = ctlRow(ctlLabel(ctl));
    var wrap = document.createElement('div'); wrap.className = 'text-ctl';
    var input = document.createElement('input');
    input.type = 'text';
    if (typeof ctl.maxLength === 'number') input.maxLength = ctl.maxLength;
    var ph = t('ctlNamePlaceholder');
    if (ctl.placeholderKey) { var p = t(ctl.placeholderKey); if (p != null && p !== ctl.placeholderKey) ph = p; }
    input.placeholder = ph;
    var apply = document.createElement('button');
    apply.type = 'button'; apply.className = 'primary'; apply.textContent = t('ctlApply');
    apply.addEventListener('click', function () { ctlWrite(ctl, [ctl.key, input.value]); });
    wrap.appendChild(input); wrap.appendChild(apply);
    row.appendChild(wrap);
    return row;
  }
  function makeAction(ctl) { // one button -> setSetting(key) (value undefined)
    var row = ctlRow(ctlLabel(ctl));
    var b = document.createElement('button');
    b.type = 'button'; b.textContent = keyLabel(ctl.actionLabelKey, ctl.key);
    b.addEventListener('click', function () { ctlWrite(ctl, [ctl.key]); });
    row.appendChild(b);
    return row;
  }
  function makeControl(ctl) {
    switch (ctl.kind) {
      case 'toggle':    return makeToggle(ctl);
      case 'stepper':   return makeStepper(ctl);
      case 'segmented': return makeSegmented(ctl);
      case 'text':      return makeText(ctl);
      case 'action':    return makeAction(ctl);
      default:          return null; // 'lock' is rendered in the Lock section; unknown kinds ignored
    }
  }

  // Settings (group:'settings') and Advanced (group:'advanced'): content only while connected.
  function renderControlGroup(bodySel, emptySel, group) {
    var body = $(bodySel), empty = $(emptySel);
    if (!body) return;
    body.innerHTML = '';   // scan-ok: clears the element
    var ctls = state.connected ? controlsInGroup(group) : [];
    if (!ctls.length) { if (empty) empty.hidden = false; return; }
    if (empty) empty.hidden = true;
    ctls.forEach(function (c) { var row = makeControl(c); if (row) body.appendChild(row); });
  }
  function renderSettings() { renderControlGroup('#settings-body', '#settings-empty', 'settings'); }
  function renderAdvanced() { renderControlGroup('#advanced-body', '#advanced-empty', 'advanced'); }

  // Lock section: the hard-wired speed limiter stays as-is; append any group:'lock' immobilizer control
  // (kind:'lock') AFTER it as an UNLOCK / LOCK pair. Enabled only while connected (setDrosselEnabled).
  function lockControlsHost() {
    var sect = $('#sect-lock .sect-body');
    if (!sect) return null;
    var host = $('#lock-controls', sect);
    if (!host) {
      host = document.createElement('div');
      host.id = 'lock-controls'; host.className = 'lock-controls';
      sect.appendChild(host); // after the speed-limiter buttons / speed inputs / hint
    }
    return host;
  }
  function lockLabel(ctl) {
    if (ctl.labelKey) { var s = t(ctl.labelKey); if (s != null && s !== ctl.labelKey) return s; }
    return t('lockSectionImmo');
  }
  function makeLock(ctl) { // UNLOCK / LOCK -> setLock(lockKind, false|true)
    var wrap = document.createElement('div'); wrap.className = 'lock-block';
    var lbl = document.createElement('label');
    lbl.textContent = lockLabel(ctl);
    var group = document.createElement('div'); group.className = 'btns';
    var kind = ctl.lockKind || (window.LB && window.LB.LockKind ? window.LB.LockKind.Immobilizer : 'immobilizer');
    var unlock = document.createElement('button');
    unlock.type = 'button'; unlock.className = 'primary'; unlock.textContent = t('ctlUnlock');
    var lock = document.createElement('button');
    lock.type = 'button'; lock.className = 'primary'; lock.textContent = t('ctlLock');
    unlock.addEventListener('click', function () {
      var opts = ctl.risky ? { risky: true, actionLabel: lockLabel(ctl) + ' - ' + t('ctlUnlock') } : {};
      callDriver('setLock', [kind, false], opts);
    });
    lock.addEventListener('click', function () {
      var opts = ctl.risky ? { risky: true, actionLabel: lockLabel(ctl) + ' - ' + t('ctlLock') } : {};
      callDriver('setLock', [kind, true], opts);
    });
    group.appendChild(unlock); group.appendChild(lock);
    wrap.appendChild(lbl); wrap.appendChild(group);
    return wrap;
  }
  function renderLock() {
    var host = lockControlsHost();
    if (!host) return;
    host.innerHTML = '';   // scan-ok: clears the element
    controlsInGroup('lock').forEach(function (ctl) {
      if (ctl.kind === 'lock') host.appendChild(makeLock(ctl));
    });
    setDrosselEnabled(state.connected);
  }

  // ---- speed limiter (lock/unlock) ----------------------------------------
  function setDrosselEnabled(on) {
    $$('#sect-lock button, #sect-lock input').forEach(function (el) { el.disabled = !on; });
    refreshUntested();
  }
  // Red banner when the model in effect is enabled but not marked tested (from the registry flag).
  function isExperimental() {
    var m = currentModel();
    return !!(state.connected && m && m.tested === false);
  }
  function refreshUntested() {
    var exp = isExperimental();
    var un = $('#untested-warn'); if (un) { un.hidden = !exp; un.textContent = exp ? t('untestedScooter') : ''; }
  }
  function drosselOut() {
    var kmh = parseFloat($('#speed-open').value) || 0;
    // raising the top speed removes the limiter -> risky, needs an explicit confirm
    callDriver('setSpeedOpen', [kmh], { risky: true, untested: isExperimental(), actionLabel: t('drosselOut') + ' (' + kmh + ' km/h)' });
  }
  function drosselIn() {
    var kmh = parseFloat($('#speed-legal').value) || 0;
    callDriver('setSpeedLegal', [kmh]);
  }

  // ---- remembered scooters -------------------------------------------------
  function rememberedStore() { return LS.getJSON(SK.remembered, []); }
  function rememberDevice(device) {
    var store = rememberedStore();
    var found = false;
    for (var i = 0; i < store.length; i++) { if (store[i].id === device.id) { store[i].name = device.name || store[i].name; found = true; } }
    if (!found) store.push({ id: device.id, name: device.name || '(unknown)' });
    LS.setJSON(SK.remembered, store);
  }
  function renderRemembered() {
    var wrap = $('#remembered-list'), empty = $('#remembered-empty');
    if (!wrap) return;
    wrap.innerHTML = '';   // scan-ok: clears the element
    // getDevices() = Chrome/Edge only; elsewhere (Bluefy/iOS) degrade to "connect a new scooter".
    if (!(navigator.bluetooth && navigator.bluetooth.getDevices)) {
      if (empty) { empty.hidden = false; empty.textContent = t('rememberedEmpty'); }
      return;
    }
    navigator.bluetooth.getDevices().then(function (devices) {
      var shown = 0;
      wrap.innerHTML = '';   // scan-ok: clears the element
      devices.forEach(function (device) {
        var item = document.createElement('button');
        item.type = 'button'; item.className = 'scooter-item';
        item.innerHTML = '<span class="name"></span><span class="meta"></span>';   // scan-ok: static literal markup
        item.querySelector('.name').textContent = device.name || '(unknown)';
        item.querySelector('.meta').textContent = 'Trittbrett';
        item.addEventListener('click', function () { connectFlow(device); });
        wrap.appendChild(item); shown++;
      });
      if (empty) empty.hidden = shown > 0;
    }).catch(function () { if (empty) empty.hidden = false; });
  }

  // ---- Web Bluetooth connect lifecycle ------------------------------------
  function ensureDriver() {
    var DriverClass = window.DRIVERS ? window.DRIVERS[state.cfg.driver] : null;
    if (!DriverClass) { log('no driver registered for: ' + state.cfg.driver, 'log-err'); return null; }
    var drv = new DriverClass(state.cfg);
    drv.bind({ log: log, onTelemetry: updateTiles });
    drv.diag = !!state.diag;   // so startTelemetry taps extra channels when diag is on
    return drv;
  }
  function connectFlow(existingDevice) {
    if (!navigator.bluetooth) { log(t('noWebBt'), 'log-err'); return; }
    var drv = ensureDriver();
    if (!drv) return;
    state.driver = drv;
    resetLiveTiles();                            // clear any previous scooter's tiles; reveal on data
    if (state.modelKey) { try { drv.setModelOverride(state.modelKey); } catch (e) {} }
    // optional module PIN: only sent by the driver when the user filled it (AT+PWD)
    var pin = ($('#pin-in') && $('#pin-in').value || '').trim();
    try { drv.setPin(pin || null); } catch (e) {}

    setStatus('stConnecting', 'connecting');
    var pick = existingDevice
      ? Promise.resolve(existingDevice)
      : navigator.bluetooth.requestDevice(drv.requestOptions());

    pick.then(function (device) {
      state.device = device; state.deviceId = device.id;
      log('device chosen (id redacted)');
      device.addEventListener('gattserverdisconnected', onDisconnected);
      if (!state.modelKey) { try { drv.detectModel(device.name || '', null, null); } catch (e) {} }
      setStatus('stLinking', 'linking');
      return drv.connect(device).then(function () {
        state.connected = true;
        setStatus('stConnected', 'connected');
        setDrosselEnabled(true);
        renderSettings(); renderAdvanced(); renderLock();
        rememberDevice(device);
        renderRemembered();
        $('#btn-conn').textContent = t('disconnectBtn');
        var info = device.name ? t('connectedTo').replace('{name}', device.name) : '';
        $('#devinfo').textContent = info;
        log('connected', 'log-ok');
        if (state.pendingAction) { applyDeepLinkAction(state.pendingAction); state.pendingAction = null; }
      });
    }).catch(function (e) {
      setStatus('stDisconnected', 'disconnected');
      log('connect failed: ' + e.message, 'log-err');
    });
  }
  function onDisconnected() {
    state.connected = false;
    setStatus('stDisconnected', 'disconnected');
    setDrosselEnabled(false);
    renderSettings(); renderAdvanced(); renderLock();
    resetLiveTiles();
    $('#btn-conn').textContent = t('connectBtn');
    log('gatt disconnected');
  }
  function doDisconnect() {
    if (state.driver) { try { state.driver.disconnect(); } catch (e) {} }
    state.connected = false;
    setStatus('stDisconnected', 'disconnected');
    setDrosselEnabled(false);
    renderSettings(); renderAdvanced(); renderLock();
    resetLiveTiles();
    $('#btn-conn').textContent = t('connectBtn');
  }
  function toggleConnect() { if (state.connected) doDisconnect(); else connectFlow(null); }

  // Deep-link ?do= WRITE actions must mirror the on-page control 1:1: run only when that button is
  // currently enabled; a disabled/greyed control (e.g. device-dependent RAISE) refuses the shortcut
  // and logs why - no silent bypass. Triggering the real button keeps confirm + gating + logging intact.
  var DEEP_LINK_WRITE = {
    fast:   '#btn-drossel-out',   // speed RAISE (setSpeedOpen)
    unlock: '#btn-drossel-out',
    slow:   '#btn-drossel-in',    // speed LOWER (setSpeedLegal)
    lock:   '#btn-drossel-in',
  };
  function applyDeepLinkAction(action) {
    var sel = DEEP_LINK_WRITE[action];
    if (!sel) { log('shortcut ignored - unknown action: ' + action); return; }
    var btn = $(sel);
    if (!btn || btn.disabled) { log('shortcut refused - on-page control disabled/greyed: ' + action, 'log-warn'); return; }
    btn.click();   // same guarded path as a manual press
  }

  // ---- field help (log options only) --------------------------------------
  var HELP = {
    publiclog: ['publicLogTitle', 'publicLogHelpHtml'],
    diaglog: ['diagLogTitle', 'diagLogHelpHtml'],
  };
  function openHelp(key) {
    var m = HELP[key]; if (!m) return;
    $('#help-title').textContent = t(m[0]);
    $('#help-body').innerHTML = t(m[1]);   // trusted developer-authored i18n HTML   // scan-ok: trusted developer-authored *Html i18n
    var dlg = $('#help'); if (dlg && dlg.showModal) dlg.showModal();
  }

  // ---- collapsible sections (remember open/closed) -------------------------
  var SECT_DEFAULT_OPEN = { conn: true, intro: true, lock: true, settings: false, advanced: false };
  function wireSections() {
    $$('details[data-sect]').forEach(function (d) {
      var id = d.getAttribute('data-sect');
      var stored = LS.get(SK.sect(id), null);
      d.open = stored == null ? !!SECT_DEFAULT_OPEN[id] : stored === '1';
      d.addEventListener('toggle', function () { LS.set(SK.sect(id), d.open ? '1' : '0'); });
    });
  }

  // ---- boot ----------------------------------------------------------------
  function boot() {
    var theme = LS.get(SK.theme, 'dark');
    applyTheme(theme);
    var lang = LS.get(SK.lang, 'de');
    state.lang = (window.UI_I18N && window.UI_I18N[lang]) ? lang : 'de';
    document.documentElement.setAttribute('lang', state.lang);
    $$('#langs button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-lang') === state.lang)); });

    state.modelKey = LS.get(SK.model, '');
    wireSections();
    var bv = $('#build-ver'); if (bv) bv.textContent = 'Build ' + BUILD;
    applyStaticI18n(document);
    setStatus('stDisconnected', 'disconnected');
    renderModelOptions();
    renderTiles();
    renderSettings();
    renderAdvanced();
    renderLock();
    setDrosselEnabled(false);
    renderRemembered();

    if (!navigator.bluetooth) { var pn = $('#platform-note'); if (pn) { pn.textContent = t('noWebBt'); pn.hidden = false; } }

    // events
    $('#btn-theme').addEventListener('click', toggleTheme);
    $$('#langs button').forEach(function (b) { b.addEventListener('click', function () { setLang(b.getAttribute('data-lang')); }); });
    $('#model-filter').addEventListener('change', renderModelOptions);
    $('#model-in').addEventListener('change', function () {
      state.modelKey = $('#model-in').value;
      LS.set(SK.model, state.modelKey);
      renderSettings(); renderAdvanced(); renderLock();
    });
    $('#btn-conn').addEventListener('click', toggleConnect);
    $('#btn-drossel-out').addEventListener('click', drosselOut);
    $('#btn-drossel-in').addEventListener('click', drosselIn);
    $('#btn-copy-log').addEventListener('click', copyLog);
    $('#btn-clear-log').addEventListener('click', clearLog);
    $('#btn-save-log').addEventListener('click', saveLog);
    $$('.help-btn').forEach(function (b) { b.addEventListener('click', function () { openHelp(b.getAttribute('data-help')); }); });

    var pubCb = $('#public-log');
    if (pubCb) {
      state.publicLog = LS.get(SK.publicLog, '1') !== '0';   // default on (anonymized)
      pubCb.checked = state.publicLog;
      pubCb.addEventListener('change', function () {
        state.publicLog = pubCb.checked;
        LS.set(SK.publicLog, pubCb.checked ? '1' : '0');
        renderLog();
      });
    }
    var diagCb = $('#diag-log');
    if (diagCb) {
      state.diag = false;   // diagnostic raw-log defaults off each session
      diagCb.checked = false;
      diagCb.addEventListener('change', function () {
        state.diag = diagCb.checked;
        if (state.driver && state.driver.setDiag) state.driver.setDiag(state.diag);
        log(state.diag ? t('diagOn') : t('diagOff'), 'log-rx');
      });
    }

    // doc modal links (footer + intro)
    $$('[data-doc]').forEach(function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); openDoc(a.getAttribute('data-doc')); });
    });
    $('#link-disclaimer').addEventListener('click', function (e) { e.preventDefault(); openDoc('DISCLAIMER'); });
    $('#intro-disclaimer-link').addEventListener('click', function (e) { e.preventDefault(); openDoc('DISCLAIMER'); });
    // any rendered markdown link like [text](#DISCLAIMER) opens that doc modal
    document.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      var m = (a.getAttribute('href') || '').match(/^#(DISCLAIMER|LICENSE|PRIVACY|TRADEMARKS|GUIDE|README|CHANGELOG)$/i);
      if (m) { e.preventDefault(); openDoc(m[1].toUpperCase()); }
    });

    // dialog close buttons
    $('#doc-x').addEventListener('click', function () { $('#doc').close(); });
    $('#doc-close').addEventListener('click', function () { $('#doc').close(); });
    $('#help-x').addEventListener('click', function () { $('#help').close(); });
    $('#help-close').addEventListener('click', function () { $('#help').close(); });

    // deep-link ?do=<action> (kept even without the old shortcut card)
    var params = new URLSearchParams(location.search);
    var doAction = params.get('do') || (location.hash.match(/do=(\w+)/) ? RegExp.$1 : null);
    if (doAction) state.pendingAction = doAction;

    log('Laufbursche Trittbrett Tool ready - Build ' + BUILD);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
