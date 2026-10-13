// ==UserScript==
// @name         WME Bornes de Recharge Électrique (IRVE)
// @namespace    https://github.com/Romino57/wme-scripts
// @version      2.0.0
// @description  Assistant de saisie : lit la base nationale IRVE (bornes de recharge), te guide sur la carte (🎯) et PRÉPARE une « Station de charge » à la fois, seulement s'il n'y en a pas déjà une à proximité. Le script n'enregistre jamais : tu vérifies le lieu puis tu cliques toi-même sur « Enregistrer » dans WME.
// @author       Romino57
// @license      MIT
// @homepageURL  https://github.com/Romino57/wme-scripts/tree/main/wme-bornes-recharge-irve
// @supportURL   https://github.com/Romino57/wme-scripts/issues
// @match        https://www.waze.com/*/editor*
// @match        https://www.waze.com/editor*
// @match        https://beta.waze.com/*
// @exclude      https://www.waze.com/*user/editor/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      transport.data.gouv.fr
// @run-at       document-idle
// @downloadURL  https://update.greasyfork.org/scripts/591072/WME%20Bornes%20de%20Recharge%20%C3%89lectrique%20%28IRVE%29.user.js
// @updateURL    https://update.greasyfork.org/scripts/591072/WME%20Bornes%20de%20Recharge%20%C3%89lectrique%20%28IRVE%29.meta.js
// ==/UserScript==

/* global GM_xmlhttpRequest, unsafeWindow */

