// ==UserScript==
// @name         WME Établissements Scolaires (Annuaire Éducation Nationale)
// @namespace    https://github.com/Romino57/wme-scripts
// @version      2.0.0
// @description  Assistant de saisie : charge l'Annuaire de l'Éducation nationale d'un département, te guide sur la carte (🎯) et PRÉPARE un lieu « École » à la fois, après contrôle des doublons. Le script n'enregistre jamais : tu vérifies chaque lieu puis tu cliques toi-même sur « Enregistrer » dans WME.
// @author       Romino57
// @license      MIT
// @homepageURL  https://github.com/Romino57/wme-scripts/tree/main/wme-etablissements-scolaires
// @supportURL   https://github.com/Romino57/wme-scripts/issues
// @match        https://www.waze.com/*/editor*
// @match        https://www.waze.com/editor*
// @match        https://beta.waze.com/*
// @exclude      https://www.waze.com/*user/editor/*
// @require      https://cdn.jsdelivr.net/npm/@turf/turf@7.2.0/turf.min.js#sha256=d5786c08ae4e988b37aa5c26de32b051ec2e4680f602f2a98ca3bc4b328e3432
// @require      https://cdn.jsdelivr.net/npm/proj4@2.15.0/dist/proj4.js#sha256=5c73f2719b0c33c8d8e709fc3d71056b39623d5f9182fb06a7b8e5173cfd8651
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      data.education.gouv.fr
// @connect      data.geopf.fr
// @run-at       document-idle
// @downloadURL  https://update.greasyfork.org/scripts/589983/WME%20%C3%89tablissements%20Scolaires%20%28Annuaire%20%C3%89ducation%20Nationale%29.user.js
// @updateURL    https://update.greasyfork.org/scripts/589983/WME%20%C3%89tablissements%20Scolaires%20%28Annuaire%20%C3%89ducation%20Nationale%29.meta.js
// ==/UserScript==

/* global turf, proj4, GM_xmlhttpRequest, unsafeWindow */

