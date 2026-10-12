// ==UserScript==
// @name         WME Évènements Routiers RRN (Bison Futé / DIR)
// @namespace    https://github.com/Romino57/wme-scripts
// @version      1.0.0
// @description  Affiche sur la carte WME les évènements routiers du réseau routier national non concédé (flux DATEX II des DIR, Bison Futé) et, pour les routes fermées, PRÉPARE des fermetures sur les segments que tu as sélectionnés, après contrôle et confirmation. Le script n'enregistre jamais : tu relis puis tu cliques toi-même sur « Enregistrer » dans WME.
// @author       Romino57
// @license      MIT
// @homepageURL  https://github.com/Romino57/wme-scripts/tree/main/wme-evenements-rrn
// @supportURL   https://github.com/Romino57/wme-scripts/issues
// @match        https://www.waze.com/*/editor*
// @match        https://www.waze.com/editor*
// @match        https://beta.waze.com/*
// @exclude      https://www.waze.com/*user/editor/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      tipi.bison-fute.gouv.fr
// @run-at       document-idle
// @downloadURL  https://update.greasyfork.org/scripts/591065/WME%20%C3%89v%C3%A8nements%20Routiers%20RRN%20%28Bison%20Fut%C3%A9%20%20DIR%29.user.js
// @updateURL    https://update.greasyfork.org/scripts/591065/WME%20%C3%89v%C3%A8nements%20Routiers%20RRN%20%28Bison%20Fut%C3%A9%20%20DIR%29.meta.js
// ==/UserScript==

/* global GM_xmlhttpRequest, unsafeWindow */