/*
 * Source : base nationale consolidée IRVE (Infrastructures de Recharge pour Véhicules Électriques),
 * Point d'Accès National transport.data.gouv.fr, schéma etalab/schema-irve-statique, Licence Ouverte 2.0
 * (source citée dans la description de chaque lieu préparé). Jeu qualifié « beta » par son producteur.
 *
 * Fonctionnement : lecture seule de la base. Dans WME, le script crée à ta demande et UN SEUL à la fois
 * un lieu « Station de charge » en brouillon, après contrôle des stations déjà présentes.
 * Il n'appelle jamais « Enregistrer » : c'est toi qui vérifies puis qui enregistres.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // CONFIGURATION
  // ---------------------------------------------------------------------
  const SCRIPT_NAME = 'WME Bornes de Recharge';
  const VERSION_SCRIPT = '2.0.0';
  const IRVE_URL = 'https://transport.data.gouv.fr/resources/84013/download';
  const CATEGORY_ID = 'CHARGING_STATION';
  const TABLE_LOCK_LEVEL = 4;         // table France (Wazeopedia) : stations de charge au niveau 4
  const DUP_RADIUS_M = 50;            // une station de charge WME à moins de ... m bloque la création
  const ROAD_RADIUS_M = 300;          // preuve que la zone est chargée : une route à moins de ... m
  const ADDRESS_RADIUS_M = 120;       // rue cherchée parmi les segments à moins de ... m
  const MIN_ZOOM = 16;
  const NAV_SETTLE_MS = 3000;
  const RECONCILE_MS = 4000;
  const RENDER_MAX = 300;
  const DESC_MAX = 400;
  const HIGHLIGHT_LAYER = 'wme-bornes-highlight';
  const DONE_STATUSES_KEY = 'wme-bornes-done-statuses';
  const SETTINGS_KEY = 'wme-bornes-settings';
  const SOURCE_MENTION = 'Source : base IRVE consolidée (transport.data.gouv.fr, Licence Ouverte 2.0)';
  const FR_BOUNDS = { lonMin: -5.5, lonMax: 10, latMin: 41, latMax: 51.5 };

  // Colonnes du schéma national, cherchées par leur NOM EXACT (un changement de schéma arrête le script).
  const COLS_REQUIRED = ['id_station_itinerance', 'code_insee_commune', 'coordonneesXY'];
  const COLS_OPTIONAL = ['nom_station', 'adresse_station', 'nom_enseigne', 'nom_operateur', 'telephone_operateur',
    'nbre_pdc', 'id_pdc_itinerance', 'implantation_station', 'consolidated_commune', 'consolidated_is_lon_lat_correct'];

  const DEPARTEMENTS = [
    ['01', 'Ain'], ['02', 'Aisne'], ['03', 'Allier'], ['04', 'Alpes-de-Haute-Provence'],
    ['05', 'Hautes-Alpes'], ['06', 'Alpes-Maritimes'], ['07', 'Ardèche'], ['08', 'Ardennes'],
    ['09', 'Ariège'], ['10', 'Aube'], ['11', 'Aude'], ['12', 'Aveyron'],
    ['13', 'Bouches-du-Rhône'], ['14', 'Calvados'], ['15', 'Cantal'], ['16', 'Charente'],
    ['17', 'Charente-Maritime'], ['18', 'Cher'], ['19', 'Corrèze'], ['2A', 'Corse-du-Sud'],
    ['2B', 'Haute-Corse'], ['21', "Côte-d'Or"], ['22', "Côtes-d'Armor"], ['23', 'Creuse'],
    ['24', 'Dordogne'], ['25', 'Doubs'], ['26', 'Drôme'], ['27', 'Eure'],
    ['28', 'Eure-et-Loir'], ['29', 'Finistère'], ['30', 'Gard'], ['31', 'Haute-Garonne'],
    ['32', 'Gers'], ['33', 'Gironde'], ['34', 'Hérault'], ['35', 'Ille-et-Vilaine'],
    ['36', 'Indre'], ['37', 'Indre-et-Loire'], ['38', 'Isère'], ['39', 'Jura'],
    ['40', 'Landes'], ['41', 'Loir-et-Cher'], ['42', 'Loire'], ['43', 'Haute-Loire'],
    ['44', 'Loire-Atlantique'], ['45', 'Loiret'], ['46', 'Lot'], ['47', 'Lot-et-Garonne'],
    ['48', 'Lozère'], ['49', 'Maine-et-Loire'], ['50', 'Manche'], ['51', 'Marne'],
    ['52', 'Haute-Marne'], ['53', 'Mayenne'], ['54', 'Meurthe-et-Moselle'], ['55', 'Meuse'],
    ['56', 'Morbihan'], ['57', 'Moselle'], ['58', 'Nièvre'], ['59', 'Nord'],
    ['60', 'Oise'], ['61', 'Orne'], ['62', 'Pas-de-Calais'], ['63', 'Puy-de-Dôme'],
    ['64', 'Pyrénées-Atlantiques'], ['65', 'Hautes-Pyrénées'], ['66', 'Pyrénées-Orientales'],
    ['67', 'Bas-Rhin'], ['68', 'Haut-Rhin'], ['69', 'Rhône'], ['70', 'Haute-Saône'],
    ['71', 'Saône-et-Loire'], ['72', 'Sarthe'], ['73', 'Savoie'], ['74', 'Haute-Savoie'],
    ['75', 'Paris'], ['76', 'Seine-Maritime'], ['77', 'Seine-et-Marne'], ['78', 'Yvelines'],
    ['79', 'Deux-Sèvres'], ['80', 'Somme'], ['81', 'Tarn'], ['82', 'Tarn-et-Garonne'],
    ['83', 'Var'], ['84', 'Vaucluse'], ['85', 'Vendée'], ['86', 'Vienne'],
    ['87', 'Haute-Vienne'], ['88', 'Vosges'], ['89', 'Yonne'], ['90', 'Territoire de Belfort'],
    ['91', 'Essonne'], ['92', 'Hauts-de-Seine'], ['93', 'Seine-Saint-Denis'],
    ['94', 'Val-de-Marne'], ['95', "Val-d'Oise"],
  ];

  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  // ---------------------------------------------------------------------
  // Outils
  // ---------------------------------------------------------------------
  const norm = (s) => (s == null ? '' : String(s)).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/œ/gi, 'oe').replace(/\s+/g, ' ').trim().toLowerCase();
  const normName = (s) => norm(s).replace(/['’`\-]/g, ' ').replace(/\s+/g, ' ').trim();
  const isTempId = (id) => String(id).charAt(0) === '-';
  const inBounds = (pt, b) => pt[0] >= b[0] && pt[0] <= b[2] && pt[1] >= b[1] && pt[1] <= b[3];

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
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
  function distM(a, b) { const [x, y] = toMeters(b, a); return Math.hypot(x, y); }
  function nearestOnPolyline(pt, coords) {
    let best = Infinity;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = toMeters(coords[i], pt); const b = toMeters(coords[i + 1], pt);
      const dx = b[0] - a[0]; const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : (-(a[0] * dx + a[1] * dy)) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(a[0] + t * dx, a[1] + t * dy);
      if (d < best) best = d;
    }
    return best;
  }
  function centroidOf(geometry) {
    if (!geometry || !geometry.coordinates) return null;
    if (geometry.type === 'Point') return [geometry.coordinates[0], geometry.coordinates[1]];
    let ring = null;
    if (geometry.type === 'Polygon') ring = geometry.coordinates[0];
    else if (geometry.type === 'MultiPolygon') ring = geometry.coordinates[0] && geometry.coordinates[0][0];
    if (!ring || !ring.length) return null;
    let sx = 0; let sy = 0;
    for (const p of ring) { sx += p[0]; sy += p[1]; }
    return [sx / ring.length, sy / ring.length];
  }
  // Segments à moins de radiusM du point : [{ id, d }] triés par distance
  function segmentsNear(segs, pt, radiusM) {
    const out = [];
    const pad = radiusM / 70000;
    for (const seg of segs) {
      const c = seg && seg.geometry && seg.geometry.coordinates;
      if (!c || c.length < 2) continue;
      let w = Infinity; let s = Infinity; let e = -Infinity; let n = -Infinity;
      for (const p of c) { if (p[0] < w) w = p[0]; if (p[0] > e) e = p[0]; if (p[1] < s) s = p[1]; if (p[1] > n) n = p[1]; }
      if (pt[0] < w - pad || pt[0] > e + pad || pt[1] < s - pad || pt[1] > n + pad) continue;
      const d = nearestOnPolyline(pt, c);
      if (d <= radiusM) out.push({ id: seg.id, d });
    }
    return out.sort((a, b) => a.d - b.d);
  }

  // Téléphone au format France : « +33 3 87 12 34 56 », numéros spéciaux 08 en national « 0 800 12 34 56 ».
  // Renvoie '' si le numéro n'est pas reconnu (il n'est alors pas écrit).
  function formatPhoneFr(raw) {
    let d = String(raw || '').replace(/^tel:\s*/i, '').replace(/[^\d+]/g, '');
    if (d.startsWith('+33')) d = `0${d.slice(3)}`;
    else if (d.startsWith('0033')) d = `0${d.slice(4)}`;
    if (d.startsWith('0') && d.length === 11 && d.charAt(1) === '0') d = `0${d.slice(2)}`; // « +33 (0)3... »
    if (!/^0[1-9]\d{8}$/.test(d)) return '';
    if (d.charAt(1) === '8') return `0 ${d.slice(1, 4)} ${d.slice(4, 6)} ${d.slice(6, 8)} ${d.slice(8, 10)}`;
    return `+33 ${d.charAt(1)} ${d.slice(2, 4)} ${d.slice(4, 6)} ${d.slice(6, 8)} ${d.slice(8, 10)}`;
  }

  // ---------------------------------------------------------------------
  // Réglages et suivi (persistés)
  // ---------------------------------------------------------------------
  function loadSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      return { lock: ['none', String(TABLE_LOCK_LEVEL)].includes(raw.lock) ? raw.lock : String(TABLE_LOCK_LEVEL) };
    } catch (e) { return { lock: String(TABLE_LOCK_LEVEL) }; }
  }
  function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch (e) { /* ignore */ } }

  // Statuts mémorisés : 'created' (constaté ENREGISTRÉ dans WME) ou 'skipped' (déjà présente). 'prepared' n'est jamais mémorisé.
  function loadDoneStatuses() {
    try {
      const raw = localStorage.getItem(DONE_STATUSES_KEY);
      return new Map((raw ? Object.entries(JSON.parse(raw)) : []).filter(([, v]) => v === 'created' || v === 'skipped'));
    } catch (e) { return new Map(); }
  }
  function persistDoneStatuses() {
    try { localStorage.setItem(DONE_STATUSES_KEY, JSON.stringify(Object.fromEntries(state.doneStatuses))); } catch (e) { /* ignore */ }
  }
  function markDone(item, status) {
    item.status = status; item.venueId = null;
    state.doneStatuses.set(item.stableId, status);
    persistDoneStatuses();
  }
  function unmarkDone(item) {
    item.status = 'pending'; item.venueId = null;
    state.doneStatuses.delete(item.stableId);
    persistDoneStatuses();
  }

  const state = {
    sdk: null, national: null, rawItems: [], features: [],
    settings: loadSettings(), doneStatuses: loadDoneStatuses(),
    categoryId: '', busy: false, reconciling: false,
  };
  const DM = () => state.sdk.DataModel;

  // ---------------------------------------------------------------------
  // Style du panneau (même langage graphique que les autres scripts : cartes arrondies, badge de version)
  // ---------------------------------------------------------------------
  function injecterStyles() {
    if (document.getElementById('bo-styles')) return;
    const style = document.createElement('style');
    style.id = 'bo-styles';
    style.textContent = `
#bo-panel {
    --bo-bg: #ffffff; --bo-bg-subtle: #f8fafc; --bo-border: #e2e8f0; --bo-text: #1e293b;
    --bo-text-secondary: #64748b; --bo-accent: #2e7d32; --bo-accent-hover: #1b5e20; --bo-accent-light: #e8f5e9;
    --bo-radius: 12px; --bo-radius-sm: 8px;
    --bo-shadow: 0 1px 3px rgba(15,23,42,.06), 0 1px 2px rgba(15,23,42,.04);
    padding: 8px; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: var(--bo-text); box-sizing: border-box; font-size: 12px;
}
#bo-panel * { box-sizing: border-box; }
#bo-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 14px;
    background: var(--bo-bg-subtle); border: 1px solid var(--bo-border); border-radius: var(--bo-radius); margin-bottom: 12px; }
#bo-header .bo-title { font-size: 14px; font-weight: 800; letter-spacing: -0.01em; }
#bo-header .bo-badge { font-size: 10px; padding: 3px 9px; border-radius: 999px; background: var(--bo-accent-light); color: var(--bo-accent); font-weight: 700; white-space: nowrap; }
.bo-card { background: var(--bo-bg); border: 1px solid var(--bo-border); border-radius: var(--bo-radius); margin-bottom: 10px; box-shadow: var(--bo-shadow); overflow: hidden; }
.bo-card__head { display: flex; align-items: center; gap: 6px; padding: 10px 14px; background: var(--bo-bg-subtle); border-bottom: 1px solid var(--bo-border); font-size: 12px; font-weight: 700; }
.bo-card__body { padding: 12px 14px; }
.bo-label { display: block; font-size: 11px; font-weight: 700; color: var(--bo-text-secondary); text-transform: uppercase; letter-spacing: .03em; margin: 10px 0 4px; }
.bo-label:first-child { margin-top: 0; }
.bo-sub { font-size: 10px; color: var(--bo-text-secondary); margin: 4px 0; }
.bo-steps { margin: 0; padding-left: 18px; line-height: 1.5; }
.bo-note { background: #fff8e1; border: 1px solid #f9a825; border-radius: var(--bo-radius-sm); padding: 8px 10px; margin-top: 8px; font-size: 11px; }
#bo-panel select, #bo-panel input[type=text] { width: 100%; padding: 7px 10px; border-radius: var(--bo-radius-sm); border: 1px solid var(--bo-border); font-size: 12px; background: #fff; }
.bo-value-box { padding: 6px 10px; background: var(--bo-bg-subtle); border: 1px solid var(--bo-border); border-radius: var(--bo-radius-sm); font-weight: 700; }
#bo-panel button { width: 100%; padding: 9px; border: none; border-radius: var(--bo-radius-sm); background: var(--bo-accent); color: #fff; font-weight: 700; font-size: 12px; cursor: pointer; transition: background .15s; }
#bo-panel button:disabled { background: #a5d6a7; cursor: not-allowed; }
#bo-panel button:hover:not(:disabled) { background: var(--bo-accent-hover); }
.bo-status { font-size: 12px; font-weight: 700; min-height: 16px; white-space: pre-line; padding: 8px 10px; border-radius: var(--bo-radius-sm); background: var(--bo-bg-subtle); border: 1px solid var(--bo-border); }
.bo-status.is-ok { background: #e8f5e9; border-color: #a5d6a7; color: #1b5e20; }
.bo-status.is-warn { background: #fff8e1; border-color: #f9a825; color: #6d4c00; }
.bo-status.is-err { background: #fdecea; border-color: #f5b5ad; color: #b71c1c; }
.bo-bar-track { background: #eee; border-radius: 999px; height: 8px; overflow: hidden; margin-top: 4px; }
.bo-bar-fill { height: 100%; border-radius: 999px; transition: width .3s ease, background .3s ease; }
.bo-progress-row { display: flex; justify-content: space-between; align-items: center; font-size: 11px; font-weight: 700; }
.bo-progress-pct { color: var(--bo-text-secondary); }
.bo-pending-note { font-size: 11px; color: #6d4c00; margin-top: 6px; }
.bo-error-note { font-size: 11px; color: #b91c1c; margin-top: 6px; }
.bo-link { font-size: 10px; color: #888; white-space: nowrap; text-decoration: none; }
.bo-link:hover { text-decoration: underline; }
.bo-list { max-height: 320px; overflow-y: auto; border: 1px solid var(--bo-border); border-radius: var(--bo-radius-sm); padding: 4px; }
.bo-item { display: flex; align-items: center; gap: 4px; padding: 6px 8px; border: 1px solid var(--bo-border); border-radius: var(--bo-radius-sm); margin-bottom: 4px; background: var(--bo-bg); }
.bo-item:hover { background: var(--bo-bg-subtle); }
.bo-item.is-done { opacity: .55; }
.bo-item.is-prepared { background: #e3f2fd; border-color: #64b5f6; }
.bo-item.is-error { background: #fdecea; border-color: #f5b5ad; }
.bo-item-name { flex: 1; font-size: 12px; }
.bo-item-name.is-strike { text-decoration: line-through; }
.bo-item small { color: var(--bo-text-secondary); }
#bo-panel button.bo-item-btn { width: auto; padding: 2px 6px; border-radius: 6px; font-size: 12px; font-weight: 400; background: #eef2f7; color: #1e293b; }
#bo-panel button.bo-item-btn:hover:not(:disabled) { background: #c8e6c9; }
.bo-nav-row { display: flex; gap: 8px; margin-top: 6px; }
.bo-cands { margin-top: 8px; border: 1px solid #f9a825; background: #fffdf5; border-radius: var(--bo-radius-sm); padding: 8px 10px; }
.bo-cands__title { font-weight: 700; margin-bottom: 6px; }
.bo-cand { display: flex; align-items: center; gap: 6px; padding: 4px 0; border-top: 1px dashed #f0d58a; }
.bo-cand span { flex: 1; }
.bo-cands__actions { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
`;
    document.head.appendChild(style);
  }

  function couleurAvancement(p) {
    if (p >= 100) return '#1a9850';
    if (p >= 75) return '#66bd63';
    if (p >= 50) return '#fee08b';
    if (p >= 25) return '#fdae61';
    if (p > 0) return '#f46d43';
    return '#d9d9d9';
  }
  function barreProgression(pourcentage) {
    const pct = Math.max(0, Math.min(100, Number(pourcentage) || 0));
    const fill = el('div', { class: 'bo-bar-fill' });
    fill.style.width = `${pct}%`;
    fill.style.background = couleurAvancement(pct);
    return el('div', { class: 'bo-bar-track' }, fill);
  }

  // ---------------------------------------------------------------------
  // Réseau + CSV (lecture seule)
  // ---------------------------------------------------------------------
  function gmFetchText(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url,
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) { reject(new Error(`HTTP ${res.status}`)); return; }
          resolve(res.responseText);
        },
        onerror: () => reject(new Error(`Erreur réseau vers ${url}`)),
        ontimeout: () => reject(new Error(`Timeout vers ${url}`)),
        timeout: 180000,
      });
    });
  }

  // Analyseur CSV qui gère les champs entre guillemets, y compris sur plusieurs lignes.
  // Ne garde que les colonnes utiles (tableaux compacts), et rend la main au navigateur régulièrement.
  async function parseCsvCompact(text, onProgress) {
    const n = text.length;
    const firstNl = text.indexOf('\n');
    const firstLine = text.slice(0, firstNl === -1 ? n : firstNl);
    const D = (firstLine.split(',').length >= firstLine.split(';').length) ? 44 : 59; // ',' ou ';'
    let i = text.charCodeAt(0) === 0xFEFF ? 1 : 0;

    function nextRecord() {
      if (i >= n) return null;
      const fields = [];
      let field = '';
      let inQ = false;
      while (i < n) {
        const c = text.charCodeAt(i);
        if (inQ) {
          if (c === 34) {
            if (text.charCodeAt(i + 1) === 34) { field += '"'; i += 2; continue; }
            inQ = false; i++; continue;
          }
          let j = text.indexOf('"', i);
          if (j === -1) j = n;
          field += text.slice(i, j); i = j; continue;
        }
        if (c === 34) { inQ = true; i++; continue; }
        if (c === D) { fields.push(field); field = ''; i++; continue; }
        if (c === 10 || c === 13) {
          i++; if (c === 13 && text.charCodeAt(i) === 10) i++;
          fields.push(field); return fields;
        }
        let j = i;
        while (j < n) { const k = text.charCodeAt(j); if (k === D || k === 34 || k === 10 || k === 13) break; j++; }
        field += text.slice(i, j); i = j;
      }
      fields.push(field);
      return fields;
    }

    const header = (nextRecord() || []).map((h) => h.trim());
    const missing = COLS_REQUIRED.filter((c) => !header.includes(c));
    if (missing.length) throw new Error(`Le format de la base a changé : colonne(s) introuvable(s) ${missing.join(', ')}. Rien n'est proposé tant que le script n'est pas mis à jour.`);
    const cols = [...COLS_REQUIRED, ...COLS_OPTIONAL].filter((c) => header.includes(c));
    const idx = cols.map((c) => header.indexOf(c));
    const rows = [];
    let count = 0;
    let rec;
    while ((rec = nextRecord()) !== null) {
      if (rec.length === 1 && rec[0] === '') continue;
      rows.push(idx.map((k) => (rec[k] !== undefined ? rec[k].trim() : '')));
      if (++count % 20000 === 0) { if (onProgress) onProgress(i / n); await new Promise((r) => setTimeout(r, 0)); }
    }
    return { cols, rows };
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
    state.sdk = pageWindow.getWmeSdk({ scriptId: 'wme-bornes-recharge', scriptName: SCRIPT_NAME });
    state.sdk.Events.once({ eventName: 'wme-ready' }).then(() => { ensureHighlightLayer(); buildUI(); });
  }

  function ensureHighlightLayer() {
    try {
      state.sdk.Map.addLayer({
        layerName: HIGHLIGHT_LAYER, zIndex: 950,
        styleRules: [{ style: { pointRadius: 12, fillColor: '#43a047', fillOpacity: 0.5, strokeColor: '#1b5e20', strokeWidth: 3 }, predicate: () => true }],
        styleContext: {},
      });
    } catch (e) { console.warn(`${SCRIPT_NAME}: couche de surbrillance indisponible`, e); }
  }

  // ---------------------------------------------------------------------
  // Interface
  // ---------------------------------------------------------------------
  async function buildUI() {
    const { tabLabel, tabPane } = await state.sdk.Sidebar.registerScriptTab();
    tabLabel.textContent = '🔌 Bornes';

    // Gabarit statique : aucune donnée de la base n'y est insérée (tout le reste est construit en DOM).
    tabPane.innerHTML = `
      <div id="bo-panel">
        <div id="bo-header">
          <span class="bo-title">🔌 Bornes de Recharge (IRVE)</span>
          <span class="bo-badge" id="bo-version"></span>
        </div>

        <div class="bo-card">
          <div class="bo-card__head">🧭 Une station à la fois</div>
          <div class="bo-card__body">
            <ol class="bo-steps">
              <li>🎯 te place sur la station de la base IRVE.</li>
              <li>➕ prépare le lieu « Station de charge » (brouillon), seulement si aucune station n'existe déjà à moins de ${DUP_RADIUS_M} m.</li>
              <li>Tu <b>vérifies</b> le lieu (position, nom, adresse, téléphone).</li>
              <li>Tu cliques toi-même sur <b>Enregistrer</b> dans WME.</li>
            </ol>
            <div class="bo-note">Le script n'enregistre jamais et ne supprime rien. Tant qu'une station préparée n'est pas enregistrée, il n'en prépare pas une autre. Les stations de charge sont surtout ajoutées par le staff : vérifie bien l'existant.</div>
          </div>
        </div>

        <div class="bo-card">
          <div class="bo-card__head">⬇️ Base nationale IRVE</div>
          <div class="bo-card__body">
            <button id="bo-load-national">⬇️ Charger la base nationale (volumineuse, une fois par session)</button>
            <p id="bo-national-status" class="bo-sub"></p>
            <p class="bo-sub">Point d'Accès National (transport.data.gouv.fr), Licence Ouverte 2.0. Jeu « beta » : vérifie chaque station.</p>
          </div>
        </div>

        <div class="bo-card">
          <div class="bo-card__head">🗺️ Zone de travail</div>
          <div class="bo-card__body">
            <label class="bo-label" for="bo-dept">Département</label>
            <select id="bo-dept"></select>
            <button id="bo-fetch" style="margin-top:8px;" disabled>🔎 Lister les stations du département</button>
            <label class="bo-label" for="bo-commune">Commune</label>
            <select id="bo-commune"><option value="">Liste d'abord un département</option></select>
            <div class="bo-nav-row">
              <button id="bo-commune-precedente" disabled>◀ Précédente</button>
              <button id="bo-commune-suivante" disabled>Suivante ▶</button>
            </div>
            <label class="bo-label" for="bo-search">Recherche</label>
            <input type="text" id="bo-search" placeholder="Filtrer par nom, opérateur ou adresse...">
          </div>
        </div>

        <div class="bo-card">
          <div class="bo-card__head">🏷️ Catégorie & verrou</div>
          <div class="bo-card__body">
            <label class="bo-label">Catégorie de Place Waze (détectée automatiquement)</label>
            <div id="bo-category-display" class="bo-value-box">(détection en cours...)</div>
            <label class="bo-label" for="bo-lock">Verrou posé sur la station préparée</label>
            <select id="bo-lock">
              <option value="${TABLE_LOCK_LEVEL}">Niveau ${TABLE_LOCK_LEVEL} (table France)</option>
              <option value="none">Aucun (je verrouille moi-même)</option>
            </select>
            <p class="bo-sub">Jamais au-dessus de ton propre rang : un éditeur de rang inférieur obtient son propre niveau, et le script le signale.</p>
          </div>
        </div>

        <div class="bo-card">
          <div class="bo-card__head">📋 Stations</div>
          <div class="bo-card__body">
            <div id="bo-status" class="bo-status" role="status" aria-live="polite"></div>
            <div id="bo-cands" class="bo-cands" hidden></div>
            <div id="bo-progress-bloc" style="margin:8px 0;"></div>
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;gap:8px;">
              <label style="font-size:11px;font-weight:normal;display:flex;align-items:center;gap:4px;">
                <input type="checkbox" id="bo-hide-done" style="width:auto;" /> Masquer les stations traitées
              </label>
              <span><a href="#" id="bo-refresh" class="bo-link">Actualiser le suivi</a> · <a href="#" id="bo-reset-memory" class="bo-link">Réinitialiser la mémoire</a></span>
            </div>
            <div id="bo-list" class="bo-list"></div>
          </div>
        </div>
      </div>
    `;

    const q = (s) => tabPane.querySelector(s);
    q('#bo-version').textContent = `v${VERSION_SCRIPT}`;
    DEPARTEMENTS.forEach(([code, nom]) => q('#bo-dept').appendChild(el('option', { value: code, text: `${code} - ${nom}` })));
    q('#bo-lock').value = state.settings.lock;
    q('#bo-lock').addEventListener('change', (e) => { state.settings.lock = e.target.value; saveSettings(); });
    q('#bo-load-national').addEventListener('click', onLoadNational);
    q('#bo-fetch').addEventListener('click', onFilterDept);
    q('#bo-hide-done').addEventListener('change', renderList);
    q('#bo-commune').addEventListener('change', () => { applyFilters(); centerOnCommune(q('#bo-commune').value); });
    q('#bo-commune-precedente').addEventListener('click', () => allerVersCommune(-1));
    q('#bo-commune-suivante').addEventListener('click', () => allerVersCommune(1));
    q('#bo-search').addEventListener('input', applyFilters);
    q('#bo-list').addEventListener('click', onListClick);
    q('#bo-refresh').addEventListener('click', async (e) => {
      e.preventDefault();
      if (await reconcile()) renderList();
      else setStatus('Rien de nouveau : aucune station préparée à vérifier, ou sa zone n’est pas affichée et chargée à l’écran.');
    });
    q('#bo-reset-memory').addEventListener('click', (e) => {
      e.preventDefault();
      if (!window.confirm('Oublier la liste des stations déjà traitées (créées ou marquées "déjà présente"), mémorisée sur cet ordinateur ?\nCela ne supprime aucun lieu dans WME, ça remet juste le suivi à zéro.')) return;
      state.doneStatuses = new Map();
      persistDoneStatuses();
      state.rawItems.forEach((f) => { if (f.status === 'created' || f.status === 'skipped') f.status = 'pending'; });
      renderList();
      setStatus('Mémoire des stations traitées réinitialisée.');
    });

    loadVenueCategory();
    setInterval(async () => {
      if (state.reconciling || state.busy) return;
      if (!state.rawItems.some((i) => i.status === 'prepared')) return;
      if (await reconcile()) renderList();
    }, RECONCILE_MS);
  }

  function setStatus(msg, kind) {
    const node = document.querySelector('#bo-status');
    if (!node) return;
    node.textContent = msg;
    node.className = `bo-status${kind ? ` is-${kind}` : ''}`;
  }

  async function loadVenueCategory() {
    const display = document.querySelector('#bo-category-display');
    let subCats = [];
    try { subCats = (await DM().Venues.getVenueSubCategories()) || []; } catch (e) { console.warn(`${SCRIPT_NAME}: getVenueSubCategories a échoué`, e); }
    const cats = (Array.isArray(subCats) ? subCats : []).map((c) => ({ id: c.subCategoryId || c.id || c.value, label: c.localizedName || c.name || c.label || c.subCategoryId }));
    const chosen = cats.find((c) => c.id === CATEGORY_ID) || cats.find((c) => /charg/i.test(c.id || '') || /recharge|borne/.test(norm(c.label))) || null;
    state.categoryId = chosen ? chosen.id : '';
    if (display) display.textContent = chosen ? `${chosen.label} (id: ${chosen.id})` : '⚠️ Aucune catégorie « Station de charge » détectée';
    if (!chosen) setStatus('⚠️ Catégorie « Station de charge » introuvable : la préparation de lieux est désactivée.', 'warn');
  }

  // ---------------------------------------------------------------------
  // Chargement national + filtrage département
  // ---------------------------------------------------------------------
  async function onLoadNational() {
    const statusEl = document.querySelector('#bo-national-status');
    const btn = document.querySelector('#bo-load-national');
    btn.disabled = true;
    statusEl.textContent = '⏳ Téléchargement en cours (fichier national, peut prendre un moment)...';
    try {
      const text = await gmFetchText(IRVE_URL);
      statusEl.textContent = '⏳ Analyse du fichier...';
      const parsed = await parseCsvCompact(text, (p) => { statusEl.textContent = `⏳ Analyse du fichier... ${Math.round(p * 100)} %`; });
      state.national = parsed;
      statusEl.textContent = `✅ ${parsed.rows.length.toLocaleString('fr-FR')} point(s) de charge chargé(s). Choisis un département puis « Lister ».`;
      document.querySelector('#bo-fetch').disabled = false;
    } catch (e) {
      console.error(e);
      statusEl.textContent = `❌ ${e.message}`;
    } finally {
      btn.disabled = false;
    }
  }

  function extractLonLat(raw) {
    const parts = String(raw || '').replace(/[[\]\s]/g, '').split(',').map(Number);
    if (parts.length !== 2 || !parts.every(Number.isFinite)) return null;
    const [lon, lat] = parts;
    if (lon < FR_BOUNDS.lonMin || lon > FR_BOUNDS.lonMax || lat < FR_BOUNDS.latMin || lat > FR_BOUNDS.latMax) return null;
    return { lon, lat };
  }

  function onFilterDept() {
    if (!state.national) { setStatus('⚠️ Charge d’abord la base nationale.', 'warn'); return; }
    const dept = document.querySelector('#bo-dept').value.toUpperCase();
    const { cols, rows } = state.national;
    const c = (name) => cols.indexOf(name);
    const iId = c('id_station_itinerance'); const iInsee = c('code_insee_commune'); const iXY = c('coordonneesXY');
    const iName = c('nom_station'); const iAddr = c('adresse_station'); const iEns = c('nom_enseigne'); const iOp = c('nom_operateur');
    const iTel = c('telephone_operateur'); const iNb = c('nbre_pdc'); const iPdc = c('id_pdc_itinerance');
    const iCommune = c('consolidated_commune'); const iOk = c('consolidated_is_lon_lat_correct');
    const get = (row, k) => (k >= 0 ? row[k] : '');

    const byStation = new Map();
    let pdcCount = 0; let skippedNoCoord = 0; let skippedDoubtful = 0;
    for (const row of rows) {
      if (!get(row, iInsee).toUpperCase().startsWith(dept)) continue;
      pdcCount++;
      if (iOk >= 0 && /^(false|faux|0)$/i.test(get(row, iOk))) { skippedDoubtful++; continue; } // coordonnées signalées douteuses par la source
      const coords = extractLonLat(get(row, iXY));
      if (!coords) { skippedNoCoord++; continue; }
      const stationId = get(row, iId);
      // Sans identifiant, on ne fusionne que des points identiques ET de même adresse.
      const key = stationId || `geo-${coords.lon.toFixed(5)}-${coords.lat.toFixed(5)}-${normName(get(row, iAddr))}`;
      if (!byStation.has(key)) {
        const operateur = get(row, iOp); const enseigne = get(row, iEns);
        byStation.set(key, {
          stableId: key,
          operateur, enseigne,
          nomStation: get(row, iName),
          adresse: get(row, iAddr),
          commune: get(row, iCommune),
          phoneRaw: get(row, iTel),
          nbreDeclare: parseInt(get(row, iNb), 10) || 0,
          center: coords,
          pdc: new Set(),
        });
      }
      const st = byStation.get(key);
      const pdc = get(row, iPdc);
      if (pdc) st.pdc.add(pdc);
    }

    const items = Array.from(byStation.values()).map((st, n) => {
      const reseau = st.operateur || st.enseigne;
      return {
        id: `bo-${n}`,
        stableId: st.stableId,
        name: reseau ? `Station de charge ${reseau}` : 'Station de charge',
        operateur: st.operateur, enseigne: st.enseigne, nomStation: st.nomStation,
        adresse: st.adresse, commune: st.commune,
        phone: formatPhoneFr(st.phoneRaw), phoneRaw: st.phoneRaw,
        nbPdc: st.pdc.size || st.nbreDeclare || 1,
        center: st.center,
        geometry: { type: 'Point', coordinates: [st.center.lon, st.center.lat] },
        status: state.doneStatuses.get(st.stableId) || 'pending',
        venueId: null,
      };
    });
    items.sort((a, b) => (a.commune + a.name).localeCompare(b.commune + b.name, 'fr'));
    state.rawItems = items;
    buildCommuneFilter();
    const s = document.querySelector('#bo-search');
    if (s) s.value = '';
    applyFilters();

    const nCreated = items.filter((it) => it.status === 'created').length;
    const nSkipped = items.filter((it) => it.status === 'skipped').length;
    setStatus(`✅ ${items.length} station(s) (${pdcCount} point(s) de charge)`
      + (skippedDoubtful ? `\n⚠️ ${skippedDoubtful} point(s) écarté(s) : coordonnées signalées douteuses par la source.` : '')
      + (skippedNoCoord ? `\n${skippedNoCoord} point(s) sans position exploitable ignoré(s).` : '')
      + (nCreated || nSkipped ? `\n${nCreated} déjà créée(s), ${nSkipped} déjà présente(s) (mémorisé).` : ''), 'ok');
  }

  // ---------------------------------------------------------------------
  // Filtres
  // ---------------------------------------------------------------------
  function buildCommuneFilter() {
    const select = document.querySelector('#bo-commune');
    if (!select) return;
    const communes = Array.from(new Set(state.rawItems.map((it) => it.commune).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'fr'));
    select.textContent = '';
    select.appendChild(el('option', { value: '', text: `Toutes les communes (${communes.length})` }));
    communes.forEach((n) => select.appendChild(el('option', { value: n, text: n })));
    document.querySelector('#bo-commune-precedente').disabled = !communes.length;
    document.querySelector('#bo-commune-suivante').disabled = !communes.length;
  }
  function allerVersCommune(decalage) {
    const select = document.querySelector('#bo-commune');
    if (!select || select.options.length <= 1) return;
    let i = (select.selectedIndex < 0 ? 0 : select.selectedIndex) + decalage;
    if (i < 1) i = select.options.length - 1;
    if (i >= select.options.length) i = 1;
    select.selectedIndex = i;
    select.dispatchEvent(new Event('change'));
  }
  function centerOnCommune(name) {
    if (!name) return;
    const list = state.rawItems.filter((it) => it.commune === name);
    if (!list.length) return;
    const lon = list.reduce((s, it) => s + it.center.lon, 0) / list.length;
    const lat = list.reduce((s, it) => s + it.center.lat, 0) / list.length;
    try { state.sdk.Map.setMapCenter({ lonLat: { lon, lat }, zoomLevel: 15 }); } catch (e) { /* ignore */ }
  }
  function applyFilters() {
    const commune = document.querySelector('#bo-commune')?.value || '';
    const search = normName(document.querySelector('#bo-search')?.value || '');
    state.features = state.rawItems.filter((it) => {
      if (commune && it.commune !== commune) return false;
      if (search && !normName(`${it.name} ${it.enseigne} ${it.nomStation} ${it.adresse}`).includes(search)) return false;
      return true;
    });
    renderList();
  }

  // ---------------------------------------------------------------------
  // Liste
  // ---------------------------------------------------------------------
  function btn(act, id, text, title) {
    const b = el('button', { class: 'bo-item-btn', title, text });
    b.dataset.act = act; b.dataset.id = id;
    return b;
  }

  function renderList() {
    const list = document.querySelector('#bo-list');
    if (!list) return;
    list.textContent = '';
    if (!state.features.length) {
      list.appendChild(el('em', { text: state.rawItems.length ? 'Aucune station ne correspond aux filtres.' : 'Aucune donnée chargée.' }));
      updateProgress(); return;
    }
    const hideDone = document.querySelector('#bo-hide-done')?.checked;
    const visible = state.features.filter((it) => !(hideDone && (it.status === 'created' || it.status === 'skipped')));
    if (!visible.length) { list.appendChild(el('em', { text: 'Toutes les stations visibles sont déjà traitées. 🎉' })); updateProgress(); return; }
    visible.slice(0, RENDER_MAX).forEach((it) => {
      const done = it.status === 'created' || it.status === 'skipped';
      const prepared = it.status === 'prepared';
      const cls = `bo-item${prepared ? ' is-prepared' : done ? ' is-done' : it.status === 'error' ? ' is-error' : ''}`;
      const badge = it.status === 'created' ? '✅ ' : it.status === 'skipped' ? '⏭️ ' : prepared ? '🟡 ' : it.status === 'error' ? '⚠️ ' : '';
      const sub = `— ${it.nbPdc} point(s) de charge, ${it.adresse || 'adresse inconnue'}${it.commune ? `, ${it.commune}` : ''}${it.phone ? `, ☎ ${it.phone}` : ''}${prepared ? ' · à enregistrer dans WME' : ''}`;
      const row = el('div', { class: cls },
        el('span', { class: `bo-item-name${done ? ' is-strike' : ''}` }, `${badge}${it.name}`, ' ', el('small', { text: sub })),
        btn('goto', it.id, '🎯', 'Aller et surligner'));
      if (!done && !prepared) {
        row.appendChild(btn('prepare', it.id, '➕', 'Préparer cette station (brouillon, à vérifier puis enregistrer)'));
        row.appendChild(btn('skip', it.id, '⏭️', 'Marquer comme déjà présente dans WME (ne crée rien)'));
      }
      if (done || prepared) row.appendChild(btn('undo', it.id, '↩️', prepared ? 'Oublier la préparation (n’annule pas le brouillon : Ctrl+Z dans WME)' : 'Annuler ce statut'));
      list.appendChild(row);
    });
    if (visible.length > RENDER_MAX) list.appendChild(el('em', { text: `… ${visible.length - RENDER_MAX} autres : choisis une commune ou utilise la recherche.` }));
    updateProgress();
  }

  async function onListClick(e) {
    const b = e.target.closest ? e.target.closest('button[data-act]') : null;
    if (!b) return;
    const item = state.rawItems.find((f) => f.id === b.dataset.id);
    if (!item) return;
    switch (b.dataset.act) {
      case 'goto': highlightAndGoTo(item); break;
      case 'prepare': await prepareOne(item); break;
      case 'skip': markDone(item, 'skipped'); setStatus(`⏭️ Marquée comme déjà présente : ${item.name}.`); renderList(); break;
      case 'undo': unmarkDone(item); setStatus(`↩️ Statut annulé pour : ${item.name}.`); renderList(); break;
      default: break;
    }
  }

  function updateProgress() {
    const bloc = document.querySelector('#bo-progress-bloc');
    if (!bloc) return;
    bloc.textContent = '';
    const total = state.features.length;
    if (!total) return;
    const created = state.features.filter((f) => f.status === 'created').length;
    const skipped = state.features.filter((f) => f.status === 'skipped').length;
    const prepared = state.features.filter((f) => f.status === 'prepared').length;
    const errors = state.features.filter((f) => f.status === 'error').length;
    const pct = Math.round(((created + skipped) / total) * 1000) / 10;
    bloc.appendChild(el('div', { class: 'bo-progress-row' }, el('span', { text: '🔌 Stations enregistrées / déjà présentes' }), el('span', { class: 'bo-progress-pct', text: `${pct}% (${created + skipped}/${total})` })));
    bloc.appendChild(barreProgression(pct));
    if (prepared) bloc.appendChild(el('div', { class: 'bo-pending-note', text: `🟡 ${prepared} station préparée, pas encore enregistrée dans WME` }));
    if (errors) bloc.appendChild(el('div', { class: 'bo-error-note', text: `⚠️ ${errors} en erreur` }));
  }

  function highlightAndGoTo(item) {
    item.navAt = Date.now();
    try {
      try { state.sdk.Map.removeAllFeaturesFromLayer({ layerName: HIGHLIGHT_LAYER }); } catch (e) { /* ignore */ }
      state.sdk.Map.addFeaturesToLayer({ layerName: HIGHLIGHT_LAYER, features: [{ id: 'current-borne-highlight', type: 'Feature', properties: {}, geometry: item.geometry }] });
    } catch (e) { console.warn(`${SCRIPT_NAME}: surbrillance impossible`, e); }
    try { state.sdk.Map.setMapCenter({ lonLat: item.center, zoomLevel: 18 }); } catch (e) { console.warn(`${SCRIPT_NAME}: recentrage impossible`, e); }
  }

  // ---------------------------------------------------------------------
  // Zone chargée ? (condition pour contrôler l'existant)
  // ---------------------------------------------------------------------
  function readBounds() {
    try {
      const ext = state.sdk.Map.getMapExtent();
      if (Array.isArray(ext) && ext.length === 4 && ext.every(Number.isFinite) && ext[2] > ext[0] && ext[3] > ext[1]) return ext;
    } catch (e) { /* ignore */ }
    return null;
  }
  async function zoneLoaded(pt) {
    const b = readBounds();
    let zoom = null;
    try { zoom = state.sdk.Map.getZoomLevel(); } catch (e) { zoom = null; }
    if (!b || !inBounds(pt, b) || (zoom != null && zoom < MIN_ZOOM)) return 'out';
    const segs = (await DM().Segments.getAll()) || [];
    return segmentsNear(segs, pt, ROAD_RADIUS_M).length ? 'ok' : 'noroad';
  }

  async function findNearbyStations(item) {
    const all = (await DM().Venues.getAll()) || [];
    const pt = [item.center.lon, item.center.lat];
    const out = [];
    for (const v of all) {
      if (!v || v.id == null || !Array.isArray(v.categories) || !v.categories.includes(CATEGORY_ID)) continue;
      const c = centroidOf(v.geometry);
      if (!c) continue;
      const d = distM(pt, c);
      if (d <= DUP_RADIUS_M) out.push({ id: String(v.id), name: v.name || '(sans nom)', dist: d, center: c, draft: isTempId(v.id) });
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  function hideCandidates() {
    const box = document.querySelector('#bo-cands');
    if (box) { box.hidden = true; box.textContent = ''; }
  }
  function showCandidates(item, dups) {
    const box = document.querySelector('#bo-cands');
    if (!box) return;
    box.textContent = ''; box.hidden = false;
    box.appendChild(el('div', { class: 'bo-cands__title', text: `⚠️ ${dups.length} station(s) de charge déjà dans WME à moins de ${DUP_RADIUS_M} m de « ${item.name} ». Rien n'a été créé.` }));
    dups.slice(0, 6).forEach((d) => {
      const go = el('button', { class: 'bo-item-btn', title: 'Aller voir ce lieu', text: '🎯' });
      go.addEventListener('click', () => { try { state.sdk.Map.setMapCenter({ lonLat: { lon: d.center[0], lat: d.center[1] }, zoomLevel: 19 }); } catch (e) { /* ignore */ } });
      box.appendChild(el('div', { class: 'bo-cand' }, el('span', { text: `${d.draft ? '✏️ (brouillon) ' : ''}${d.name} — ${Math.round(d.dist)} m` }), go));
    });
    const same = el('button', { text: '⏭️ C’est la même : marquer comme déjà présente' });
    same.addEventListener('click', () => { markDone(item, 'skipped'); hideCandidates(); setStatus(`⏭️ Marquée comme déjà présente : ${item.name}.`); renderList(); });
    const anyway = el('button', { style: 'background:#6b7280;', text: '➕ C’est une autre station : créer quand même' });
    anyway.addEventListener('click', () => { item.forceDup = true; hideCandidates(); prepareOne(item); });
    const close = el('button', { style: 'background:#9ca3af;', text: 'Fermer' });
    close.addEventListener('click', hideCandidates);
    box.appendChild(el('div', { class: 'bo-cands__actions' }, same, anyway, close));
    setStatus('⚠️ Station possiblement déjà présente : choisis dans l’encadré ci-dessous.', 'warn');
  }

  // ---------------------------------------------------------------------
  // Écriture d'UNE station (brouillon) — jamais d'enregistrement
  // ---------------------------------------------------------------------
  function extractVenueId(venue) {
    if (venue === null || venue === undefined) return null;
    if (typeof venue === 'number' || typeof venue === 'string') return String(venue);
    if (typeof venue === 'object' && venue.id !== undefined) return String(venue.id);
    return null;
  }

  function parseAddressText(text) {
    const t = String(text || '').trim();
    const m = t.match(/^(\d+\s*(?:bis|ter|quater)?)[\s,]+(.+)$/i);
    if (m) return { houseNumber: m[1].replace(/\s+/g, ''), streetName: m[2].replace(/\s+\d{5}\s+.*$/, '').trim() };
    return { houseNumber: '', streetName: t.replace(/\s+\d{5}\s+.*$/, '').trim() };
  }

  // Rue lue sur les segments voisins de la bonne commune ; jamais créée par le script.
  async function findStreetId(item) {
    const { streetName } = parseAddressText(item.adresse);
    if (!streetName || !item.commune) return null;
    const segs = (await DM().Segments.getAll()) || [];
    for (const s of segmentsNear(segs, [item.center.lon, item.center.lat], ADDRESS_RADIUS_M).slice(0, 30)) {
      let a = null;
      try { a = await DM().Segments.getAddress({ segmentId: s.id }); } catch (e) { a = null; }
      if (!a || !a.street || a.street.id == null || !a.city) continue;
      if (normName(a.street.name) === normName(streetName) && normName(a.city.name) === normName(item.commune)) return a.street.id;
    }
    return null;
  }

  function buildDescription(item, withAddress) {
    const parts = [];
    if (withAddress && item.adresse) parts.push(`Adresse : ${item.adresse}${item.commune ? `, ${item.commune}` : ''}`);
    if (item.operateur) parts.push(`Opérateur : ${item.operateur}`);
    if (item.enseigne && item.enseigne !== item.operateur) parts.push(`Enseigne : ${item.enseigne}`);
    parts.push(`${item.nbPdc} point(s) de charge`);
    parts.push(SOURCE_MENTION);
    const txt = parts.join(' — ');
    return txt.length > DESC_MAX ? `${txt.slice(0, DESC_MAX - 1)}…` : txt;
  }

  async function applyLock(venueId, warnings) {
    if (state.settings.lock === 'none') return;
    let rank = null;
    try { const ui = await state.sdk.State.getUserInfo(); rank = ui && Number.isFinite(ui.rank) ? ui.rank : null; } catch (e) { rank = null; }
    if (rank === null) { warnings.push('Verrou non posé : ton rang d’éditeur est illisible.'); return; }
    const wanted = TABLE_LOCK_LEVEL - 1;
    const target = Math.min(wanted, rank);
    try { await DM().Venues.updateVenue({ venueId, lockRank: target }); } catch (e) { warnings.push(`Verrou non posé : ${e.message}`); return; }
    try {
      const v = await DM().Venues.getById({ venueId });
      if (v && Number.isFinite(v.lockRank) && v.lockRank !== target) warnings.push(`Verrou différent de celui demandé (lu : niveau ${v.lockRank + 1}, voulu : ${target + 1}).`);
    } catch (e) { /* lecture de contrôle indisponible */ }
    if (target < wanted) warnings.push(`Verrou plafonné à ton rang (niveau ${target + 1} au lieu de ${TABLE_LOCK_LEVEL}) : un éditeur de niveau ${TABLE_LOCK_LEVEL} devra le relever.`);
  }

  async function prepareOne(item) {
    if (state.busy) { setStatus('⏳ Une opération est déjà en cours.', 'warn'); return; }
    state.busy = true;
    let venueId = null;
    try {
      if (!state.categoryId) { setStatus('⚠️ Catégorie « Station de charge » introuvable : préparation impossible.', 'warn'); return; }

      // 1. Une seule station préparée à la fois
      await reconcile();
      const other = state.rawItems.find((f) => f.status === 'prepared' && f !== item);
      if (other) {
        renderList();
        setStatus(`⛔ « ${other.name} » est préparée mais pas encore enregistrée.\nVérifie-la puis clique sur « Enregistrer » dans WME (ou annule-la avec Ctrl+Z puis ↩️) avant d'en préparer une autre.`, 'warn');
        return;
      }

      // 2. La zone doit être affichée et chargée pour contrôler l'existant
      const pt = [item.center.lon, item.center.lat];
      const zone = await zoneLoaded(pt);
      if (zone === 'out') {
        highlightAndGoTo(item);
        setStatus(`📍 « ${item.name} » n'est pas à l'écran à un zoom suffisant : je t'y emmène.\nAttends que WME charge la zone, puis clique de nouveau sur ➕.`, 'warn');
        return;
      }
      if (Date.now() - (item.navAt || 0) < NAV_SETTLE_MS) { setStatus('⏳ Laisse à WME quelques secondes pour charger la zone, puis clique de nouveau sur ➕.', 'warn'); return; }
      if (zone === 'noroad') { setStatus('⏳ Aucune route chargée autour de cette station : la zone n’est pas encore chargée. Patiente puis clique de nouveau sur ➕ (rien n’est créé à l’aveugle).', 'warn'); return; }

      // 3. Contrôle de l'existant
      const dups = await findNearbyStations(item);
      if (dups.length && !item.forceDup) { showCandidates(item, dups); return; }
      item.knownIds = new Set(dups.map((d) => d.id));

      // 4. Création du brouillon (aucun enregistrement)
      const venue = await DM().Venues.addVenue({ category: state.categoryId, geometry: item.geometry, name: item.name });
      venueId = extractVenueId(venue);
      if (venueId === null) throw new Error("addVenue n'a pas renvoyé d'identifiant — vérifie dans WME (Ctrl+Z si un lieu est apparu)");

      const warnings = [];
      try {
        await DM().Venues.updateVenue({ venueId, name: item.name });
        const v = await DM().Venues.getById({ venueId });
        if (v && typeof v.name === 'string' && v.name !== item.name) warnings.push(`Nom lu « ${v.name} » au lieu de « ${item.name} ».`);
      } catch (e) { warnings.push(`Nom non confirmé : ${e.message}`); }

      // Adresse : rue existante de la bonne commune, sinon dans la description
      let addressOk = false;
      if (item.adresse) {
        let streetId = null;
        try { streetId = await findStreetId(item); } catch (e) { streetId = null; }
        if (streetId != null) {
          try {
            await DM().Venues.updateAddress({ venueId, houseNumber: parseAddressText(item.adresse).houseNumber, streetId });
            const a = await DM().Venues.getAddress({ venueId });
            addressOk = !(a && a.street && a.street.id !== streetId);
          } catch (e) { addressOk = false; }
        }
        if (!addressOk) warnings.push('Rue introuvable à proximité dans la bonne commune (le script ne crée jamais de rue) : adresse écrite en description, à reporter toi-même.');
      }
      try { await DM().Venues.updateVenue({ venueId, description: buildDescription(item, !addressOk) }); } catch (e) { warnings.push(`Description non écrite : ${e.message}`); }

      // Téléphone : seulement s'il est reconnu, au format France
      if (item.phone) {
        try { await DM().Venues.updateVenue({ venueId, phone: item.phone }); } catch (e) { warnings.push(`Téléphone non écrit : ${e.message}`); }
      } else if (item.phoneRaw) warnings.push(`Téléphone « ${item.phoneRaw} » non reconnu : non écrit.`);

      await applyLock(venueId, warnings);

      item.status = 'prepared';
      item.venueId = venueId;
      highlightAndGoTo(item);
      try { state.sdk.Editing.setSelection({ selection: { objectType: 'venue', ids: [venueId] } }); } catch (e) { /* facultatif */ }
      setStatus(`🟡 Station préparée : ${item.name}.\nVérifie la position, le nom, l'adresse et le téléphone, complète le réseau et les prises si besoin, puis clique sur « Enregistrer » dans WME. Le script n'enregistre jamais.${warnings.length ? `\n\n⚠️ À contrôler :\n- ${warnings.join('\n- ')}` : ''}`, warnings.length ? 'warn' : 'ok');
    } catch (e) {
      console.error(`${SCRIPT_NAME}: échec de préparation`, item, e);
      let rollback = '';
      if (venueId !== null) {
        try { await DM().Venues.deleteVenue({ venueId }); rollback = ' Le brouillon créé a été retiré.'; } catch (e2) { rollback = ' ⚠️ Le brouillon créé n’a pas pu être retiré : annule-le avec Ctrl+Z.'; }
      }
      item.status = 'error'; item.venueId = null;
      setStatus(`❌ Échec pour ${item.name} : ${e.message}.${rollback}`, 'err');
    } finally {
      item.forceDup = false;
      state.busy = false;
      renderList();
    }
  }

  // ---------------------------------------------------------------------
  // Suivi honnête : « créée » seulement quand la station est retrouvée ENREGISTRÉE dans WME
  // ---------------------------------------------------------------------
  async function reconcile() {
    if (state.reconciling) return false;
    const prepared = state.rawItems.filter((i) => i.status === 'prepared' && i.venueId);
    if (!prepared.length) return false;
    state.reconciling = true;
    let changed = false;
    try {
      for (const it of prepared) {
        const pt = [it.center.lon, it.center.lat];
        if ((await zoneLoaded(pt)) !== 'ok') continue; // zone non affichée : on ne conclut pas
        let draft = null;
        try { draft = await DM().Venues.getById({ venueId: it.venueId }); } catch (e) { draft = null; }
        if (draft) continue;
        const all = (await DM().Venues.getAll()) || [];
        const known = it.knownIds || new Set();
        const saved = all.find((v) => v && v.id != null && !isTempId(v.id) && !known.has(String(v.id))
          && Array.isArray(v.categories) && v.categories.includes(CATEGORY_ID)
          && centroidOf(v.geometry) && distM(pt, centroidOf(v.geometry)) <= DUP_RADIUS_M);
        if (saved) { markDone(it, 'created'); setStatus(`✅ Enregistrée dans WME : ${it.name}.`, 'ok'); }
        else { it.status = 'pending'; it.venueId = null; setStatus(`↩️ Le brouillon de « ${it.name} » n'existe plus (annulé ou supprimé) : remis en attente.`, 'warn'); }
        changed = true;
      }
    } catch (e) {
      console.warn(`${SCRIPT_NAME}: suivi impossible`, e);
    } finally { state.reconciling = false; }
    return changed;
  }

  bootstrap();
})();