/*
 * Sources de données (Licence Ouverte 2.0 — à citer) :
 *   - Annuaire de l'éducation (ministère de l'Éducation nationale) : data.education.gouv.fr
 *   - BD TOPO, couche bâtiment (IGN, option) : data.geopf.fr
 *
 * Fonctionnement : le script ne fait que des lectures vers ces deux services. Dans WME il crée,
 * à ta demande et UN SEUL à la fois, un lieu « École » en brouillon. Il n'appelle jamais
 * « Enregistrer » : c'est toi qui vérifies puis qui enregistres.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // CONFIGURATION
  // ---------------------------------------------------------------------
  const SCRIPT_NAME = 'WME Établissements Scolaires';
  const VERSION_SCRIPT = '2.0.0';
  const API_BASES = [
    'https://data.education.gouv.fr/api/v2/catalog/datasets/fr-en-annuaire-education/records',
    'https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-annuaire-education/records',
  ];
  const PAGE_SIZE = 100;
  const MAX_RECORDS = 4000;           // filet de sécurité pour le chargement de la liste (lecture seule)
  const RENDER_MAX = 300;             // lignes affichées au maximum (affine par commune / recherche)
  const DUP_RADIUS_M = 150;           // un lieu WME à moins de ... m (école ou nom proche) bloque la création
  const ROAD_RADIUS_M = 300;          // preuve que la zone est chargée : une route à moins de ... m
  const ADDRESS_RADIUS_M = 120;       // rue cherchée parmi les segments à moins de ... m
  const MIN_ZOOM = 16;                // en dessous, les lieux ne sont pas tous chargés : on refuse de créer
  const NAV_SETTLE_MS = 3000;         // délai laissé à WME pour charger la carte après un déplacement
  const RECONCILE_MS = 4000;          // suivi : relecture (sans aucune écriture) des lieux préparés
  const SCHOOL_CATEGORY_ID = 'SCHOOL';
  const HIGHLIGHT_LAYER = 'wme-etab-scolaires-highlight';
  const DONE_STATUSES_KEY = 'wme-etab-scolaires-done-statuses';
  const SCHOOLZONE_STATUSES_KEY = 'wme-etab-scolaires-schoolzone-statuses';
  const SETTINGS_KEY = 'wme-etab-scolaires-settings';

  // Contour de bâtiment IGN (option, décochée par défaut)
  const WFS_URL = 'https://data.geopf.fr/wfs/ows';
  const BATIMENT_TYPENAME = 'BDTOPO_V3:batiment';
  const BUILDING_SEARCH_RADIUS_DEG = 0.0007; // ~ 70-80 m
  const BUILDING_NEAR_SCHOOL_M = 60;         // sans contenir le point, un bâtiment « Enseignement » doit être à moins de ... m

  // Emprise plausible de la France métropolitaine (Corse comprise)
  const FR_BOUNDS = { lonMin: -5.5, lonMax: 10, latMin: 41, latMax: 51.5 };

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
  // Comparaison de noms de rue / de commune : sans accents, sans casse, tirets et apostrophes = espaces
  const normName = (s) => norm(s).replace(/['’`\-]/g, ' ').replace(/\s+/g, ' ').trim();

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
  function distM(a, b) {
    const [x, y] = toMeters(b, a);
    return Math.hypot(x, y);
  }
  function nearestOnPolyline(pt, coords) {
    let best = Infinity;
    const P = [0, 0];
    for (let i = 0; i < coords.length - 1; i++) {
      const a = toMeters(coords[i], pt);
      const b = toMeters(coords[i + 1], pt);
      const dx = b[0] - a[0]; const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : ((P[0] - a[0]) * dx + (P[1] - a[1]) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(a[0] + t * dx, a[1] + t * dy);
      if (d < best) best = d;
    }
    return best;
  }
  // Point représentatif d'une géométrie GeoJSON (Point, Polygon, MultiPolygon)
  function centroidOf(geometry) {
    if (!geometry || !geometry.coordinates) return null;
    if (geometry.type === 'Point') return [geometry.coordinates[0], geometry.coordinates[1]];
    let ring = null;
    if (geometry.type === 'Polygon') ring = geometry.coordinates[0];
    else if (geometry.type === 'MultiPolygon') ring = geometry.coordinates[0] && geometry.coordinates[0][0];
    if (!ring || !ring.length) return null;
    const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
    let sx = 0; let sy = 0;
    for (const p of pts) { sx += p[0]; sy += p[1]; }
    return [sx / pts.length, sy / pts.length];
  }
  const isTempId = (id) => String(id).charAt(0) === '-';
  const inBounds = (pt, b) => pt[0] >= b[0] && pt[0] <= b[2] && pt[1] >= b[1] && pt[1] <= b[3];

  // Nom du lieu : espaces normalisés, « Ecole » → « École »
  function cleanName(n) {
    let s = String(n == null ? '' : n).replace(/\s+/g, ' ').trim();
    s = s.replace(/^ecole\b/i, 'École');
    return s || 'Établissement scolaire';
  }

  const STOP_WORDS = new Set(['ecole', 'college', 'lycee', 'maternelle', 'elementaire', 'primaire', 'publique', 'public', 'privee', 'prive', 'groupe', 'scolaire', 'de', 'du', 'des', 'la', 'le', 'les', 'et', 'en', 'au', 'aux', 'pour']);
  function distinctiveTokens(s) {
    return normName(s).split(' ').filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
  }
  // Deux noms « se ressemblent » : l'un contient l'autre, ou ils partagent des mots distinctifs.
  function nameSimilar(a, b) {
    const na = normName(a); const nb = normName(b);
    if (!na || !nb) return false;
    if (na.includes(nb) || nb.includes(na)) return true;
    const ta = distinctiveTokens(a); const tb = distinctiveTokens(b);
    if (!ta.length || !tb.length) return false;
    const shared = ta.filter((t) => tb.includes(t)).length;
    return shared >= Math.min(2, ta.length, tb.length);
  }
  const hasSchoolCategory = (v) => Array.isArray(v && v.categories) && v.categories.some((c) => /SCHOOL|UNIVERSITY|EDUCATION/i.test(String(c)));
  // Types d'établissement cochés par défaut : uniquement les écoles, collèges et lycées.
  const isSchoolType = (t) => /^(ecole|college|lycee)/.test(norm(t));
  // Précision de localisation de l'annuaire : « Ville » = centre de la commune, pas l'établissement.
  const isApproxPrecision = (p) => ['ville', 'commune'].includes(norm(p));

  // ---------------------------------------------------------------------
  // Réglages (persistés)
  // ---------------------------------------------------------------------
  function loadSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      return {
        lock: ['none', '1', '2', '3'].includes(raw.lock) ? raw.lock : 'none',
        building: raw.building === true,
      };
    } catch (e) { return { lock: 'none', building: false }; }
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------
  // Suivi des établissements (persiste au rechargement).
  // Statuts mémorisés : 'created' (constaté enregistré côté WME), 'skipped' (déjà présent).
  // 'prepared' (brouillon en attente d'enregistrement) n'est JAMAIS mémorisé.
  // ---------------------------------------------------------------------
  function loadDoneStatuses() {
    try {
      const raw = localStorage.getItem(DONE_STATUSES_KEY);
      const entries = raw ? Object.entries(JSON.parse(raw)) : [];
      return new Map(entries.filter(([, v]) => v === 'created' || v === 'skipped'));
    } catch (e) { return new Map(); }
  }
  function persistDoneStatuses() {
    try { localStorage.setItem(DONE_STATUSES_KEY, JSON.stringify(Object.fromEntries(state.doneStatuses))); } catch (e) { console.warn(`${SCRIPT_NAME}: suivi non enregistré`, e); }
  }
  function markDone(item, status) {
    item.status = status;
    item.venueId = null;
    state.doneStatuses.set(item.stableId, status);
    persistDoneStatuses();
  }
  function unmarkDone(item) {
    item.status = 'pending';
    item.venueId = null;
    state.doneStatuses.delete(item.stableId);
    persistDoneStatuses();
  }
  function loadSchoolZoneStatuses() {
    try { const raw = localStorage.getItem(SCHOOLZONE_STATUSES_KEY); return new Set(raw ? JSON.parse(raw) : []); } catch (e) { return new Set(); }
  }
  function persistSchoolZoneStatuses() {
    try { localStorage.setItem(SCHOOLZONE_STATUSES_KEY, JSON.stringify(Array.from(state.schoolZoneDone))); } catch (e) { /* ignore */ }
  }
  function toggleSchoolZoneDone(item) {
    if (state.schoolZoneDone.has(item.stableId)) state.schoolZoneDone.delete(item.stableId); else state.schoolZoneDone.add(item.stableId);
    persistSchoolZoneStatuses();
  }

  const state = {
    sdk: null,
    rawItems: [],
    features: [],
    settings: loadSettings(),
    doneStatuses: loadDoneStatuses(),
    schoolZoneDone: loadSchoolZoneStatuses(),
    forcedCategoryId: '',
    busy: false,
    reconciling: false,
  };
  const DM = () => state.sdk.DataModel;

  // ---------------------------------------------------------------------
  // Lambert 93 → WGS84 (certaines réponses WFS ignorent la demande EPSG:4326)
  // ---------------------------------------------------------------------
  if (typeof proj4 !== 'undefined' && proj4.defs) {
    proj4.defs('EPSG:2154', '+proj=lcc +lat_1=44 +lat_2=49 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
  }
  function sanitizeCoordArray(coords) {
    if (typeof coords[0] === 'number') {
      const a = coords[0]; const b = coords[1]; // 3e valeur éventuelle (altitude) ignorée
      const looksWgs84 = a >= -6 && a <= 12 && b >= 40 && b <= 52;
      if (!looksWgs84 && typeof proj4 !== 'undefined') {
        try { const r = proj4('EPSG:2154', 'EPSG:4326', [a, b]); return [r[0], r[1]]; } catch (e) { console.warn(`${SCRIPT_NAME}: reprojection Lambert93 impossible`, e); }
      }
      return [a, b];
    }
    return coords.map(sanitizeCoordArray);
  }
  function sanitizeGeometry(geometry) {
    if (!geometry || !geometry.coordinates) return geometry;
    return { type: geometry.type, coordinates: sanitizeCoordArray(geometry.coordinates) };
  }

  // ---------------------------------------------------------------------
  // Style du panneau (scopé sous #es-panel)
  // ---------------------------------------------------------------------
  function injecterStyles() {
    if (document.getElementById('es-styles')) return;
    const style = document.createElement('style');
    style.id = 'es-styles';
    style.textContent = `
#es-panel {
    --es-bg: #ffffff; --es-bg-subtle: #f8fafc; --es-border: #e2e8f0; --es-text: #1e293b;
    --es-text-secondary: #64748b; --es-accent: #1a73e8; --es-accent-light: #e8f0fe;
    --es-radius: 12px; --es-radius-sm: 8px;
    --es-shadow: 0 1px 3px rgba(15,23,42,.06), 0 1px 2px rgba(15,23,42,.04);
    padding: 8px; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: var(--es-text); box-sizing: border-box; font-size: 12px;
}
#es-panel * { box-sizing: border-box; }
#es-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 14px;
    background: var(--es-bg-subtle); border: 1px solid var(--es-border); border-radius: var(--es-radius); margin-bottom: 12px; }
#es-header .es-title { font-size: 14px; font-weight: 800; letter-spacing: -0.01em; }
#es-header .es-badge { font-size: 10px; padding: 3px 9px; border-radius: 999px; background: var(--es-accent-light); color: var(--es-accent); font-weight: 700; white-space: nowrap; }
.es-card { background: var(--es-bg); border: 1px solid var(--es-border); border-radius: var(--es-radius); margin-bottom: 10px; box-shadow: var(--es-shadow); overflow: hidden; }
.es-card__head { display: flex; align-items: center; gap: 6px; padding: 10px 14px; background: var(--es-bg-subtle); border-bottom: 1px solid var(--es-border); font-size: 12px; font-weight: 700; }
.es-card__body { padding: 12px 14px; }
.es-label { display: block; font-size: 11px; font-weight: 700; color: var(--es-text-secondary); text-transform: uppercase; letter-spacing: .03em; margin: 10px 0 4px; }
.es-label:first-child { margin-top: 0; }
.es-sub { font-size: 10px; color: var(--es-text-secondary); margin: 2px 0 6px; }
.es-steps { margin: 0; padding-left: 18px; line-height: 1.5; }
.es-steps li { margin-bottom: 2px; }
.es-note { background: #fff8e1; border: 1px solid #f9a825; border-radius: var(--es-radius-sm); padding: 8px 10px; margin-top: 8px; font-size: 11px; }
#es-panel select, #es-panel input[type=text] { width: 100%; padding: 7px 10px; border-radius: var(--es-radius-sm); border: 1px solid var(--es-border); font-size: 12px; background: #fff; }
.es-value-box { padding: 6px 10px; background: var(--es-bg-subtle); border: 1px solid var(--es-border); border-radius: var(--es-radius-sm); font-weight: 700; font-size: 12px; }
#es-panel button { width: 100%; padding: 9px; border: none; border-radius: var(--es-radius-sm); background: var(--es-accent); color: #fff; font-weight: 700; font-size: 12px; cursor: pointer; transition: background .15s; }
#es-panel button:disabled { background: #c7d2fe; cursor: not-allowed; }
#es-panel button:hover:not(:disabled) { background: #145a9e; }
.es-status { font-size: 12px; font-weight: 700; color: var(--es-text); min-height: 16px; white-space: pre-line; padding: 8px 10px; border-radius: var(--es-radius-sm); background: var(--es-bg-subtle); border: 1px solid var(--es-border); }
.es-status.is-ok { background: #e8f5e9; border-color: #a5d6a7; color: #1b5e20; }
.es-status.is-warn { background: #fff8e1; border-color: #f9a825; color: #6d4c00; }
.es-status.is-err { background: #fdecea; border-color: #f5b5ad; color: #b71c1c; }
.es-bar-track { background: #eee; border-radius: 999px; height: 8px; overflow: hidden; margin-top: 4px; }
.es-bar-fill { height: 100%; border-radius: 999px; transition: width .3s ease, background .3s ease; }
.es-progress-row { display: flex; justify-content: space-between; align-items: center; font-size: 11px; font-weight: 700; }
.es-progress-pct { font-weight: 700; color: var(--es-text-secondary); }
.es-error-note { font-size: 11px; color: #b91c1c; margin-top: 6px; }
.es-pending-note { font-size: 11px; color: #6d4c00; margin-top: 6px; }
.es-reset-link { font-size: 10px; color: #888; white-space: nowrap; text-decoration: none; }
.es-reset-link:hover { text-decoration: underline; }
.es-list { max-height: 320px; overflow-y: auto; border: 1px solid var(--es-border); border-radius: var(--es-radius-sm); padding: 4px; }
.es-item { display: flex; align-items: center; gap: 4px; padding: 6px 8px; border: 1px solid var(--es-border); border-radius: var(--es-radius-sm); margin-bottom: 4px; background: var(--es-bg); transition: background .15s; }
.es-item:hover { background: var(--es-bg-subtle); }
.es-item.is-done { opacity: .55; }
.es-item.is-partial { background: #fff8e1; border-color: #f9a825; opacity: .9; }
.es-item.is-prepared { background: #e3f2fd; border-color: #64b5f6; }
.es-item.is-error { background: #fdecea; border-color: #f5b5ad; }
.es-item .es-item-name { flex: 1; font-size: 12px; }
.es-item .es-item-name.is-strike { text-decoration: line-through; }
.es-item small { color: var(--es-text-secondary); }
#es-panel button.es-item-btn { width: auto; padding: 2px 6px; border-radius: 6px; font-size: 12px; font-weight: 400; background: #eef2f7; color: #1e293b; }
#es-panel button.es-item-btn:hover:not(:disabled) { background: #dbeafe; }
#es-panel button.es-item-btn.is-active { background: #2e7d32; color: #fff; opacity: .85; }
.es-nav-row { display: flex; gap: 8px; margin-top: 6px; }
.es-cands { margin-top: 8px; border: 1px solid #f9a825; background: #fffdf5; border-radius: var(--es-radius-sm); padding: 8px 10px; }
.es-cands__title { font-weight: 700; margin-bottom: 6px; }
.es-cand { display: flex; align-items: center; gap: 6px; padding: 4px 0; border-top: 1px dashed #f0d58a; }
.es-cand span { flex: 1; }
.es-cands__actions { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
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
    const fill = el('div', { class: 'es-bar-fill' });
    fill.style.width = `${pct}%`;
    fill.style.background = couleurAvancement(pct);
    return el('div', { class: 'es-bar-track' }, fill);
  }

  // ---------------------------------------------------------------------
  // Réseau (lectures seules)
  // ---------------------------------------------------------------------
  function gmFetchJson(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: { Accept: 'application/json' },
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) { reject(new Error(`HTTP ${res.status}`)); return; }
          try { resolve(JSON.parse(res.responseText)); } catch (e) { reject(new Error("Réponse non-JSON reçue de l'API.")); }
        },
        onerror: () => reject(new Error(`Erreur réseau vers ${url}`)),
        ontimeout: () => reject(new Error(`Timeout vers ${url}`)),
        timeout: 45000,
      });
    });
  }

  // ---------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------
  function bootstrap() {
    console.log(`${SCRIPT_NAME}: script chargé`);
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', bootstrap); return; }
    if (!pageWindow.SDK_INITIALIZED) { setTimeout(bootstrap, 200); return; }
    pageWindow.SDK_INITIALIZED.then(initScript);
  }

  function initScript() {
    injecterStyles();
    state.sdk = pageWindow.getWmeSdk({ scriptId: 'wme-etab-scolaires', scriptName: SCRIPT_NAME });
    state.sdk.Events.once({ eventName: 'wme-ready' }).then(() => {
      ensureHighlightLayer();
      buildUI();
    });
  }

  function ensureHighlightLayer() {
    try {
      state.sdk.Map.addLayer({
        layerName: HIGHLIGHT_LAYER,
        zIndex: 950,
        styleRules: [{ style: { pointRadius: 12, fillColor: '#e91e63', fillOpacity: 0.5, strokeColor: '#ad1457', strokeWidth: 3 }, predicate: () => true }],
        styleContext: {},
      });
    } catch (e) { console.warn(`${SCRIPT_NAME}: couche de surbrillance indisponible`, e); }
  }

  // ---------------------------------------------------------------------
  // Interface
  // ---------------------------------------------------------------------
  async function buildUI() {
    const { tabLabel, tabPane } = await state.sdk.Sidebar.registerScriptTab();
    tabLabel.textContent = '🏫 Écoles';

    // Gabarit statique : aucune donnée externe n'y est insérée (tout le reste est construit en DOM).
    tabPane.innerHTML = `
      <div id="es-panel">
        <div id="es-header">
          <span class="es-title">🏫 Établissements Scolaires</span>
          <span class="es-badge" id="es-version"></span>
        </div>

        <div class="es-card">
          <div class="es-card__head">🧭 Un lieu à la fois</div>
          <div class="es-card__body">
            <ol class="es-steps">
              <li>🎯 te place sur l'établissement.</li>
              <li>➕ prépare le lieu « École » (brouillon), après contrôle des doublons.</li>
              <li>Tu <b>vérifies</b> le lieu (nom, position, adresse, contour).</li>
              <li>Tu cliques toi-même sur <b>Enregistrer</b> dans WME.</li>
            </ol>
            <div class="es-note">Le script n'enregistre jamais et ne supprime rien. Tant qu'un lieu préparé n'est pas enregistré, il n'en prépare pas un autre.</div>
          </div>
        </div>

        <div class="es-card">
          <div class="es-card__head">🗺️ Zone de travail</div>
          <div class="es-card__body">
            <label class="es-label" for="es-dept">Département</label>
            <select id="es-dept"></select>
            <button id="es-fetch" style="margin-top:8px;">🔎 Charger les établissements du département</button>

            <label class="es-label" for="es-commune">Commune</label>
            <select id="es-commune"><option value="">Charge d'abord un département</option></select>
            <div class="es-nav-row">
              <button id="es-commune-precedente" disabled>◀ Précédente</button>
              <button id="es-commune-suivante" disabled>Suivante ▶</button>
            </div>

            <label class="es-label" for="es-search">Recherche</label>
            <input type="text" id="es-search" placeholder="Filtrer par nom d'établissement...">
          </div>
        </div>

        <div class="es-card">
          <div class="es-card__head">🏷️ Catégorie & options</div>
          <div class="es-card__body">
            <label class="es-label">Catégorie de Place Waze (détectée automatiquement)</label>
            <div id="es-category-display" class="es-value-box">(détection en cours...)</div>

            <label class="es-label" for="es-lock">Verrou posé sur le lieu préparé</label>
            <select id="es-lock">
              <option value="none">Aucun (je verrouille moi-même)</option>
              <option value="1">Niveau 1</option>
              <option value="2">Niveau 2</option>
              <option value="3">Niveau 3</option>
            </select>
            <p class="es-sub">Jamais au-dessus de ton propre rang. Vérifie le niveau attendu pour les écoles dans la table de ta zone.</p>

            <label style="display:flex;align-items:center;gap:6px;margin-top:10px;font-weight:normal;font-size:12px;">
              <input type="checkbox" id="es-fetch-building" style="width:auto;" />
              Proposer le contour du bâtiment (IGN BDTOPO) au lieu d'un point
            </label>
            <p class="es-sub">Décoché par défaut. Retenu seulement s'il contient la position de l'annuaire (ou s'il est « Enseignement » à moins de 60 m). Pour un ensemble de bâtiments, ajuste le contour à l'emprise de la propriété.</p>
          </div>
        </div>

        <div class="es-card">
          <div class="es-card__head">🏫 Types d'établissement</div>
          <div class="es-card__body">
            <div id="es-types" style="font-size:11px;"></div>
            <p class="es-sub">Seuls les écoles, collèges et lycées sont cochés par défaut. Les autres types (services administratifs, médico-social...) ne sont pas des écoles.</p>
          </div>
        </div>

        <div class="es-card">
          <div class="es-card__head">📋 Liste</div>
          <div class="es-card__body">
            <div id="es-status" class="es-status" role="status" aria-live="polite"></div>
            <div id="es-cands" class="es-cands" hidden></div>
            <div id="es-progress-bloc" style="margin:8px 0;"></div>
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;gap:8px;">
              <label style="font-size:11px;font-weight:normal;display:flex;align-items:center;gap:4px;">
                <input type="checkbox" id="es-hide-done" style="width:auto;" /> Masquer les zones entièrement traitées
              </label>
              <span>
                <a href="#" id="es-refresh" class="es-reset-link">Actualiser le suivi</a> ·
                <a href="#" id="es-reset-memory" class="es-reset-link">Réinitialiser la mémoire</a>
              </span>
            </div>
            <div id="es-list" class="es-list"></div>
          </div>
        </div>
      </div>
    `;

    const q = (s) => tabPane.querySelector(s);
    q('#es-version').textContent = `v${VERSION_SCRIPT}`;
    const deptSelect = q('#es-dept');
    DEPARTEMENTS.forEach(([code, nom]) => deptSelect.appendChild(el('option', { value: code, text: `${code} - ${nom}` })));
    q('#es-lock').value = state.settings.lock;
    q('#es-fetch-building').checked = state.settings.building;

    q('#es-lock').addEventListener('change', (e) => { state.settings.lock = e.target.value; saveSettings(); });
    q('#es-fetch-building').addEventListener('change', (e) => { state.settings.building = e.target.checked; saveSettings(); });
    q('#es-fetch').addEventListener('click', onFetch);
    q('#es-hide-done').addEventListener('change', renderList);
    q('#es-commune').addEventListener('change', () => { applyFilters(); centerOnCommune(q('#es-commune').value); });
    q('#es-commune-precedente').addEventListener('click', () => allerVersCommune(-1));
    q('#es-commune-suivante').addEventListener('click', () => allerVersCommune(1));
    q('#es-search').addEventListener('input', applyFilters);
    q('#es-list').addEventListener('click', onListClick);
    q('#es-refresh').addEventListener('click', async (e) => {
      e.preventDefault();
      const changed = await reconcile();
      if (changed) renderList(); // reconcile() a déjà écrit son message (enregistré / annulé)
      else setStatus('Rien de nouveau : aucun lieu préparé à vérifier, ou sa zone n’est pas affichée et chargée à l’écran.');
    });
    q('#es-reset-memory').addEventListener('click', (e) => {
      e.preventDefault();
      if (!window.confirm('Oublier la liste des établissements déjà traités (créés ou marqués "déjà présent"), mémorisée sur cet ordinateur ?\nCela ne supprime aucune Place dans WME, ça remet juste le suivi à zéro.')) return;
      state.doneStatuses = new Map();
      persistDoneStatuses();
      state.rawItems.forEach((f) => { if (f.status === 'created' || f.status === 'skipped') f.status = 'pending'; });
      renderList();
      setStatus('Mémoire des établissements traités réinitialisée.');
    });

    loadVenueCategories();
    setInterval(async () => {
      if (state.reconciling || state.busy) return;
      if (!state.rawItems.some((i) => i.status === 'prepared')) return;
      if (await reconcile()) renderList();
    }, RECONCILE_MS);
  }

  function setStatus(msg, kind) {
    const node = document.querySelector('#es-status');
    if (!node) return;
    node.textContent = msg;
    node.className = `es-status${kind ? ` is-${kind}` : ''}`;
  }

  // ---------------------------------------------------------------------
  // Catégorie « École »
  // ---------------------------------------------------------------------
  async function loadVenueCategories() {
    const display = document.querySelector('#es-category-display');
    let subCats = [];
    try { subCats = (await DM().Venues.getVenueSubCategories()) || []; } catch (e) { console.warn(`${SCRIPT_NAME}: getVenueSubCategories a échoué`, e); }
    const cats = (Array.isArray(subCats) ? subCats : []).map((c) => ({
      id: c.subCategoryId || c.id || c.value,
      label: c.localizedName || c.name || c.label || c.subCategoryId,
    }));
    const confirmed = cats.find((c) => c.id === SCHOOL_CATEGORY_ID);
    const schoolLike = cats.filter((c) => /SCHOOL|EDUCATION/i.test(c.id || '') || /ecole|education|scolaire/.test(norm(c.label)));
    const chosen = confirmed || schoolLike.find((c) => norm(c.label) === 'ecole') || schoolLike[0] || null;
    state.forcedCategoryId = chosen ? chosen.id : '';
    if (display) display.textContent = chosen ? `${chosen.label} (id: ${chosen.id})` : '⚠️ Aucune catégorie "École" détectée — voir console';
    if (!chosen) setStatus('⚠️ Impossible de détecter une catégorie « École » : la préparation de lieux est désactivée.', 'warn');
  }

  // ---------------------------------------------------------------------
  // Contour de bâtiment (option) — sélection prudente
  // ---------------------------------------------------------------------
  function toFilledPolygon(geometry) {
    if (!geometry || geometry.type !== 'Polygon' || geometry.coordinates.length <= 1) return geometry;
    return { type: 'Polygon', coordinates: [geometry.coordinates[0]] };
  }

  // Retourne la géométrie du bâtiment ou null. Un bâtiment n'est retenu que s'il CONTIENT la position
  // de l'annuaire, ou s'il est d'usage « Enseignement » à moins de BUILDING_NEAR_SCHOOL_M mètres.
  async function fetchBuildingGeometry(center) {
    if (typeof turf === 'undefined') return null;
    const d = BUILDING_SEARCH_RADIUS_DEG;
    const params = new URLSearchParams({
      SERVICE: 'WFS', VERSION: '2.0.0', REQUEST: 'GetFeature', TYPENAMES: BATIMENT_TYPENAME, SRSNAME: 'EPSG:4326',
      OUTPUTFORMAT: 'application/json', BBOX: `${center.lon - d},${center.lat - d},${center.lon + d},${center.lat + d},EPSG:4326`, COUNT: '50',
    });
    let data;
    try { data = await gmFetchJson(`${WFS_URL}?${params.toString()}`); } catch (e) { console.warn(`${SCRIPT_NAME}: bâtiment IGN indisponible`, e.message); return null; }
    if (!data || !Array.isArray(data.features) || !data.features.length) return null;

    const point = turf.point([center.lon, center.lat]);
    const candidates = [];
    for (const rawFeat of data.features) {
      if (!rawFeat.geometry) continue;
      const feat = { ...rawFeat, geometry: sanitizeGeometry(rawFeat.geometry) };
      let polys;
      try { polys = feat.geometry.type === 'MultiPolygon' ? turf.flatten(feat.geometry).features : [turf.feature(feat.geometry)]; } catch (e) { continue; }
      for (const p of polys) {
        if (!p.geometry || p.geometry.type !== 'Polygon') continue;
        const usageKey = Object.keys(feat.properties || {}).find((k) => /usage/i.test(k));
        const isSchoolUsage = !!(usageKey && /enseignement/i.test(String(feat.properties[usageKey])));
        let contains = false;
        try { contains = turf.booleanPointInPolygon(point, p); } catch (e) { /* ignore */ }
        let distKm = Infinity;
        try { distKm = turf.distance(point, turf.centroid(p)); } catch (e) { /* ignore */ }
        if (contains || (isSchoolUsage && distKm * 1000 <= BUILDING_NEAR_SCHOOL_M)) candidates.push({ geometry: p.geometry, isSchoolUsage, contains, distKm });
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      const score = (c) => (c.contains ? 2 : 0) + (c.isSchoolUsage ? 1 : 0);
      return score(b) - score(a) || a.distKm - b.distKm;
    });
    return toFilledPolygon(candidates[0].geometry);
  }

  // ---------------------------------------------------------------------
  // Chargement des établissements d'un département (lectures seules)
  // ---------------------------------------------------------------------
  let fieldMapCache = null;

  function pickField(keys, patterns) {
    for (const re of patterns) { const found = keys.find((k) => re.test(k)); if (found) return found; }
    return null;
  }
  function flattenRecord(raw) { return raw && raw.record && raw.record.fields ? raw.record.fields : raw; }

  async function detectFieldMap(base) {
    const data = await gmFetchJson(`${base}?limit=1`);
    const rawList = data.results || data.records || [];
    if (!rawList[0]) throw new Error('Réponse vide, impossible de détecter les champs.');
    const keys = Object.keys(flattenRecord(rawList[0]));
    const map = {
      dept: pickField(keys, [/^code_departement$/i, /code.*depart/i, /^departement$/i]),
      uai: pickField(keys, [/identifiant.*etablissement/i, /^uai$/i, /numero_uai/i]),
      nom: pickField(keys, [/^nom_etablissement$/i, /^nom$/i]),
      type: pickField(keys, [/^type_etablissement$/i, /^type$/i]),
      adresse: pickField(keys, [/^adresse_uai$/i, /^adresse_1$/i, /^adresse$/i, /^adresse_.*$/i]),
      commune: pickField(keys, [/^nom_commune$/i, /^commune$/i, /libelle_commune/i]),
      codePostal: pickField(keys, [/^code_postal$/i, /^code_postal_uai$/i]),
      position: pickField(keys, [/^position$/i, /geo_point/i, /^coordonnees/i, /^coordonnee/i]),
      precision: pickField(keys, [/precision.*localisation/i, /^precision/i]),
    };
    if (!map.dept) throw new Error(`Impossible de trouver le champ « département » parmi : ${keys.join(', ')}`);
    if (!map.position) throw new Error(`Impossible de trouver le champ « position » parmi : ${keys.join(', ')}`);
    return map;
  }

  // Le champ département est du texte ("01", "2A") ou un nombre ; la Corse est codée "02A"/"02B" dans l'annuaire.
  function buildWhereCandidates(field, deptCode) {
    const candidates = [`${field}="${deptCode}"`];
    if (/^\d+$/.test(deptCode)) {
      const stripped = String(parseInt(deptCode, 10));
      const padded3 = deptCode.padStart(3, '0');
      candidates.push(`${field}=${deptCode}`);
      if (stripped !== deptCode) { candidates.push(`${field}="${stripped}"`); candidates.push(`${field}=${stripped}`); }
      if (padded3 !== deptCode) candidates.push(`${field}="${padded3}"`);
    } else if (/^2[AB]$/i.test(deptCode)) {
      candidates.push(`${field}="0${deptCode.toUpperCase()}"`);
    }
    candidates.push(`${field} like "${deptCode}"`);
    return candidates;
  }

  async function fetchAllRecords(deptCode) {
    let lastError = null;
    for (const base of API_BASES) {
      try {
        if (!fieldMapCache || fieldMapCache.base !== base) fieldMapCache = { base, map: await detectFieldMap(base) };
        const map = fieldMapCache.map;
        let workingWhere = null;
        for (const where of buildWhereCandidates(map.dept, deptCode)) {
          const probe = await gmFetchJson(`${base}?${new URLSearchParams({ where, limit: '1' }).toString()}`);
          if ((probe.results || probe.records || []).length > 0) { workingWhere = where; break; }
        }
        if (!workingWhere) throw new Error('Aucune des clauses testées ne renvoie de résultat.');
        const results = [];
        let offset = 0;
        while (true) {
          const data = await gmFetchJson(`${base}?${new URLSearchParams({ where: workingWhere, limit: String(PAGE_SIZE), offset: String(offset) }).toString()}`);
          const batch = (data.results || data.records || []).map(flattenRecord);
          results.push(...batch);
          offset += batch.length;
          if (batch.length < PAGE_SIZE) break;
          if (data.total_count !== undefined && offset >= data.total_count) break;
          if (offset >= MAX_RECORDS) break;
        }
        return { records: results, map };
      } catch (e) {
        lastError = e;
        fieldMapCache = null;
        console.warn(`${SCRIPT_NAME}: échec avec ${base}`, e.message);
      }
    }
    throw lastError || new Error('Aucune base API disponible.');
  }

  // Position → {lon, lat}, ou null si absente / hors France métropolitaine.
  function extractLonLat(record, positionField) {
    const pos = record[positionField];
    if (!pos) return null;
    let a; let b;
    if (Array.isArray(pos) && pos.length === 2) { a = Number(pos[0]); b = Number(pos[1]); }
    else if (typeof pos === 'object' && pos.lon !== undefined && pos.lat !== undefined) { a = Number(pos.lon); b = Number(pos.lat); }
    else if (typeof pos === 'object' && pos.longitude !== undefined && pos.latitude !== undefined) { a = Number(pos.longitude); b = Number(pos.latitude); }
    else if (typeof pos === 'string' && pos.includes(',')) { const p = pos.split(','); a = Number(p[0]); b = Number(p[1]); }
    else return null;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const ok = (lon, lat) => lon >= FR_BOUNDS.lonMin && lon <= FR_BOUNDS.lonMax && lat >= FR_BOUNDS.latMin && lat <= FR_BOUNDS.latMax;
    if (ok(a, b)) return { lon: a, lat: b };
    if (ok(b, a)) return { lon: b, lat: a }; // ordre inversé (lat, lon)
    return null;
  }

  async function onFetch() {
    const dept = document.querySelector('#es-dept').value;
    setStatus(`⏳ Récupération des établissements (${dept})...`);
    try {
      const { records, map } = await fetchAllRecords(dept);
      if (!records.length) { setStatus('❌ 0 établissement reçu pour ce département. Voir la console (F12).', 'err'); return; }
      const items = [];
      let skippedNoGeo = 0;
      for (const rec of records) {
        const lonLat = extractLonLat(rec, map.position);
        if (!lonLat) { skippedNoGeo++; continue; }
        const stableId = (map.uai && rec[map.uai]) || `geo-${lonLat.lon.toFixed(5)}-${lonLat.lat.toFixed(5)}`;
        const precision = (map.precision && rec[map.precision]) || '';
        items.push({
          id: `es-${items.length}`,
          stableId,
          name: cleanName(map.nom && rec[map.nom]),
          type: (map.type && rec[map.type]) || 'Type inconnu',
          commune: (map.commune && rec[map.commune]) || '',
          codePostal: (map.codePostal && rec[map.codePostal]) || '',
          adresse: (map.adresse && rec[map.adresse]) || '',
          precision,
          approx: isApproxPrecision(precision),
          geometry: { type: 'Point', coordinates: [lonLat.lon, lonLat.lat] },
          center: lonLat,
          status: state.doneStatuses.get(stableId) || 'pending',
          venueId: null,
        });
      }
      items.sort((a, b) => (a.commune + a.name).localeCompare(b.commune + b.name, 'fr'));
      state.rawItems = items;
      buildTypeFilters();
      buildCommuneFilter();
      const s = document.querySelector('#es-search');
      if (s) s.value = '';
      applyFilters();
      const approx = items.filter((it) => it.approx).length;
      const nCreated = items.filter((it) => it.status === 'created').length;
      const nSkipped = items.filter((it) => it.status === 'skipped').length;
      const parts = [];
      if (nCreated) parts.push(`${nCreated} déjà créé(s)`);
      if (nSkipped) parts.push(`${nSkipped} déjà présent(s)`);
      setStatus(`✅ ${items.length} établissement(s) chargé(s)`
        + (skippedNoGeo ? ` (${skippedNoGeo} sans position exploitable ignorés)` : '')
        + (approx ? `\n⚠️ ${approx} ont une position approximative (centre de la commune) : à placer à la main.` : '')
        + (parts.length ? `\n${parts.join(', ')} (mémorisé)` : ''), 'ok');
    } catch (e) {
      console.error(e);
      setStatus(`❌ Échec : ${e.message}`, 'err');
    }
  }

  // ---------------------------------------------------------------------
  // Filtres (type / commune / recherche)
  // ---------------------------------------------------------------------
  function buildTypeFilters() {
    const container = document.querySelector('#es-types');
    if (!container) return;
    container.textContent = '';
    const types = Array.from(new Set(state.rawItems.map((it) => it.type))).sort();
    types.forEach((t) => {
      const cb = el('input', { type: 'checkbox', class: 'es-type-cb', style: 'width:auto;', checked: isSchoolType(t) });
      cb.dataset.type = t;
      cb.addEventListener('change', applyFilters);
      container.appendChild(el('label', { style: 'display:inline-flex;align-items:center;gap:3px;margin-right:10px;margin-bottom:3px;' }, cb, ` ${t}`));
    });
  }

  function buildCommuneFilter() {
    const select = document.querySelector('#es-commune');
    if (!select) return;
    const communes = Array.from(new Set(state.rawItems.map((it) => it.commune).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'fr'));
    select.textContent = '';
    select.appendChild(el('option', { value: '', text: `Toutes les communes (${communes.length})` }));
    communes.forEach((n) => select.appendChild(el('option', { value: n, text: n })));
    const has = communes.length > 0;
    const prev = document.querySelector('#es-commune-precedente');
    const next = document.querySelector('#es-commune-suivante');
    if (prev) prev.disabled = !has;
    if (next) next.disabled = !has;
  }

  function allerVersCommune(decalage) {
    const select = document.querySelector('#es-commune');
    if (!select || !select.options || select.options.length <= 1) return;
    let i = select.selectedIndex < 0 ? 0 : select.selectedIndex;
    i += decalage;
    if (i < 1) i = select.options.length - 1;
    if (i >= select.options.length) i = 1;
    select.selectedIndex = i;
    select.dispatchEvent(new Event('change'));
  }

  function centerOnCommune(communeName) {
    if (!communeName) return;
    const items = state.rawItems.filter((it) => it.commune === communeName && !it.approx);
    const list = items.length ? items : state.rawItems.filter((it) => it.commune === communeName);
    if (!list.length) return;
    const lon = list.reduce((s, it) => s + it.center.lon, 0) / list.length;
    const lat = list.reduce((s, it) => s + it.center.lat, 0) / list.length;
    try { state.sdk.Map.setMapCenter({ lonLat: { lon, lat }, zoomLevel: 14 }); } catch (e) { console.warn(`${SCRIPT_NAME}: recentrage impossible`, e); }
  }

  function applyFilters() {
    const checkedTypes = new Set(Array.from(document.querySelectorAll('.es-type-cb')).filter((cb) => cb.checked).map((cb) => cb.dataset.type));
    const communeSelect = document.querySelector('#es-commune');
    const communeValue = communeSelect ? communeSelect.value : '';
    const searchInput = document.querySelector('#es-search');
    const searchValue = searchInput ? normName(searchInput.value) : '';
    state.features = state.rawItems.filter((it) => {
      if (!checkedTypes.has(it.type)) return false; // aucun type coché = aucun établissement
      if (communeValue && it.commune !== communeValue) return false;
      if (searchValue && !normName(it.name).includes(searchValue)) return false;
      return true;
    });
    renderList();
  }

  // ---------------------------------------------------------------------
  // Liste
  // ---------------------------------------------------------------------
  function btn(act, id, text, title, extra) {
    const b = el('button', { class: `es-item-btn${extra ? ` ${extra}` : ''}`, title, text });
    b.dataset.act = act;
    b.dataset.id = id;
    return b;
  }

  function renderList() {
    const list = document.querySelector('#es-list');
    if (!list) return;
    list.textContent = '';
    if (state.features.length === 0) {
      list.appendChild(el('em', { text: state.rawItems.length === 0 ? 'Aucune donnée chargée.' : 'Aucun établissement ne correspond aux filtres.' }));
      updateProgress();
      return;
    }
    const hideDone = document.querySelector('#es-hide-done')?.checked;
    const visible = state.features.filter((it) => !(hideDone && (it.status === 'created' || it.status === 'skipped') && state.schoolZoneDone.has(it.stableId)));
    if (visible.length === 0) {
      list.appendChild(el('em', { text: 'Tous les établissements visibles sont déjà traités. 🎉' }));
      updateProgress();
      return;
    }
    visible.slice(0, RENDER_MAX).forEach((it) => {
      const isCreated = it.status === 'created';
      const isSkipped = it.status === 'skipped';
      const isPrepared = it.status === 'prepared';
      const isError = it.status === 'error';
      const isDone = isCreated || isSkipped;
      const zoneDone = state.schoolZoneDone.has(it.stableId);
      const partial = isDone && !zoneDone;
      let cls = 'es-item';
      if (isPrepared) cls += ' is-prepared';
      else if (partial) cls += ' is-partial';
      else if (isDone) cls += ' is-done';
      else if (isError) cls += ' is-error';
      const badge = isCreated ? '✅' : isSkipped ? '⏭️' : isPrepared ? '🟡' : isError ? '⚠️' : '';
      const nameCls = `es-item-name${isDone && !partial ? ' is-strike' : ''}`;
      const label = `${badge ? `${badge} ` : ''}${it.name}${it.hasBuilding ? ' 🏢' : ''}${zoneDone ? ' 🚸' : ''}${it.approx ? ' 📍?' : ''}`;
      const sub = `— ${it.type}, ${it.commune} (${it.codePostal})${isPrepared ? ' · à enregistrer dans WME' : ''}${it.approx ? ' · position approximative' : ''}`;
      const row = el('div', { class: cls, title: partial ? 'Place traitée, mais zone scolaire 🚸 pas encore posée' : '' },
        el('span', { class: nameCls }, label, ' ', el('small', { text: sub })),
        btn('goto', it.id, '🎯', 'Aller et surligner'),
        btn('zone', it.id, zoneDone ? '✅🚸' : '🚸', zoneDone ? 'Zone scolaire posée — cliquer pour annuler' : 'Marquer la zone scolaire comme posée', zoneDone ? 'is-active' : ''));
      if (!isDone && !isPrepared) {
        row.appendChild(btn('preview', it.id, '🏢', 'Chercher et prévisualiser le bâtiment IGN'));
        row.appendChild(btn('prepare', it.id, '➕', 'Préparer cette Place (brouillon, à vérifier puis enregistrer)'));
        row.appendChild(btn('skip', it.id, '⏭️', 'Marquer comme déjà présent dans WME (ne crée rien)'));
      }
      if (isDone || isPrepared) row.appendChild(btn('undo', it.id, '↩️', isPrepared ? 'Oublier la préparation (n’annule pas le brouillon dans WME : Ctrl+Z)' : 'Annuler ce statut'));
      list.appendChild(row);
    });
    if (visible.length > RENDER_MAX) list.appendChild(el('em', { text: `… ${visible.length - RENDER_MAX} autres : choisis une commune ou utilise la recherche.` }));
    updateProgress();
  }

  async function onListClick(e) {
    const target = e.target.closest ? e.target.closest('button[data-act]') : null;
    if (!target) return;
    const item = state.rawItems.find((f) => f.id === target.dataset.id);
    if (!item) return;
    switch (target.dataset.act) {
      case 'goto': highlightAndGoTo(item); break;
      case 'zone': {
        highlightAndGoTo(item);
        toggleSchoolZoneDone(item);
        setStatus(`🚸 Zone scolaire ${state.schoolZoneDone.has(item.stableId) ? 'marquée posée' : 'remise en attente'} : ${item.name}.`);
        renderList();
        break;
      }
      case 'preview': {
        if (state.busy) return;
        setStatus(`Recherche du bâtiment pour ${item.name}...`);
        const geom = await fetchBuildingGeometry(item.center);
        if (geom) { item.geometry = geom; item.hasBuilding = true; setStatus(`🏢 Bâtiment trouvé pour ${item.name}, affiché en surbrillance.`, 'ok'); }
        else setStatus(`Aucun bâtiment IGN fiable trouvé pour ${item.name} — un point sera utilisé.`, 'warn');
        highlightAndGoTo(item);
        renderList();
        break;
      }
      case 'prepare': await prepareOne(item); break;
      case 'skip': markDone(item, 'skipped'); setStatus(`⏭️ Marqué comme déjà présent : ${item.name}.`); renderList(); break;
      case 'undo': unmarkDone(item); setStatus(`↩️ Statut annulé pour : ${item.name}.`); renderList(); break;
      default: break;
    }
  }

  function updateProgress() {
    const bloc = document.querySelector('#es-progress-bloc');
    if (!bloc) return;
    bloc.textContent = '';
    const total = state.features.length;
    if (!total) return;
    const created = state.features.filter((f) => f.status === 'created').length;
    const skipped = state.features.filter((f) => f.status === 'skipped').length;
    const prepared = state.features.filter((f) => f.status === 'prepared').length;
    const errors = state.features.filter((f) => f.status === 'error').length;
    const zones = state.features.filter((f) => state.schoolZoneDone.has(f.stableId)).length;
    const done = created + skipped;
    const pctPlaces = Math.round((done / total) * 1000) / 10;
    const pctZones = Math.round((zones / total) * 1000) / 10;
    bloc.appendChild(el('div', { class: 'es-progress-row' }, el('span', { text: '🏫 Places enregistrées / déjà présentes' }), el('span', { class: 'es-progress-pct', text: `${pctPlaces}% (${done}/${total})` })));
    bloc.appendChild(barreProgression(pctPlaces));
    bloc.appendChild(el('div', { class: 'es-progress-row', style: 'margin-top:8px;' }, el('span', { text: '🚸 Zones scolaires posées' }), el('span', { class: 'es-progress-pct', text: `${pctZones}% (${zones}/${total})` })));
    bloc.appendChild(barreProgression(pctZones));
    if (prepared) bloc.appendChild(el('div', { class: 'es-pending-note', text: `🟡 ${prepared} lieu préparé, pas encore enregistré dans WME` }));
    if (errors) bloc.appendChild(el('div', { class: 'es-error-note', text: `⚠️ ${errors} en erreur` }));
  }

  function highlightAndGoTo(item) {
    item.navAt = Date.now();
    try {
      try { state.sdk.Map.removeAllFeaturesFromLayer({ layerName: HIGHLIGHT_LAYER }); } catch (e) { /* ignore */ }
      state.sdk.Map.addFeaturesToLayer({ layerName: HIGHLIGHT_LAYER, features: [{ id: 'current-school-highlight', type: 'Feature', properties: {}, geometry: item.geometry }] });
    } catch (e) { console.warn(`${SCRIPT_NAME}: surbrillance impossible`, e); }
    try { state.sdk.Map.setMapCenter({ lonLat: item.center, zoomLevel: 18 }); } catch (e) { console.warn(`${SCRIPT_NAME}: recentrage impossible`, e); }
  }

  // ---------------------------------------------------------------------
  // La zone est-elle chargée dans WME ? (condition pour contrôler les doublons)
  // ---------------------------------------------------------------------
  function readBounds() {
    try {
      const ext = state.sdk.Map.getMapExtent();
      if (Array.isArray(ext) && ext.length === 4 && ext.every(Number.isFinite) && ext[2] > ext[0] && ext[3] > ext[1]) return ext;
    } catch (e) { /* ignore */ }
    return null;
  }

  async function hasRoadNear(pt, radiusM) {
    const segs = (await DM().Segments.getAll()) || [];
    const pad = radiusM / 70000;
    for (const seg of segs) {
      const c = seg && seg.geometry && seg.geometry.coordinates;
      if (!c || c.length < 2) continue;
      let w = Infinity; let s = Infinity; let e = -Infinity; let n = -Infinity;
      for (const p of c) { if (p[0] < w) w = p[0]; if (p[0] > e) e = p[0]; if (p[1] < s) s = p[1]; if (p[1] > n) n = p[1]; }
      if (pt[0] < w - pad || pt[0] > e + pad || pt[1] < s - pad || pt[1] > n + pad) continue;
      if (nearestOnPolyline(pt, c) <= radiusM) return true;
    }
    return false;
  }

  // { ok:true } ou { ok:false, move:bool, msg }
  async function zoneStatus(item) {
    const pt = [item.center.lon, item.center.lat];
    const b = readBounds();
    let zoom = null;
    try { zoom = state.sdk.Map.getZoomLevel(); } catch (e) { zoom = null; }
    if (!b || !inBounds(pt, b) || (zoom != null && zoom < MIN_ZOOM)) {
      return { ok: false, move: true, msg: `📍 « ${item.name} » n'est pas à l'écran à un zoom suffisant : je t'y emmène.\nAttends que WME charge la zone (quelques secondes), puis clique de nouveau sur ➕.` };
    }
    if (Date.now() - (item.navAt || 0) < NAV_SETTLE_MS) {
      return { ok: false, move: false, msg: '⏳ Laisse à WME quelques secondes pour charger la zone, puis clique de nouveau sur ➕.' };
    }
    if (!(await hasRoadNear(pt, ROAD_RADIUS_M))) {
      return { ok: false, move: false, msg: '⏳ Aucune route chargée autour de cet établissement : la zone n’est pas encore chargée. Patiente puis clique de nouveau sur ➕ (rien n’est créé à l’aveugle).' };
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------------
  // Doublons avec l'existant (lieux WME chargés, brouillons compris)
  // ---------------------------------------------------------------------
  async function findNearbyVenues(item) {
    const all = (await DM().Venues.getAll()) || [];
    const pt = [item.center.lon, item.center.lat];
    const out = [];
    for (const v of all) {
      if (!v || v.id == null) continue;
      if (item.venueId && String(v.id) === String(item.venueId)) continue;
      const c = centroidOf(v.geometry);
      if (!c) continue;
      const d = distM(pt, c);
      if (d > DUP_RADIUS_M) continue;
      if (hasSchoolCategory(v) || nameSimilar(v.name, item.name)) out.push({ id: String(v.id), name: v.name || '(sans nom)', dist: d, center: c, school: hasSchoolCategory(v), draft: isTempId(v.id) });
    }
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }

  function hideCandidates() {
    const box = document.querySelector('#es-cands');
    if (box) { box.hidden = true; box.textContent = ''; }
  }

  function showCandidates(item, dups) {
    const box = document.querySelector('#es-cands');
    if (!box) return;
    box.textContent = '';
    box.hidden = false;
    box.appendChild(el('div', { class: 'es-cands__title', text: `⚠️ ${dups.length} lieu(x) déjà dans WME à moins de ${DUP_RADIUS_M} m de « ${item.name} ». Rien n'a été créé.` }));
    dups.slice(0, 6).forEach((d) => {
      const go = el('button', { class: 'es-item-btn', title: 'Aller voir ce lieu', text: '🎯' });
      go.addEventListener('click', () => { try { state.sdk.Map.setMapCenter({ lonLat: { lon: d.center[0], lat: d.center[1] }, zoomLevel: 19 }); } catch (e) { /* ignore */ } });
      box.appendChild(el('div', { class: 'es-cand' }, el('span', { text: `${d.draft ? '✏️ (brouillon) ' : ''}${d.name} — ${Math.round(d.dist)} m${d.school ? ' · catégorie école' : ''}` }), go));
    });
    const same = el('button', { text: '⏭️ C’est déjà dans WME : marquer comme traité' });
    same.addEventListener('click', () => { markDone(item, 'skipped'); hideCandidates(); setStatus(`⏭️ Marqué comme déjà présent : ${item.name}.`); renderList(); });
    const anyway = el('button', { style: 'background:#6b7280;', text: '➕ Ce n’est pas le même lieu : créer quand même' });
    anyway.addEventListener('click', () => { item.forceDup = true; hideCandidates(); prepareOne(item); });
    const close = el('button', { style: 'background:#9ca3af;', text: 'Fermer' });
    close.addEventListener('click', hideCandidates);
    box.appendChild(el('div', { class: 'es-cands__actions' }, same, anyway, close));
    setStatus('⚠️ Doublon possible : choisis dans l’encadré ci-dessous.', 'warn');
  }

  // ---------------------------------------------------------------------
  // Adresse : rue lue sur les segments voisins, JAMAIS créée par le script
  // ---------------------------------------------------------------------
  function parseAddressText(adresseText) {
    const text = (adresseText || '').trim();
    const m = text.match(/^(\d+\s*(?:bis|ter|quater)?)\s+(.+)$/i);
    if (m) return { houseNumber: m[1].replace(/\s+/g, ''), streetName: m[2].trim() };
    return { houseNumber: '', streetName: text };
  }

  async function findStreetId(item) {
    const { streetName } = parseAddressText(item.adresse);
    if (!streetName) return null;
    const pt = [item.center.lon, item.center.lat];
    const segs = (await DM().Segments.getAll()) || [];
    const near = [];
    const pad = ADDRESS_RADIUS_M / 70000;
    for (const seg of segs) {
      const c = seg && seg.geometry && seg.geometry.coordinates;
      if (!c || c.length < 2) continue;
      let w = Infinity; let s = Infinity; let e = -Infinity; let n = -Infinity;
      for (const p of c) { if (p[0] < w) w = p[0]; if (p[0] > e) e = p[0]; if (p[1] < s) s = p[1]; if (p[1] > n) n = p[1]; }
      if (pt[0] < w - pad || pt[0] > e + pad || pt[1] < s - pad || pt[1] > n + pad) continue;
      const d = nearestOnPolyline(pt, c);
      if (d <= ADDRESS_RADIUS_M) near.push({ id: seg.id, d });
    }
    near.sort((a, b) => a.d - b.d);
    for (const s of near.slice(0, 30)) {
      let a = null;
      try { a = await DM().Segments.getAddress({ segmentId: s.id }); } catch (e) { a = null; }
      if (!a || !a.street || a.street.id == null || !a.city) continue;
      if (normName(a.street.name) === normName(streetName) && normName(a.city.name) === normName(item.commune)) return a.street.id;
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Préparation d'UN lieu (brouillon) — jamais d'enregistrement
  // ---------------------------------------------------------------------
  function extractVenueId(venue) {
    if (venue === null || venue === undefined) return null;
    if (typeof venue === 'number' || typeof venue === 'string') return String(venue);
    if (typeof venue === 'object' && venue.id !== undefined) return String(venue.id);
    return null;
  }

  async function applyLock(venueId, warnings) {
    const wanted = state.settings.lock;
    if (wanted === 'none') return;
    let rank = null;
    try { const ui = await state.sdk.State.getUserInfo(); rank = ui && Number.isFinite(ui.rank) ? ui.rank : null; } catch (e) { rank = null; }
    if (rank === null) { warnings.push('Verrou non posé : ton rang d’éditeur est illisible.'); return; }
    const target = Math.min(Number(wanted) - 1, rank);
    try { await DM().Venues.updateVenue({ venueId, lockRank: target }); } catch (e) { warnings.push(`Verrou non posé : ${e.message}`); return; }
    try {
      const v = await DM().Venues.getById({ venueId });
      if (v && Number.isFinite(v.lockRank) && v.lockRank !== target) warnings.push(`Verrou différent de celui demandé (lu : niveau ${v.lockRank + 1}, voulu : ${target + 1}).`);
    } catch (e) { /* lecture de contrôle indisponible */ }
    if (target < Number(wanted) - 1) warnings.push(`Verrou plafonné à ton rang (niveau ${target + 1} au lieu de ${wanted}).`);
  }

  async function applyAddress(venueId, item, warnings) {
    const { houseNumber } = parseAddressText(item.adresse);
    const desc = [item.adresse, item.codePostal, item.commune].filter(Boolean).join(', ');
    const fallback = async (why) => {
      warnings.push(`${why} Adresse écrite en description : à reporter toi-même.`);
      if (!desc) return;
      try { await DM().Venues.updateVenue({ venueId, description: desc }); } catch (e) { warnings.push(`Description non écrite : ${e.message}`); }
    };
    if (!item.adresse) return fallback('Pas d’adresse dans l’annuaire.');
    let streetId = null;
    try { streetId = await findStreetId(item); } catch (e) { streetId = null; }
    if (streetId == null) return fallback(`Rue « ${parseAddressText(item.adresse).streetName} » introuvable à proximité dans ${item.commune} (le script ne crée jamais de rue).`);
    try {
      await DM().Venues.updateAddress({ venueId, houseNumber, streetId });
    } catch (e) { return fallback(`Adresse refusée par WME (${e.message}).`); }
    try {
      const a = await DM().Venues.getAddress({ venueId });
      if (a && a.street && a.street.id !== streetId) return fallback('L’adresse relue ne correspond pas à la rue demandée.');
    } catch (e) { /* lecture de contrôle indisponible */ }
    return null;
  }

  async function prepareOne(item) {
    if (state.busy) { setStatus('⏳ Une opération est déjà en cours.', 'warn'); return; }
    state.busy = true;
    let venueId = null;
    try {
      if (!state.forcedCategoryId) { setStatus('⚠️ Aucune catégorie « École » détectée : préparation impossible.', 'warn'); return; }

      // 1. Un seul brouillon à la fois
      await reconcile();
      const other = state.rawItems.find((f) => f.status === 'prepared' && f !== item);
      if (other) {
        renderList();
        setStatus(`⛔ « ${other.name} » est préparé mais pas encore enregistré.\nVérifie-le puis clique sur « Enregistrer » dans WME (ou annule-le avec Ctrl+Z puis ↩️) avant d'en préparer un autre.`, 'warn');
        return;
      }

      // 2. La zone doit être chargée pour contrôler les doublons
      const zs = await zoneStatus(item);
      if (!zs.ok) {
        if (zs.move) highlightAndGoTo(item);
        setStatus(zs.msg, 'warn');
        return;
      }

      // 3. Garde-fous sur la donnée
      if (!isSchoolType(item.type) && !window.confirm(`« ${item.name} » est de type « ${item.type} » : ce n'est ni une école, ni un collège, ni un lycée.\nPréparer quand même un lieu « École » ?`)) return;
      if (item.approx && !window.confirm(`La position de « ${item.name} » est APPROXIMATIVE dans l'annuaire (centre de la commune).\nLe lieu sera préparé au mauvais endroit : tu devras le déplacer à la main.\nContinuer ?`)) return;

      // 4. Contrôle des doublons
      const dups = await findNearbyVenues(item);
      if (dups.length && !item.forceDup) { showCandidates(item, dups); return; }
      item.knownIds = new Set(dups.map((d) => d.id));

      // 5. Géométrie (point, ou contour proposé par l'option)
      let geometry = item.geometry;
      if (state.settings.building && !item.approx) {
        setStatus(`Recherche du bâtiment pour ${item.name}...`);
        const g = await fetchBuildingGeometry(item.center);
        if (g) { geometry = g; item.geometry = g; item.hasBuilding = true; }
      }

      // 6. Création du brouillon (aucun enregistrement)
      const venue = await DM().Venues.addVenue({ category: state.forcedCategoryId, geometry, name: item.name });
      venueId = extractVenueId(venue);
      if (venueId === null) throw new Error("addVenue n'a pas renvoyé d'identifiant — vérifie dans WME (Ctrl+Z si un lieu est apparu).");

      const warnings = [];
      try {
        await DM().Venues.updateVenue({ venueId, name: item.name });
        const v = await DM().Venues.getById({ venueId });
        if (v && typeof v.name === 'string' && v.name !== item.name) warnings.push(`Nom lu « ${v.name} » au lieu de « ${item.name} » : à corriger.`);
      } catch (e) { warnings.push(`Nom non confirmé : ${e.message}`); }
      await applyAddress(venueId, item, warnings);
      await applyLock(venueId, warnings);

      item.status = 'prepared';
      item.venueId = venueId;
      item.preparedAt = Date.now();
      item.navAt = Date.now();
      highlightAndGoTo(item);
      try { state.sdk.Editing.setSelection({ selection: { objectType: 'venue', ids: [venueId] } }); } catch (e) { /* sélection facultative */ }
      setStatus(`🟡 Lieu préparé : ${item.name}${item.hasBuilding ? ' (contour de bâtiment)' : ' (point)'}.\nVérifie le nom, la position, l'adresse et le contour, puis clique sur « Enregistrer » dans WME. Le script n'enregistre jamais.${warnings.length ? `\n\n⚠️ À contrôler :\n- ${warnings.join('\n- ')}` : ''}`, warnings.length ? 'warn' : 'ok');
    } catch (e) {
      console.error(`${SCRIPT_NAME}: échec de préparation`, item, e);
      let rollback = '';
      if (venueId !== null) {
        try { await DM().Venues.deleteVenue({ venueId }); rollback = ' Le brouillon créé a été retiré.'; } catch (e2) { rollback = ' ⚠️ Le brouillon créé n’a pas pu être retiré : supprime-le toi-même (Ctrl+Z).'; }
      }
      item.status = 'error';
      item.venueId = null;
      setStatus(`❌ Échec pour ${item.name} : ${e.message}.${rollback}`, 'err');
    } finally {
      item.forceDup = false;
      state.busy = false;
      renderList();
    }
  }

  // ---------------------------------------------------------------------
  // Suivi honnête : un lieu n'est « créé » que lorsqu'on le retrouve ENREGISTRÉ dans WME.
  // Lecture seule, uniquement quand la zone du lieu est affichée et chargée.
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
        const b = readBounds();
        let zoom = null;
        try { zoom = state.sdk.Map.getZoomLevel(); } catch (e) { zoom = null; }
        if (!b || !inBounds(pt, b) || (zoom != null && zoom < MIN_ZOOM) || !(await hasRoadNear(pt, ROAD_RADIUS_M))) continue; // zone non visible : on ne conclut pas

        let draft = null;
        try { draft = await DM().Venues.getById({ venueId: it.venueId }); } catch (e) { draft = null; }
        if (draft) continue; // toujours en brouillon

        // Le brouillon n'existe plus : enregistré (nouvel identifiant définitif) ou annulé ?
        const all = (await DM().Venues.getAll()) || [];
        const known = it.knownIds || new Set();
        const saved = all.find((v) => v && v.id != null && !isTempId(v.id) && !known.has(String(v.id)) && hasSchoolCategory(v)
          && nameSimilar(v.name, it.name) && (centroidOf(v.geometry) ? distM(pt, centroidOf(v.geometry)) <= DUP_RADIUS_M : false));
        if (saved) { markDone(it, 'created'); changed = true; setStatus(`✅ Enregistré dans WME : ${it.name}.`, 'ok'); }
        else { it.status = 'pending'; it.venueId = null; changed = true; setStatus(`↩️ Le brouillon de « ${it.name} » n'existe plus (annulé ou supprimé) : remis en attente.`, 'warn'); }
      }
    } catch (e) {
      console.warn(`${SCRIPT_NAME}: suivi impossible`, e);
    } finally {
      state.reconciling = false;
    }
    return changed;
  }

  bootstrap();
})();