/*
 * Source : flux officiel des Directions Interdépartementales des Routes (DIR), agrégé par Bison Futé
 * (Point d'Accès National, transport.data.gouv.fr) — « Évènements routiers - Réseau routier national
 * non concédé », format DATEX II, Licence Ouverte v2 (source à citer).
 *
 * Fonctionnement : lecture seule du flux (HTTPS). Dans WME, le script PRÉPARE des fermetures (brouillons)
 * sur les segments que tu as sélectionnés, uniquement pour les évènements dont la nature est « route
 * fermée » (roadClosed), après contrôle des fermetures existantes et confirmation détaillée.
 * Il n'appelle jamais « Enregistrer » : c'est toi qui relis puis qui enregistres.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // CONFIGURATION
  // ---------------------------------------------------------------------
  const SCRIPT_NAME = 'WME Évènements Routiers RRN';
  const VERSION_SCRIPT = '1.0.0';
  const FEED_URL = 'https://tipi.bison-fute.gouv.fr/bison-fute-ouvert/publicationsDIR/Evenementiel-DIR/grt/RRN/content.xml';
  const HIGHLIGHT_LAYER = 'wme-rrn-events-highlight';
  const DONE_KEY = 'wme-rrn-events:done';
  const SETTINGS_KEY = 'wme-rrn-events:settings';

  // Natures (roadOrCarriagewayOrLaneManagementType) pour lesquelles ➕ est proposé. Tout le reste
  // (voie neutralisée, alternat, ...) n'est PAS une fermeture de route : affiché, jamais fermé.
  const CLOSABLE_NATURES = ['roadclosed'];
  const MAX_SEGMENTS = 20;            // segments sélectionnés au maximum par clic sur ➕
  const MAX_DIST_M = 400;             // chaque segment doit être à moins de ... m du point de l'évènement
  const MAX_DAYS_NO_CONFIRM = 40;     // au-delà, confirmation explicite de la durée
  const NAV_SETTLE_MS = 3000;         // délai laissé à WME pour charger la carte après 🎯
  const RECONCILE_MS = 4000;          // suivi : relecture (sans écriture) des fermetures préparées
  const RENDER_MAX = 250;
  const DESC_MAX = 200;
  const TZ_TOL_MS = 14 * 3600 * 1000; // tolérance de fuseau pour comparer des dates de fermeture
  const COMPASS_TOL_DEG = 67.5;       // écart maximal entre le sens de l'évènement et celui d'un segment
  const DONE_KEEP_DAYS = 120;

  const state = { sdk: null, rawEvents: [], items: [], busy: false, reconciling: false, done: loadDone(), settings: loadSettings() };
  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DM = () => state.sdk.DataModel;

  // ---------------------------------------------------------------------
  // Outils
  // ---------------------------------------------------------------------
  const norm = (s) => (s == null ? '' : String(s)).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const shortType = (t) => String(t || '').replace(/^[A-Za-z0-9_]+:/, '') || 'Évènement';
  const isTempId = (id) => String(id).charAt(0) === '-';

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k === 'style') node.setAttribute('style', v);
        else if (k === 'checked' || k === 'disabled' || k === 'value') node[k] = v;
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function toMeters(p, ref) {
    const k = Math.cos((ref[1] * Math.PI) / 180);
    return [(p[0] - ref[0]) * 111320 * k, (p[1] - ref[1]) * 110540];
  }
  // Point le plus proche d'une polyligne : { dist (m), idx (tronçon), bearing (° du tronçon dans le sens A→B) }
  function nearestOnPolyline(pt, coords) {
    let best = { dist: Infinity, idx: 0, bearing: 0 };
    for (let i = 0; i < coords.length - 1; i++) {
      const a = toMeters(coords[i], pt); const b = toMeters(coords[i + 1], pt);
      const dx = b[0] - a[0]; const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : (-(a[0] * dx + a[1] * dy)) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(a[0] + t * dx, a[1] + t * dy);
      if (d < best.dist) best = { dist: d, idx: i, bearing: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360 };
    }
    return best;
  }
  const angleDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtDateTimeLocal(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  const fmtFr = (d) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  // Convention de DataModel.RoadClosures.addClosure (identique à WCT, vérifiée en production) : « heure murale » du navigateur.
  const toClosureTime = (d) => d.valueOf() - d.getTimezoneOffset() * 60000;
  function closureMs(v) {
    if (typeof v === 'number') return v < 1e11 ? v * 1000 : v;
    const p = Date.parse(v);
    return Number.isFinite(p) ? p : NaN;
  }

  // ---------------------------------------------------------------------
  // Mémoire locale : fermetures constatées ENREGISTRÉES (jamais « préparé »)
  // ---------------------------------------------------------------------
  function loadDone() {
    try {
      const raw = JSON.parse(localStorage.getItem(DONE_KEY) || '{}');
      const limit = Date.now() - DONE_KEEP_DAYS * 86400000;
      return new Map(Object.entries(raw).filter(([, ts]) => Number(ts) > limit));
    } catch (e) { return new Map(); }
  }
  function persistDone() {
    try { localStorage.setItem(DONE_KEY, JSON.stringify(Object.fromEntries(state.done))); } catch (e) { /* ignore */ }
  }
  function loadSettings() {
    try { const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); return { closableOnly: s.closableOnly !== false }; } catch (e) { return { closableOnly: true }; }
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------
  // Style (scopé sous #rr-panel)
  // ---------------------------------------------------------------------
  function injecterStyles() {
    if (document.getElementById('rr-styles')) return;
    const style = document.createElement('style');
    style.id = 'rr-styles';
    style.textContent = `
#rr-panel { --rr-border:#e2e8f0; --rr-bg-subtle:#f8fafc; --rr-text:#1e293b; --rr-muted:#64748b; --rr-accent:#e65100; --rr-radius:12px; --rr-radius-sm:8px;
    padding:8px; font-family:system-ui,-apple-system,'Segoe UI',sans-serif; color:var(--rr-text); font-size:12px; box-sizing:border-box; }
#rr-panel * { box-sizing:border-box; }
#rr-header { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:12px 14px; background:var(--rr-bg-subtle); border:1px solid var(--rr-border); border-radius:var(--rr-radius); margin-bottom:12px; }
#rr-header .rr-title { font-size:14px; font-weight:800; }
#rr-header .rr-badge { font-size:10px; padding:3px 9px; border-radius:999px; background:#ffe0b2; color:#bf360c; font-weight:700; white-space:nowrap; }
.rr-card { background:#fff; border:1px solid var(--rr-border); border-radius:var(--rr-radius); margin-bottom:10px; overflow:hidden; box-shadow:0 1px 3px rgba(15,23,42,.06); }
.rr-card__head { padding:10px 14px; background:var(--rr-bg-subtle); border-bottom:1px solid var(--rr-border); font-weight:700; }
.rr-card__body { padding:12px 14px; }
.rr-steps { margin:0; padding-left:18px; line-height:1.5; }
.rr-note { background:#fff8e1; border:1px solid #f9a825; border-radius:var(--rr-radius-sm); padding:8px 10px; margin-top:8px; font-size:11px; }
.rr-sub { font-size:10px; color:var(--rr-muted); margin:4px 0; }
#rr-panel input[type=text], #rr-panel input[type=datetime-local] { padding:6px 8px; border:1px solid var(--rr-border); border-radius:var(--rr-radius-sm); font-size:11px; background:#fff; }
#rr-panel button { padding:8px; border:none; border-radius:var(--rr-radius-sm); background:var(--rr-accent); color:#fff; font-weight:700; font-size:12px; cursor:pointer; }
#rr-panel button:disabled { background:#ffcc80; cursor:not-allowed; }
#rr-panel button.rr-wide { width:100%; }
#rr-panel button.rr-mini { padding:2px 6px; font-size:12px; font-weight:400; background:#eef2f7; color:#1e293b; border-radius:6px; }
#rr-panel button.rr-mini:hover:not(:disabled) { background:#ffe0b2; }
.rr-status { min-height:16px; padding:8px 10px; border-radius:var(--rr-radius-sm); background:var(--rr-bg-subtle); border:1px solid var(--rr-border); font-weight:700; white-space:pre-line; }
.rr-status.is-ok { background:#e8f5e9; border-color:#a5d6a7; color:#1b5e20; }
.rr-status.is-warn { background:#fff8e1; border-color:#f9a825; color:#6d4c00; }
.rr-status.is-err { background:#fdecea; border-color:#f5b5ad; color:#b71c1c; }
.rr-list { max-height:360px; overflow-y:auto; border:1px solid var(--rr-border); border-radius:var(--rr-radius-sm); padding:4px; }
.rr-dir { background:#eceff1; padding:3px 5px; font-weight:700; font-size:11px; margin-top:6px; border-radius:3px; }
.rr-item { padding:5px 4px; border-bottom:1px solid #eee; }
.rr-item.is-prepared { background:#e3f2fd; }
.rr-item.is-done { opacity:.55; }
.rr-row { display:flex; align-items:center; gap:4px; }
.rr-meta { font-size:10px; color:#888; }
.rr-tag { font-size:10px; padding:1px 6px; border-radius:999px; background:#eee; color:#444; }
.rr-tag.is-closed { background:#ffcdd2; color:#b71c1c; font-weight:700; }
.rr-dates { display:grid; grid-template-columns:auto 1fr; gap:2px 4px; align-items:center; margin-top:3px; font-size:10px; }
.rr-dates input { width:100%; font-size:10px; }
`;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------
  // Réseau (lecture seule, HTTPS)
  // ---------------------------------------------------------------------
  function gmFetchText(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) { reject(new Error(`HTTP ${res.status}`)); return; }
          resolve(res.responseText);
        },
        onerror: () => reject(new Error(`Erreur réseau vers ${url}`)),
        ontimeout: () => reject(new Error(`Timeout vers ${url}`)),
        timeout: 60000,
      });
    });
  }

  // ---------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------
  function bootstrap() {
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', bootstrap); return; }
    if (!pageWindow.SDK_INITIALIZED) { setTimeout(bootstrap, 200); return; }
    pageWindow.SDK_INITIALIZED.then(initScript);
  }

  function initScript() {
    injecterStyles();
    state.sdk = pageWindow.getWmeSdk({ scriptId: 'wme-evenements-rrn', scriptName: SCRIPT_NAME });
    state.sdk.Events.once({ eventName: 'wme-ready' }).then(() => {
      ensureLayer();
      buildUI();
    });
  }

  function ensureLayer() {
    try {
      state.sdk.Map.addLayer({
        layerName: HIGHLIGHT_LAYER,
        zIndex: 940,
        styleRules: [{ style: { pointRadius: 10, fillColor: '#e65100', fillOpacity: 0.8, strokeColor: '#bf360c', strokeWidth: 2 }, predicate: () => true }],
        styleContext: {},
      });
    } catch (e) { console.warn(`${SCRIPT_NAME}: couche indisponible`, e); }
  }

  // ---------------------------------------------------------------------
  // Interface
  // ---------------------------------------------------------------------
  async function buildUI() {
    const { tabLabel, tabPane } = await state.sdk.Sidebar.registerScriptTab();
    tabLabel.textContent = '🚧 RRN';

    // Gabarit statique : aucune valeur du flux n'y est insérée.
    tabPane.innerHTML = `
      <div id="rr-panel">
        <div id="rr-header"><span class="rr-title">🚧 Évènements Routiers RRN</span><span class="rr-badge" id="rr-version"></span></div>

        <div class="rr-card">
          <div class="rr-card__head">🧭 Comment ça marche</div>
          <div class="rr-card__body">
            <ol class="rr-steps">
              <li>Charge le flux officiel des DIR (Bison Futé).</li>
              <li>🎯 te place sur l'évènement.</li>
              <li><b>Sélectionne dans WME</b> le ou les segments concernés.</li>
              <li>➕ prépare les fermetures après contrôle et confirmation.</li>
              <li>Tu relis, puis tu cliques toi-même sur <b>Enregistrer</b>.</li>
            </ol>
            <div class="rr-note">Le script n'enregistre jamais. ➕ n'est proposé que pour les routes fermées (<i>roadClosed</i>) ; une voie neutralisée ou un alternat n'est pas une fermeture.</div>
          </div>
        </div>

        <div class="rr-card">
          <div class="rr-card__head">📥 Flux national (DIR)</div>
          <div class="rr-card__body">
            <button id="rr-load" class="rr-wide">📥 Charger le flux national</button>
            <div id="rr-status" class="rr-status" role="status" aria-live="polite" style="margin-top:8px;"></div>
            <label style="display:flex;align-items:center;gap:6px;margin-top:8px;"><input type="checkbox" id="rr-closable" /> Routes fermées uniquement (celles où ➕ est possible)</label>
            <input type="text" id="rr-search" placeholder="Filtrer par lieu/mot-clé (ex : A31, Moselle, DIR Est...)" style="width:100%;margin-top:8px;" disabled />
            <div id="rr-types" style="margin-top:8px;font-size:11px;"></div>
            <p class="rr-sub">Source : DIR / Bison Futé (Point d'Accès National), Licence Ouverte v2.</p>
          </div>
        </div>

        <div class="rr-card">
          <div class="rr-card__head">📋 Évènements</div>
          <div class="rr-card__body">
            <div style="text-align:right;margin-bottom:4px;"><a href="#" id="rr-refresh" style="font-size:10px;color:#888;">Actualiser le suivi</a></div>
            <div id="rr-list" class="rr-list"></div>
          </div>
        </div>
      </div>
    `;
    const q = (s) => tabPane.querySelector(s);
    q('#rr-version').textContent = `v${VERSION_SCRIPT}`;
    q('#rr-closable').checked = state.settings.closableOnly;
    q('#rr-load').addEventListener('click', onLoad);
    q('#rr-search').addEventListener('input', applyFilters);
    q('#rr-closable').addEventListener('change', (e) => { state.settings.closableOnly = e.target.checked; saveSettings(); applyFilters(); });
    q('#rr-list').addEventListener('click', onListClick);
    q('#rr-refresh').addEventListener('click', async (e) => {
      e.preventDefault();
      const changed = await reconcile();
      if (changed) renderList(); else setStatus('Rien de nouveau : aucune fermeture préparée à vérifier, ou sa zone n’est pas affichée à l’écran.');
    });
    setInterval(async () => {
      if (state.reconciling || state.busy) return;
      if (!state.rawEvents.some((e) => e.status === 'prepared')) return;
      if (await reconcile()) renderList();
    }, RECONCILE_MS);
  }

  function setStatus(msg, kind) {
    const node = document.querySelector('#rr-status');
    if (!node) return;
    node.textContent = msg;
    node.className = `rr-status${kind ? ` is-${kind}` : ''}`;
  }

  // ---------------------------------------------------------------------
  // Lecture DATEX II (défensive : espaces de noms ignorés)
  // ---------------------------------------------------------------------
  function firstTag(node, names) {
    for (const name of names) {
      const found = node.getElementsByTagNameNS ? node.getElementsByTagNameNS('*', name) : [];
      if (found && found.length > 0) return found[0];
    }
    return null;
  }
  const textOf = (n) => (n ? (n.textContent || '').trim() : '');
  function extractText(record, tagNames) {
    for (const name of tagNames) {
      const found = record.getElementsByTagNameNS ? record.getElementsByTagNameNS('*', name) : [];
      for (const n of found) { const t = textOf(n); if (t) return t; }
    }
    return '';
  }
  const inMetropole = (lat, lon) => lat >= 41 && lat <= 51.5 && lon >= -5.5 && lon <= 10;
  const validLatLon = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);

  function extractCoordinates(record) {
    const lat1 = firstTag(record, ['latitude']); const lon1 = firstTag(record, ['longitude']);
    if (lat1 && lon1) {
      const lat = parseFloat(textOf(lat1)); const lon = parseFloat(textOf(lon1));
      if (validLatLon(lat, lon)) return { lat, lon };
    }
    const pos = firstTag(record, ['pos']);
    if (pos) {
      const p = textOf(pos).split(/\s+/).map(parseFloat);
      if (p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
        // GML en WGS84 : ordre « lat lon ». Si ce n'est pas plausible mais que l'ordre inverse l'est, on inverse.
        if (inMetropole(p[0], p[1])) return { lat: p[0], lon: p[1] };
        if (inMetropole(p[1], p[0])) return { lat: p[1], lon: p[0] };
        if (validLatLon(p[0], p[1])) return { lat: p[0], lon: p[1] };
      }
    }
    return null;
  }

  function extractCommentsByType(record) {
    const result = {};
    for (const c of record.getElementsByTagNameNS('*', 'generalPublicComment')) {
      const type = textOf(firstTag(c, ['commentType'])) || 'autre';
      const text = textOf(firstTag(c, ['value']));
      if (!text) continue;
      (result[type] = result[type] || []).push(text);
    }
    return result;
  }

  // Sens de l'évènement : { kind: 'both' | 'compass' | 'other' | 'unknown', raw, bearing }
  const COMPASS = { north: 0, northeast: 45, east: 90, southeast: 135, south: 180, southwest: 225, west: 270, northwest: 315 };
  function parseDirection(raw) {
    const t = norm(raw).replace(/[^a-z]/g, '');
    if (!t) return { kind: 'unknown', raw: '' };
    if (/^(both|bothways|alldirections|all|bidirectional)$/.test(t)) return { kind: 'both', raw };
    const m = t.match(/^(north|south|east|west)?(north|south|east|west)?(bound)?$/);
    if (m && (m[1] || m[2])) {
      const key = (m[1] || '') + (m[2] || '');
      if (COMPASS[key] != null) return { kind: 'compass', raw, bearing: COMPASS[key] };
    }
    return { kind: 'other', raw };
  }

  async function onLoad() {
    setStatus('⏳ Téléchargement du flux national (peut être volumineux)...');
    let text;
    try { text = await gmFetchText(FEED_URL); } catch (e) { console.error(e); setStatus(`❌ Échec du téléchargement : ${e.message}`, 'err'); return; }
    setStatus(`⏳ Analyse du XML (${(text.length / 1e6).toFixed(1)} Mo)...`);
    await new Promise((r) => setTimeout(r, 30));
    let xml;
    try {
      xml = new DOMParser().parseFromString(text, 'application/xml');
      if (xml.getElementsByTagName('parsererror').length > 0) throw new Error('XML invalide');
    } catch (e) { console.error(e); setStatus(`❌ Échec de l'analyse du flux : ${e.message}`, 'err'); return; }

    const records = xml.getElementsByTagNameNS('*', 'situationRecord');
    if (records.length === 0) { setStatus("❌ 0 évènement trouvé : la structure du flux a peut-être changé.", 'err'); return; }

    const events = [];
    let skippedNoCoord = 0;
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const coords = extractCoordinates(record);
      if (!coords) { skippedNoCoord++; continue; }
      const byType = extractCommentsByType(record);
      const locationText = (byType.locationDescriptor || []).join(' — ');
      const descriptionText = (byType.description || []).join(' — ');
      const sourceIdText = extractText(record, ['sourceIdentification']);
      const dirMatch = sourceIdText.match(/DIR\s+[^/]+/i);
      const nature = extractText(record, ['roadOrCarriagewayOrLaneManagementType']);
      const dirRaw = extractText(record, ['tpegDirection', 'alertCDirectionCoded', 'directionRelative', 'affectedDirection', 'directionBound']);
      events.push({
        id: `rrn-${record.getAttribute('id') || `i${i}`}`,
        lat: coords.lat,
        lon: coords.lon,
        comment: locationText || descriptionText || '(pas de description)',
        reference: locationText ? descriptionText : '',
        severity: extractText(record, ['severity']),
        startTime: extractText(record, ['overallStartTime']),
        endTime: extractText(record, ['overallEndTime']),
        type: record.getAttribute('xsi:type') || '',
        nature,
        direction: parseDirection(dirRaw),
        dir: dirMatch ? dirMatch[0].trim() : (sourceIdText || 'DIR inconnue'),
        status: 'pending',
      });
    }
    // identifiants uniques (le flux peut répéter un id)
    const seen = new Map();
    events.forEach((ev) => { const n = (seen.get(ev.id) || 0) + 1; seen.set(ev.id, n); if (n > 1) ev.id = `${ev.id}~${n}`; });
    events.forEach((ev) => { if (state.done.has(ev.id)) ev.status = 'done'; });
    state.rawEvents = events;

    const nClosed = events.filter(isClosable).length;
    setStatus(`✅ ${events.length} évènement(s) chargé(s) (${skippedNoCoord} sans coordonnées reconnues), dont ${nClosed} route(s) fermée(s).`, 'ok');
    document.querySelector('#rr-search').disabled = false;
    buildTypeFilters();
    applyFilters();
  }

  const isClosable = (ev) => CLOSABLE_NATURES.includes(norm(ev.nature));

  function buildTypeFilters() {
    const box = document.querySelector('#rr-types');
    box.textContent = '';
    const types = Array.from(new Set(state.rawEvents.map((e) => e.type || '(inconnu)'))).sort();
    types.forEach((t) => {
      const n = state.rawEvents.filter((e) => (e.type || '(inconnu)') === t).length;
      const cb = el('input', { type: 'checkbox', class: 'rr-type-cb', checked: true });
      cb.dataset.type = t;
      cb.addEventListener('change', applyFilters);
      box.appendChild(el('label', { style: 'display:inline-flex;align-items:center;gap:3px;margin-right:8px;margin-bottom:3px;' }, cb, ` ${shortType(t)} (${n})`));
    });
  }

  function applyFilters() {
    if (!state.rawEvents.length) { renderList(); return; }
    const checked = new Set(Array.from(document.querySelectorAll('.rr-type-cb')).filter((c) => c.checked).map((c) => c.dataset.type));
    const search = norm(document.querySelector('#rr-search').value);
    let items = state.rawEvents.filter((ev) => checked.has(ev.type || '(inconnu)'));
    if (state.settings.closableOnly) items = items.filter(isClosable);
    if (search) items = items.filter((ev) => norm(ev.comment).includes(search) || norm(ev.reference).includes(search) || norm(ev.dir).includes(search));
    items.sort((a, b) => (a.dir || '').localeCompare(b.dir || '') || a.comment.localeCompare(b.comment));
    state.items = items;
    renderList();
    refreshLayer();
  }

  async function refreshLayer() {
    try {
      try { await state.sdk.Map.removeAllFeaturesFromLayer({ layerName: HIGHLIGHT_LAYER }); } catch (e) { /* ignore */ }
      await state.sdk.Map.addFeaturesToLayer({
        layerName: HIGHLIGHT_LAYER,
        features: state.items.map((ev) => ({ id: `feat-${ev.id}`, type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [ev.lon, ev.lat] } })),
      });
    } catch (e) { console.warn(`${SCRIPT_NAME}: affichage du calque impossible`, e); }
  }

  // ---------------------------------------------------------------------
  // Liste
  // ---------------------------------------------------------------------
  function mini(act, id, text, title, disabled) {
    const b = el('button', { class: 'rr-mini', title, text, disabled });
    b.dataset.act = act; b.dataset.id = id;
    return b;
  }

  function renderList() {
    const list = document.querySelector('#rr-list');
    if (!list) return;
    list.textContent = '';
    if (!state.items.length) {
      list.appendChild(el('em', { text: state.rawEvents.length ? 'Aucun évènement ne correspond aux filtres.' : 'Charge d’abord le flux national.' }));
      return;
    }
    let currentDir = null;
    state.items.slice(0, RENDER_MAX).forEach((ev) => {
      if (ev.dir !== currentDir) {
        currentDir = ev.dir;
        list.appendChild(el('div', { class: 'rr-dir', text: `📍 ${currentDir} (${state.items.filter((e) => e.dir === currentDir).length})` }));
      }
      const closable = isClosable(ev);
      const done = ev.status === 'done';
      const prepared = ev.status === 'prepared';
      const startD = ev.startTime ? new Date(ev.startTime) : null;
      const endD = ev.endTime ? new Date(ev.endTime) : null;
      const startOk = startD && !isNaN(startD.getTime());
      const endOk = endD && !isNaN(endD.getTime());

      const row = el('div', { class: `rr-item${prepared ? ' is-prepared' : ''}${done ? ' is-done' : ''}` });
      row.dataset.id = ev.id;
      row.appendChild(el('div', { class: 'rr-row' },
        el('b', { style: 'font-size:11px;', text: shortType(ev.type) }),
        el('span', { class: `rr-tag${closable ? ' is-closed' : ''}`, text: closable ? 'route fermée' : `nature : ${ev.nature || 'inconnue'}` }),
        mini('goto', ev.id, '🎯', 'Aller sur l’évènement'),
      ));
      row.lastChild.lastChild.style.marginLeft = 'auto';
      row.appendChild(el('div', { style: 'font-size:11px;', text: ev.comment }));
      if (ev.reference) row.appendChild(el('div', { class: 'rr-meta', text: `Réf. : ${ev.reference}` }));
      row.appendChild(el('div', { class: 'rr-meta', text: `Sévérité : ${ev.severity || '?'} · Sens : ${ev.direction.raw || 'non précisé'}` }));

      if (done) {
        row.appendChild(el('div', { class: 'rr-meta', style: 'color:#2e7d32;', text: '✅ Fermeture enregistrée dans WME' }));
      } else if (prepared) {
        row.appendChild(el('div', { class: 'rr-meta', style: 'color:#0d47a1;', text: '🟡 Fermeture préparée — à enregistrer dans WME' }));
        row.appendChild(el('div', { class: 'rr-row' }, mini('undo', ev.id, '↩️', 'Oublier la préparation (n’annule pas le brouillon dans WME : Ctrl+Z)')));
      } else if (!closable) {
        row.appendChild(el('div', { class: 'rr-meta', text: 'Pas une fermeture de route : ➕ indisponible.' }));
      } else if (endOk && endD.getTime() < Date.now()) {
        row.appendChild(el('div', { class: 'rr-meta', text: `Évènement terminé le ${fmtFr(endD)} : ➕ indisponible.` }));
      } else {
        const sIn = el('input', { type: 'datetime-local', class: 'rr-start', value: startOk ? fmtDateTimeLocal(startD) : '', disabled: startOk, title: startOk ? 'Début fourni par le flux officiel' : 'Absent du flux : à renseigner' });
        const eIn = el('input', { type: 'datetime-local', class: 'rr-end', value: endOk ? fmtDateTimeLocal(endD) : '', disabled: endOk, title: endOk ? 'Fin fournie par le flux officiel' : 'Absente du flux : à renseigner' });
        row.appendChild(el('div', { class: 'rr-dates' }, el('label', { text: 'Début' }), sIn, el('label', { text: 'Fin' }), eIn));
        row.appendChild(el('div', { class: 'rr-row', style: 'margin-top:3px;' }, mini('create', ev.id, '➕ Préparer la fermeture', 'Prépare la fermeture sur les segments sélectionnés dans WME (rien n’est enregistré)')));
      }
      list.appendChild(row);
    });
    if (state.items.length > RENDER_MAX) list.appendChild(el('em', { text: `… ${state.items.length - RENDER_MAX} autres : affine avec la recherche.` }));
  }

  async function onListClick(e) {
    const b = e.target.closest ? e.target.closest('button[data-act]') : null;
    if (!b) return;
    const ev = state.rawEvents.find((x) => x.id === b.dataset.id);
    if (!ev) return;
    if (b.dataset.act === 'goto') {
      ev.navAt = Date.now();
      try { await state.sdk.Map.setMapCenter({ lonLat: { lon: ev.lon, lat: ev.lat }, zoomLevel: 16 }); } catch (err) { console.warn(err); }
    } else if (b.dataset.act === 'undo') {
      ev.status = 'pending'; ev.prepared = null;
      setStatus(`↩️ Préparation oubliée pour : ${ev.comment}`);
      renderList();
    } else if (b.dataset.act === 'create') {
      const row = b.closest('.rr-item');
      await onCreateClosure(ev, row);
    }
  }

  // ---------------------------------------------------------------------
  // Fermetures : description, plan, doublons
  // ---------------------------------------------------------------------
  function buildDescription(ev) {
    const head = `${shortType(ev.type)} — ${ev.comment}`;
    let ref = ev.reference ? ` — réf. ${ev.reference}` : '';
    if (ref.length > 120) ref = `${ref.slice(0, 119)}…`;
    const room = DESC_MAX - ref.length;
    return `${head.length > room ? `${head.slice(0, Math.max(0, room - 1))}…` : head}${ref}`;
  }

  const segDirections = (seg) => {
    const out = [];
    if (seg.isTwoWay || seg.isAtoB) out.push(true);
    if (seg.isTwoWay || seg.isBtoA) out.push(false);
    return out;
  };

  async function segLabel(id) {
    try { const a = await DM().Segments.getAddress({ segmentId: id }); const n = a && a.street && a.street.name; if (n) return `${n} (#${id})`; } catch (e) { /* ignore */ }
    return `#${id}`;
  }

  // Fermetures déjà présentes qui recoupent [startMs, endMs] sur ce segment et ce sens.
  function overlapsExisting(closures, segmentId, isForward, startMs, endMs) {
    return closures.some((c) => {
      if (Number(c.segmentId) !== Number(segmentId) || c.isForward !== isForward) return false;
      const cs = closureMs(c.startDate); const ce = closureMs(c.endDate);
      if (!Number.isFinite(cs) || !Number.isFinite(ce)) return true; // dates illisibles : prudence
      return startMs - TZ_TOL_MS < ce && endMs + TZ_TOL_MS > cs;
    });
  }

  async function onCreateClosure(ev, row) {
    if (state.busy) { setStatus('⏳ Une opération est déjà en cours.', 'warn'); return; }
    state.busy = true;
    const added = [];
    try {
      // 1. Un seul brouillon à la fois
      await reconcile();
      const other = state.rawEvents.find((x) => x.status === 'prepared' && x !== ev);
      if (other) {
        renderList();
        setStatus(`⛔ Des fermetures sont déjà préparées pour « ${other.comment} » mais pas encore enregistrées.\nRelis-les puis clique sur « Enregistrer » dans WME (ou annule avec Ctrl+Z puis ↩️) avant d’en préparer d’autres.`, 'warn');
        return;
      }
      // 2. Nature
      if (!isClosable(ev)) { setStatus(`⛔ Nature « ${ev.nature || 'inconnue'} » : ce n’est pas une route fermée, rien n’est préparé.`, 'warn'); return; }

      // 3. Dates
      const startVal = row.querySelector('.rr-start').value; const endVal = row.querySelector('.rr-end').value;
      if (!startVal || !endVal) { setStatus('⛔ Renseigne le début ET la fin (le script n’en invente aucune).', 'warn'); return; }
      const startDate = ev.startTime && !isNaN(new Date(ev.startTime).getTime()) ? new Date(ev.startTime) : new Date(startVal);
      const endDate = ev.endTime && !isNaN(new Date(ev.endTime).getTime()) ? new Date(ev.endTime) : new Date(endVal);
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || endDate <= startDate) { setStatus('❌ Dates de début/fin invalides (la fin doit suivre le début).', 'err'); return; }
      if (endDate.getTime() < Date.now()) { setStatus('⛔ La fin est déjà passée : rien n’est préparé.', 'warn'); return; }
      const days = (endDate - startDate) / 86400000;
      if (days > MAX_DAYS_NO_CONFIRM && !window.confirm(`Durée de ${Math.round(days)} jours (plus de ${MAX_DAYS_NO_CONFIRM}).\nPréparer quand même cette fermeture ?`)) return;

      // 4. Sélection
      const selection = await state.sdk.Editing.getSelection();
      if (!selection || selection.objectType !== 'segment' || !selection.ids || selection.ids.length === 0) {
        setStatus('⚠️ Sélectionne d’abord le ou les segments concernés dans WME (🎯 pour t’y rendre).', 'warn');
        return;
      }
      if (selection.ids.length > MAX_SEGMENTS) { setStatus(`⛔ ${selection.ids.length} segments sélectionnés : le maximum est ${MAX_SEGMENTS} par clic.`, 'warn'); return; }
      if (Date.now() - (ev.navAt || 0) < NAV_SETTLE_MS) { setStatus('⏳ Laisse à WME quelques secondes pour charger la zone, puis clique de nouveau.', 'warn'); return; }

      // 5. Les segments doivent être près de l'évènement
      const pt = [ev.lon, ev.lat];
      const segs = [];
      for (const id of selection.ids) {
        let seg = null;
        try { seg = await DM().Segments.getById({ segmentId: id }); } catch (e) { seg = null; }
        if (!seg || !seg.geometry || !seg.geometry.coordinates) { setStatus(`❌ Segment #${id} illisible : rien n’est préparé.`, 'err'); return; }
        segs.push({ id, seg, near: nearestOnPolyline(pt, seg.geometry.coordinates) });
      }
      const far = segs.filter((s) => s.near.dist > MAX_DIST_M);
      if (far.length) {
        const names = [];
        for (const s of far.slice(0, 4)) names.push(`${await segLabel(s.id)} à ${Math.round(s.near.dist)} m`);
        setStatus(`⛔ ${far.length} segment(s) sélectionné(s) trop loin de l’évènement (maximum ${MAX_DIST_M} m) :\n- ${names.join('\n- ')}\nDésélectionne-les. Rien n’est préparé.`, 'warn');
        return;
      }

      // 6. Plan : sens à fermer, fermetures déjà présentes
      const startMs = toClosureTime(startDate); const endMs = toClosureTime(endDate);
      const existing = (await DM().RoadClosures.getAll()) || [];
      const knownIds = new Set(existing.filter((c) => selection.ids.map(Number).includes(Number(c.segmentId))).map((c) => String(c.id)));
      const ops = []; const notes = [];
      let skippedDup = 0; let needsDecision = false;
      for (const s of segs) {
        const label = await segLabel(s.id);
        let dirs = segDirections(s.seg);
        if (ev.direction.kind === 'compass') {
          dirs = dirs.filter((fwd) => angleDiff(fwd ? s.near.bearing : (s.near.bearing + 180) % 360, ev.direction.bearing) <= COMPASS_TOL_DEG);
          if (!dirs.length) { notes.push(`${label} : sens opposé à l’évènement (${ev.direction.raw}), non fermé`); continue; }
        } else if (ev.direction.kind !== 'both') needsDecision = true;
        for (const fwd of dirs) {
          if (overlapsExisting(existing, s.id, fwd, startMs, endMs)) { skippedDup++; notes.push(`${label} ${fwd ? 'A→B' : 'B→A'} : fermeture déjà présente sur la période, ignoré`); continue; }
          ops.push({ segmentId: s.id, isForward: fwd, label });
        }
      }
      if (!ops.length) { setStatus(`ℹ️ Rien à préparer.\n- ${notes.join('\n- ') || 'aucun sens à fermer'}`, 'warn'); return; }

      // 7. Confirmation détaillée
      const description = buildDescription(ev);
      const lines = ops.slice(0, 8).map((o) => `• ${o.label} ${o.isForward ? 'A→B' : 'B→A'}`);
      const msg = `Préparer ${ops.length} fermeture(s) ?\n\n${lines.join('\n')}${ops.length > 8 ? `\n… et ${ops.length - 8} autre(s)` : ''}\n\nDu ${fmtFr(startDate)}\nau ${fmtFr(endDate)}\nMotif : ${description}\n`
        + `${needsDecision ? `\n⚠️ Le flux indique un sens (« ${ev.direction.raw || 'non précisé'} ») que le script ne sait pas traduire : TOUS les sens ouverts des segments sélectionnés seront fermés.\n` : ''}`
        + `${skippedDup ? `\n${skippedDup} sens déjà fermé(s) sur la période : ignoré(s).\n` : ''}\nAucun MTE n’est associé.\nRien n’est enregistré : tu relis puis tu cliques sur « Enregistrer » dans WME.`;
      if (!window.confirm(msg)) return;

      // 8. Création des brouillons (aucun enregistrement)
      let failed = null;
      for (const o of ops) {
        try {
          const res = await DM().RoadClosures.addClosure({
            segmentId: Number(o.segmentId),
            description,
            startDate: startMs,
            endDate: endMs,
            isForward: o.isForward,
            fromNodeClosed: false,
            isPermanent: false,
            trafficEventId: null,
          });
          added.push({ segmentId: o.segmentId, isForward: o.isForward, id: res != null && typeof res !== 'object' ? String(res) : (res && res.id != null ? String(res.id) : null) });
        } catch (err) { failed = { o, err }; break; }
      }
      if (failed) {
        let undone = 0;
        for (const a of added) {
          if (a.id == null) continue;
          try { await DM().RoadClosures.deleteClosure({ closureId: a.id }); undone++; } catch (e2) { /* annulation impossible */ }
        }
        const left = added.length - undone;
        setStatus(`❌ Échec sur ${failed.o.label} (${failed.err.message}).\n${undone} brouillon(s) retiré(s)${left ? `, ${left} à annuler toi-même avec Ctrl+Z` : ''}.`, 'err');
        return;
      }

      ev.status = 'prepared';
      ev.prepared = { items: added, knownIds, preparedAt: Date.now() };
      setStatus(`🟡 ${added.length} fermeture(s) préparée(s) pour « ${ev.comment} ».\nRelis-les (sens, dates, motif) puis clique sur « Enregistrer » dans WME. Le script n’enregistre jamais.${notes.length ? `\n\nÀ noter :\n- ${notes.join('\n- ')}` : ''}`, 'ok');
    } catch (err) {
      console.error(`${SCRIPT_NAME}: échec`, err);
      setStatus(`❌ Échec : ${err.message}${added.length ? `\n${added.length} brouillon(s) déjà créé(s) : annule-les avec Ctrl+Z si besoin.` : ''}`, 'err');
    } finally {
      state.busy = false;
      renderList();
    }
  }

  // ---------------------------------------------------------------------
  // Suivi honnête : « enregistré » seulement quand les fermetures sont retrouvées avec un identifiant définitif.
  // Lecture seule, uniquement quand la zone de l'évènement est affichée.
  // ---------------------------------------------------------------------
  async function reconcile() {
    if (state.reconciling) return false;
    const prepared = state.rawEvents.filter((e) => e.status === 'prepared' && e.prepared);
    if (!prepared.length) return false;
    state.reconciling = true;
    let changed = false;
    try {
      for (const ev of prepared) {
        let b = null;
        try { const ext = state.sdk.Map.getMapExtent(); if (Array.isArray(ext) && ext.length === 4) b = ext; } catch (e) { b = null; }
        if (!b || ev.lon < b[0] || ev.lon > b[2] || ev.lat < b[1] || ev.lat > b[3]) continue; // hors écran : on ne conclut pas
        const all = (await DM().RoadClosures.getAll()) || [];
        const mine = ev.prepared.items.map((it) => all.find((c) => Number(c.segmentId) === Number(it.segmentId) && c.isForward === it.isForward && !ev.prepared.knownIds.has(String(c.id))));
        const found = mine.filter(Boolean);
        if (found.length === 0) {
          ev.status = 'pending'; ev.prepared = null; changed = true;
          setStatus(`↩️ Les fermetures préparées pour « ${ev.comment} » n’existent plus (annulées ou supprimées) : remis en attente.`, 'warn');
        } else if (found.length === mine.length && found.every((c) => !isTempId(c.id))) {
          ev.status = 'done'; ev.prepared = null; changed = true;
          state.done.set(ev.id, Date.now()); persistDone();
          setStatus(`✅ Fermetures enregistrées dans WME pour « ${ev.comment} ».`, 'ok');
        }
      }
    } catch (e) {
      console.warn(`${SCRIPT_NAME}: suivi impossible`, e);
    } finally { state.reconciling = false; }
    return changed;
  }

  bootstrap();
})();
