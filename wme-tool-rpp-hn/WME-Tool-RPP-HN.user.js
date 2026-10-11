// ==UserScript==
// @name         WME Tool RPP&HN
// @namespace    https://github.com/Romino57/wme-scripts
// @version      1.0.0
// @description  Convertit un RPP (Residential Place Point) en numéro de maison (HN), ou un HN en RPP, adresse par adresse (contrôle des doublons, de la rue et de la ville). Repère et supprime les RPP qui doublent un HN. Plafond de 150 éditions par heure.
// @author       Romino57
// @license      MIT
// @match        https://www.waze.com/*/editor*
// @match        https://www.waze.com/editor*
// @match        https://beta.waze.com/*
// @exclude      https://www.waze.com/*user/editor/*
// @grant        unsafeWindow
// @run-at       document-idle
// @downloadURL  https://update.greasyfork.org/scripts/595817/WME%20Tool%20RPPHN.user.js
// @updateURL    https://update.greasyfork.org/scripts/595817/WME%20Tool%20RPPHN.meta.js
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // PRINCIPE
  // ---------------------------------------------------------------------
  //  🔀 RPP → HN   : UN RPP sélectionné dans WME est converti en numéro de maison, sur le
  //                  segment le plus proche qui porte la MÊME rue ET la MÊME ville (distance
  //                  maximale MAX_MATCH_M). Refusé si ce numéro existe déjà sur le segment.
  //  🔄 HN → RPP   : UN HN choisi d'un clic sur la carte est converti en RPP (même numéro, même
  //                  rue, même ville, point d'entrée posé sur la route, verrou 1 au minimum). Refusé si un RPP
  //                  identique existe déjà à proximité. L'adresse du RPP créé est relue : si la
  //                  rue ou la ville n'est pas conservée, le RPP créé est retiré et le HN reste.
  //  🧹 Doublons   : liste les RPP de l'écran qui doublent un HN (même numéro, même rue, même
  //                  ville, à moins de DUP_RADIUS_M). La liste est montrée avant toute
  //                  suppression ; rien n'est supprimé sans clic et confirmation.
  //
  //  Plafond : 150 éditions scriptées par heure glissante (compteur horodaté conservé dans le
  //  navigateur, reste affiché, non modifiable par réglage).
  //  Aucune écriture au chargement, à la sélection ni sur évènement. Le script n'enregistre
  //  jamais : c'est l'éditeur qui clique sur « Enregistrer » dans WME.
  //  Aucune donnée n'est envoyée hors de WME.
  // ---------------------------------------------------------------------

  const SCRIPT_NAME = 'WME Tool RPP&HN';
  const VERSION_SCRIPT = '1.0.0';
  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const QUOTA_MAX = 150;                  // éditions scriptées par heure glissante
  const HOUR_MS = 3600 * 1000;
  const LEDGER_KEY = 'wme-rpp-hn:ledger';
  const COST_DELETE = 1;                  // suppression d'un RPP
  const COST_RPP_TO_HN = 2;               // création du HN + suppression du RPP
  const COST_HN_TO_RPP = 5;               // création du RPP, adresse, point d'entrée, verrou, suppression du HN
  const MAX_MATCH_M = 50;                 // RPP → HN : distance maximale au segment retenu
  const DUP_RADIUS_M = 60;                // doublon : HN et RPP du même numéro à moins de ...
  const PICK_RADIUS_M = 30;               // HN → RPP : rayon de recherche autour du clic
  const SCAN_MAX_VENUES = 600;            // recherche de doublons : au-delà, il faut zoomer
  const SCAN_MAX_SEGMENTS = 900;
  const LIST_MAX = 150;
  // Verrou minimal des RPP créés (jamais en dessous du verrou du segment).
  const RPP_MIN_LOCK = 1;
  const PICK_LAYER = 'wme-rpp-hn-pick';

  const state = {
    sdk: null,
    busy: false,
    picking: false,
    pickHandler: null,
    picked: null,       // HN choisi : { id, number, geometry, segmentId, street, city }
    dups: [],           // doublons trouvés
    memLedger: [],
  };

  // ---------------------------------------------------------------------
  // Outils
  // ---------------------------------------------------------------------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => (s == null ? '' : String(s)).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/œ/gi, 'oe').replace(/\s+/g, ' ').trim().toLowerCase();
  const normNum = (s) => norm(s).replace(/\s+/g, '');
  const fmtInt = (n) => Math.round(n).toLocaleString('fr-FR');

  function toMeters(p, ref) {
    const k = Math.cos((ref[1] * Math.PI) / 180);
    return [(p[0] - ref[0]) * 111320 * k, (p[1] - ref[1]) * 110540];
  }

  function distM(a, b) {
    const [x, y] = toMeters(b, a);
    return Math.hypot(x, y);
  }

  // Point le plus proche d'une polyligne : { dist (m), point [lon, lat] }.
  function nearestOnPolyline(pt, coords) {
    let best = { dist: Infinity, point: null };
    const P = [0, 0];
    for (let i = 0; i < coords.length - 1; i++) {
      const a = toMeters(coords[i], pt);
      const b = toMeters(coords[i + 1], pt);
      const dx = b[0] - a[0]; const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : ((P[0] - a[0]) * dx + (P[1] - a[1]) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = a[0] + t * dx; const py = a[1] + t * dy;
      const d = Math.hypot(px, py);
      if (d < best.dist) {
        best = { dist: d, point: [coords[i][0] + t * (coords[i + 1][0] - coords[i][0]), coords[i][1] + t * (coords[i + 1][1] - coords[i][1])] };
      }
    }
    return best;
  }

  function pointOf(geometry) {
    if (!geometry || !geometry.coordinates) return null;
    if (geometry.type === 'Point') return [geometry.coordinates[0], geometry.coordinates[1]];
    return null;
  }

  function readBounds() {
    try {
      const ext = state.sdk.Map.getMapExtent();
      if (Array.isArray(ext) && ext.length === 4 && ext.every(Number.isFinite) && ext[2] > ext[0] && ext[3] > ext[1]) return ext;
    } catch (e) { console.warn(`${SCRIPT_NAME}: étendue de la carte illisible`, e); }
    return null;
  }

  const inBounds = (pt, b) => pt[0] >= b[0] && pt[0] <= b[2] && pt[1] >= b[1] && pt[1] <= b[3];

  // ---------------------------------------------------------------------
  // Plafond horaire (150 éditions scriptées par heure glissante)
  // ---------------------------------------------------------------------
  function readLedger() {
    const now = Date.now();
    let arr = null;
    try { arr = JSON.parse(localStorage.getItem(LEDGER_KEY) || '[]'); } catch (e) { arr = null; }
    if (!Array.isArray(arr)) arr = state.memLedger;
    return arr.filter((t) => Number.isFinite(t) && now - t < HOUR_MS);
  }

  function writeLedger(arr) {
    state.memLedger = arr;
    try { localStorage.setItem(LEDGER_KEY, JSON.stringify(arr)); } catch (e) { /* mémoire seule */ }
  }

  const quotaUsed = () => readLedger().length;
  const quotaRemaining = () => Math.max(0, QUOTA_MAX - quotaUsed());

  function recordEdit() {
    const arr = readLedger();
    arr.push(Date.now());
    writeLedger(arr);
    refreshQuota();
  }

  // Toute écriture passe par ici. `force` : retour arrière d'une opération déjà commencée (toujours permis).
  async function write(fn, force) {
    if (!force && quotaRemaining() < 1) throw Object.assign(new Error('plafond horaire atteint'), { quota: true });
    const result = await fn();
    recordEdit();
    return result;
  }

  function refreshQuota() {
    const el = document.querySelector('#rh-quota');
    if (!el) return;
    const arr = readLedger();
    const used = arr.length;
    const left = Math.max(0, QUOTA_MAX - used);
    const oldest = arr.length ? Math.min(...arr) : null;
    el.querySelector('.rh-quota__text').textContent = `${used} / ${QUOTA_MAX} éditions scriptées sur la dernière heure — il en reste ${left}`;
    el.querySelector('.rh-quota__bar > div').style.width = `${Math.min(100, (used / QUOTA_MAX) * 100)}%`;
    el.classList.toggle('is-full', left === 0);
    const sub = el.querySelector('.rh-quota__sub');
    if (left === 0 && oldest) {
      const mins = Math.max(1, Math.ceil((oldest + HOUR_MS - Date.now()) / 60000));
      sub.textContent = `Plafond atteint : nouvelles éditions possibles dans ${mins} min.`;
    } else {
      sub.textContent = 'Plafond de sécurité : il ne se règle pas.';
    }
  }

  // ---------------------------------------------------------------------
  // Lecture du modèle de données (SDK officiel, appels attendus avec await)
  // ---------------------------------------------------------------------
  const DM = () => state.sdk.DataModel;

  function simplifyAddress(a) {
    if (!a) return { number: '', streetId: null, street: '', cityId: null, city: '' };
    return {
      number: a.houseNumber == null ? '' : String(a.houseNumber),
      streetId: a.street && a.street.id != null ? a.street.id : null,
      street: a.street && a.street.name ? a.street.name : '',
      cityId: a.city && a.city.id != null ? a.city.id : null,
      city: a.city && a.city.name ? a.city.name : '',
    };
  }

  const sameStreet = (a, b) => (a.street && b.street && norm(a.street) === norm(b.street)) || (a.streetId != null && a.streetId === b.streetId);

  function sameCity(a, b) {
    if (a.cityId != null && b.cityId != null) return a.cityId === b.cityId;
    return norm(a.city) === norm(b.city);
  }

  const label = (a) => `${a.number ? `${a.number} ` : ''}${a.street || '(sans rue)'}${a.city ? `, ${a.city}` : ' (sans ville)'}`;

  async function segmentAddress(segmentId, cache) {
    if (cache && cache.has(segmentId)) return cache.get(segmentId);
    let addr = null;
    try { addr = simplifyAddress(await DM().Segments.getAddress({ segmentId })); } catch (e) { addr = null; }
    if (cache) cache.set(segmentId, addr);
    return addr;
  }

  // Un RPP avec photo est ignoré. Si le SDK n'expose pas le champ, on ne touche à rien (null = inconnu).
  function photoState(v) {
    if (!v || !Array.isArray(v.images)) return null;
    return v.images.length > 0;
  }

  // ---------------------------------------------------------------------
  // Recherche d'un segment pour un RPP (même rue ET même ville, distance bornée)
  // ---------------------------------------------------------------------
  async function findSegmentFor(addr, pt) {
    const all = (await DM().Segments.getAll()) || [];
    const near = [];
    const pad = 0.0009;
    for (const seg of all) {
      const c = seg && seg.geometry && seg.geometry.coordinates;
      if (!c || c.length < 2) continue;
      let w = Infinity; let s = Infinity; let e = -Infinity; let n = -Infinity;
      for (const p of c) { if (p[0] < w) w = p[0]; if (p[0] > e) e = p[0]; if (p[1] < s) s = p[1]; if (p[1] > n) n = p[1]; }
      if (pt[0] < w - pad || pt[0] > e + pad || pt[1] < s - pad || pt[1] > n + pad) continue;
      const nr = nearestOnPolyline(pt, c);
      if (nr.dist <= MAX_MATCH_M) near.push({ seg, dist: nr.dist });
    }
    near.sort((x, y) => x.dist - y.dist);
    if (!near.length) return { error: `Aucun segment à moins de ${MAX_MATCH_M} m du RPP.` };
    const seen = [];
    const cache = new Map();
    for (const c of near) {
      const sa = await segmentAddress(c.seg.id, cache);
      if (!sa) continue;
      if (sameStreet(addr, sa) && sameCity(addr, sa)) return { seg: c.seg, addr: sa, dist: c.dist };
      seen.push(`${sa.street || '(sans rue)'}${sa.city ? `, ${sa.city}` : ''}`);
    }
    return { error: `Aucun segment à moins de ${MAX_MATCH_M} m ne porte la même rue ET la même ville (trouvé : ${[...new Set(seen)].slice(0, 3).join(' ; ') || 'rien de lisible'}).` };
  }

  // ---------------------------------------------------------------------
  // RPP → HN (un RPP sélectionné)
  // ---------------------------------------------------------------------
  async function readSelectedRpp() {
    let sel = null;
    try { sel = state.sdk.Editing.getSelection(); } catch (e) { /* ignore */ }
    if (!sel || sel.objectType !== 'venue' || !sel.ids || sel.ids.length !== 1) return { error: 'Sélectionnez UN SEUL RPP dans WME.' };
    const venueId = String(sel.ids[0]);
    const v = await DM().Venues.getById({ venueId });
    if (!v) return { error: 'Lieu sélectionné introuvable.' };
    if (!v.isResidential) return { error: 'Le lieu sélectionné n\'est pas un RPP.' };
    return { venueId, v };
  }

  async function onConvertRpp() {
    if (state.busy) return;
    setBusy(true);
    try {
      const r = await readSelectedRpp();
      if (r.error) { setStatus(`⚠️ ${r.error}`); return; }
      const { venueId, v } = r;
      const photo = photoState(v);
      if (photo === true) { setStatus('⚠️ Ce RPP porte au moins une photo : il est ignoré.'); return; }
      if (photo === null) { setStatus('⚠️ Impossible de vérifier si ce RPP porte des photos : par prudence, il est ignoré.'); return; }
      const pt = pointOf(v.geometry);
      if (!pt) { setStatus('❌ Position du RPP illisible.'); return; }
      const addr = simplifyAddress(await DM().Venues.getAddress({ venueId }));
      if (!addr.number) { setStatus('⚠️ Ce RPP n\'a pas de numéro : rien à convertir.'); return; }
      if (!addr.street) { setStatus('⚠️ Ce RPP n\'a pas de rue : rien à rattacher.'); return; }

      const found = await findSegmentFor(addr, pt);
      if (found.error) { setStatus(`⚠️ ${found.error} Le RPP est laissé tel quel.`); return; }

      const existing = (await DM().HouseNumbers.fetchHouseNumbers({ segmentIds: [found.seg.id] })) || [];
      if (existing.some((h) => normNum(h.number) === normNum(addr.number))) {
        setStatus(`⚠️ Le segment porte déjà un HN « ${addr.number} » : conversion refusée (doublon). Le RPP est laissé tel quel.`);
        return;
      }
      if (quotaRemaining() < COST_RPP_TO_HN) { setStatus(`⚠️ Plafond horaire : il reste ${quotaRemaining()} édition(s), il en faut ${COST_RPP_TO_HN}.`); return; }

      const ok = window.confirm(
        `Convertir ce RPP en numéro de maison ?\n\n${label(addr)}\nSegment retenu : ${found.addr.street}, ${found.addr.city || '(sans ville)'} — à ${Math.round(found.dist)} m.\n\n` +
        'Le HN est créé, puis le RPP est supprimé. Vérifiez avant d\'enregistrer.');
      if (!ok) return;

      let hnId = null;
      try {
        hnId = await write(() => DM().HouseNumbers.addHouseNumber({ number: addr.number, point: v.geometry, segmentId: found.seg.id }));
      } catch (e) {
        console.error(`${SCRIPT_NAME}: création du HN impossible`, e);
        setStatus(e && e.quota ? '⚠️ Plafond horaire atteint.' : '❌ Création du HN impossible (voir console) : le RPP est laissé tel quel.');
        return;
      }
      try {
        await write(() => DM().Venues.deleteVenue({ venueId }), true);
      } catch (e) {
        console.error(`${SCRIPT_NAME}: suppression du RPP impossible`, e);
        let undone = false;
        if (hnId != null) {
          try { await write(() => DM().HouseNumbers.deleteHouseNumber({ houseNumberId: hnId }), true); undone = true; } catch (e2) { console.error(e2); }
        }
        setStatus(undone
          ? '❌ Suppression du RPP impossible : le HN créé a été retiré, rien n\'a changé.'
          : '❌ Suppression du RPP impossible ET le HN créé n\'a pas pu être retiré : il existe maintenant un HN et un RPP au même endroit. Annulez avec Ctrl+Z.');
        return;
      }
      setStatus(`✅ RPP converti en HN : ${label(addr)}. Vérifiez puis Enregistrer dans WME.`);
    } catch (e) {
      console.error(`${SCRIPT_NAME}:`, e);
      setStatus('❌ Erreur inattendue (voir console).');
    } finally {
      setBusy(false);
      refreshSelection();
    }
  }

  // ---------------------------------------------------------------------
  // HN → RPP (un HN choisi sur la carte)
  // ---------------------------------------------------------------------
  function clickPosition(e) {
    if (e && e.lonLat) return [e.lonLat.lon, e.lonLat.lat];
    if (e && typeof e.lon === 'number') return [e.lon, e.lat];
    if (e && e.point && typeof e.point.lon === 'number') return [e.point.lon, e.point.lat];
    return null;
  }

  function ensurePickLayer() {
    try {
      state.sdk.Map.addLayer({
        layerName: PICK_LAYER, zIndex: 950,
        styleRules: [{ predicate: () => true, style: { pointRadius: 11, fillColor: '#7e57c2', fillOpacity: 0.35, strokeColor: '#4527a0', strokeWidth: 3 } }],
        styleContext: {},
      });
    } catch (e) { console.warn(`${SCRIPT_NAME}: calque de repérage`, e); }
  }

  function drawPicked() {
    try { state.sdk.Map.removeAllFeaturesFromLayer({ layerName: PICK_LAYER }); } catch (e) { /* ignore */ }
    if (!state.picked) return;
    try {
      state.sdk.Map.addFeaturesToLayer({ layerName: PICK_LAYER, features: [{ id: 'rh-picked', type: 'Feature', properties: {}, geometry: state.picked.geometry }] });
    } catch (e) { console.warn(`${SCRIPT_NAME}: affichage du HN choisi`, e); }
  }

  function stopPicking() {
    state.picking = false;
    if (state.pickHandler) {
      try { state.sdk.Events.off({ eventName: 'wme-map-mouse-click', eventHandler: state.pickHandler }); } catch (e) { /* ignore */ }
      state.pickHandler = null;
    }
    renderPicked();
  }

  function onPickStart() {
    if (state.busy || state.picking) return;
    state.picked = null;
    drawPicked();
    state.picking = true;
    state.pickHandler = onMapClickPick;
    try {
      state.sdk.Events.on({ eventName: 'wme-map-mouse-click', eventHandler: state.pickHandler });
    } catch (e) {
      console.error(`${SCRIPT_NAME}: écoute du clic carte impossible`, e);
      state.picking = false;
      state.pickHandler = null;
      setStatus('❌ Impossible d\'écouter les clics sur la carte (voir console).');
    }
    renderPicked();
  }

  async function onMapClickPick(e) {
    const pos = clickPosition(e);
    if (!pos) { setStatus('❌ Format de clic non reconnu (voir console).'); console.warn(`${SCRIPT_NAME}: clic non reconnu`, e); return; }
    stopPicking();
    setBusy(true);
    try {
      const all = (await DM().Segments.getAll()) || [];
      const ids = [];
      const pad = 0.0007;
      for (const seg of all) {
        const c = seg && seg.geometry && seg.geometry.coordinates;
        if (!c || c.length < 2) continue;
        let w = Infinity; let s = Infinity; let ea = -Infinity; let n = -Infinity;
        for (const p of c) { if (p[0] < w) w = p[0]; if (p[0] > ea) ea = p[0]; if (p[1] < s) s = p[1]; if (p[1] > n) n = p[1]; }
        if (pos[0] < w - pad || pos[0] > ea + pad || pos[1] < s - pad || pos[1] > n + pad) continue;
        if (nearestOnPolyline(pos, c).dist <= 80) ids.push(seg.id);
        if (ids.length >= 40) break;
      }
      if (!ids.length) { setStatus('⚠️ Aucun segment à proximité de ce clic.'); return; }
      const hns = (await DM().HouseNumbers.fetchHouseNumbers({ segmentIds: ids })) || [];
      let best = null;
      hns.forEach((h) => {
        const p = pointOf(h.geometry);
        if (!p) return;
        const d = distM(pos, p);
        if (d <= PICK_RADIUS_M && (!best || d < best.d)) best = { h, d };
      });
      if (!best) { setStatus(`⚠️ Aucun HN à moins de ${PICK_RADIUS_M} m de ce clic. Cliquez plus près du numéro.`); return; }
      const sa = await segmentAddress(best.h.segmentId, null);
      state.picked = {
        id: best.h.id, number: String(best.h.number), geometry: best.h.geometry, segmentId: best.h.segmentId,
        street: sa ? sa.street : '', city: sa ? sa.city : '', streetId: sa ? sa.streetId : null, cityId: sa ? sa.cityId : null,
      };
      drawPicked();
      setStatus('');
    } catch (err) {
      console.error(`${SCRIPT_NAME}: recherche du HN`, err);
      setStatus('❌ Lecture des HN impossible (voir console).');
    } finally {
      setBusy(false);
      renderPicked();
    }
  }

  async function onConvertHn() {
    const hn = state.picked;
    if (state.busy || !hn) return;
    setBusy(true);
    try {
      const seg = await DM().Segments.getById({ segmentId: hn.segmentId });
      const sa = await segmentAddress(hn.segmentId, null);
      const coords = seg && seg.geometry && seg.geometry.coordinates;
      const hp = pointOf(hn.geometry);
      if (!seg || !sa || !coords || !hp) { setStatus('❌ Segment du HN illisible.'); return; }
      if (!sa.street) { setStatus('⚠️ Le segment du HN n\'a pas de rue : conversion impossible.'); return; }
      const target = { number: hn.number, streetId: sa.streetId, street: sa.street, cityId: sa.cityId, city: sa.city };

      // Contrôle des doublons : un RPP identique existe-t-il déjà à proximité ?
      const venues = (await DM().Venues.getAll()) || [];
      for (const v of venues) {
        if (!v || !v.isResidential) continue;
        const p = pointOf(v.geometry);
        if (!p || distM(hp, p) > DUP_RADIUS_M) continue;
        const a = simplifyAddress(await DM().Venues.getAddress({ venueId: String(v.id) }));
        if (normNum(a.number) === normNum(target.number) && sameStreet(a, target) && sameCity(a, target)) {
          setStatus(`⚠️ Un RPP « ${label(a)} » existe déjà à ${Math.round(distM(hp, p))} m : conversion refusée (doublon). Le HN est laissé tel quel.`);
          return;
        }
      }
      if (quotaRemaining() < COST_HN_TO_RPP) { setStatus(`⚠️ Plafond horaire : il reste ${quotaRemaining()} édition(s), il en faut jusqu'à ${COST_HN_TO_RPP}.`); return; }

      const ok = window.confirm(
        `Convertir ce HN en RPP ?\n\n${label(target)}\n\n` +
        'Un RPP est créé au même point (point d\'entrée posé sur la route), son adresse est relue, puis le HN est supprimé. ' +
        'Si la rue ou la ville n\'est pas conservée, le RPP créé est retiré et le HN reste.');
      if (!ok) return;

      let venueId = null;
      const undoVenue = async () => {
        if (venueId == null) return false;
        try { await write(() => DM().Venues.deleteVenue({ venueId }), true); return true; } catch (e) { console.error(e); return false; }
      };
      try {
        venueId = String(await write(() => DM().Venues.addVenue({ category: 'RESIDENTIAL', geometry: hn.geometry })));
        await write(() => DM().Venues.updateAddress({ houseNumber: target.number, streetId: target.streetId, venueId }));
        const entry = nearestOnPolyline(hp, coords);
        await write(() => DM().Venues.replaceNavigationPoints({
          venueId, navigationPoints: [{ point: { type: 'Point', coordinates: entry.point }, isPrimary: true }],
        }));
        // Verrou : jamais en dessous de celui du segment, ni de RPP_MIN_LOCK.
        const segLock = [seg.lockRank, seg.fwdLockRank, seg.revLockRank].filter((n) => Number.isFinite(n));
        const wanted = Math.max(RPP_MIN_LOCK == null ? -Infinity : RPP_MIN_LOCK, segLock.length ? Math.max(...segLock) : -Infinity);
        let lockNote = '';
        if (Number.isFinite(wanted) && wanted > 0) {
          try { await write(() => DM().Venues.updateVenue({ venueId, lockRank: wanted })); lockNote = ` Verrou posé : ${wanted}.`; } catch (e) { console.warn(`${SCRIPT_NAME}: verrou non posé`, e); lockNote = ' ⚠️ Verrou non posé (à faire à la main).'; }
        }
        // Relecture : rue et ville du RPP créé.
        const created = simplifyAddress(await DM().Venues.getAddress({ venueId }));
        if (normNum(created.number) !== normNum(target.number) || !sameStreet(created, target) || !sameCity(created, target)) {
          const undone = await undoVenue();
          setStatus(`❌ L'adresse du RPP créé ne correspond pas (attendu « ${label(target)} », obtenu « ${label(created)} »). ` +
            `${undone ? 'Le RPP créé a été retiré, le HN est intact.' : 'Le RPP créé n\'a pas pu être retiré : annulez avec Ctrl+Z.'}`);
          return;
        }
        try {
          await write(() => DM().HouseNumbers.deleteHouseNumber({ houseNumberId: hn.id }), true);
        } catch (e) {
          console.error(`${SCRIPT_NAME}: suppression du HN impossible`, e);
          const undone = await undoVenue();
          setStatus(`❌ Suppression du HN impossible. ${undone ? 'Le RPP créé a été retiré, rien n\'a changé.' : 'Le RPP créé n\'a pas pu être retiré : il y a un HN et un RPP au même endroit, annulez avec Ctrl+Z.'}`);
          return;
        }
        state.picked = null;
        drawPicked();
        setStatus(`✅ HN converti en RPP : ${label(target)}.${lockNote} Vérifiez puis Enregistrer dans WME.`);
      } catch (e) {
        console.error(`${SCRIPT_NAME}: conversion HN → RPP`, e);
        const undone = await undoVenue();
        setStatus(e && e.quota
          ? `⚠️ Plafond horaire atteint en cours d'opération. ${undone ? 'Le RPP créé a été retiré, rien n\'a changé.' : ''}`
          : `❌ Échec de la conversion (voir console). ${venueId == null ? 'Rien n\'a été créé.' : (undone ? 'Le RPP créé a été retiré, le HN est intact.' : 'Le RPP créé n\'a pas pu être retiré : annulez avec Ctrl+Z.')}`);
      }
    } catch (e) {
      console.error(`${SCRIPT_NAME}:`, e);
      setStatus('❌ Erreur inattendue (voir console).');
    } finally {
      setBusy(false);
      renderPicked();
    }
  }

  // ---------------------------------------------------------------------
  // RPP qui doublent un HN (liste, puis suppression choisie)
  // ---------------------------------------------------------------------
  async function onScanDups() {
    if (state.busy) return;
    const b = readBounds();
    if (!b) { setStatus('❌ Étendue de la carte illisible : recherche annulée (rien n\'est visé).'); return; }
    setBusy(true);
    state.dups = [];
    renderDups();
    try {
      setStatus('⏳ Recherche des RPP qui doublent un HN…');
      const venues = ((await DM().Venues.getAll()) || []).filter((v) => v && v.isResidential);
      const cands = [];
      let withPhoto = 0; let unknown = 0;
      for (const v of venues) {
        const p = pointOf(v.geometry);
        if (!p || !inBounds(p, b)) continue;
        const ph = photoState(v);
        if (ph === true) { withPhoto++; continue; }
        if (ph === null) { unknown++; continue; }
        cands.push({ v, p });
      }
      if (unknown) { setStatus('⚠️ Le SDK n\'indique pas les photos des RPP : par prudence, aucun RPP n\'est proposé.'); return; }
      if (cands.length > SCAN_MAX_VENUES) { setStatus(`⚠️ ${fmtInt(cands.length)} RPP à l'écran : zoomez pour en viser moins de ${SCAN_MAX_VENUES}.`); return; }
      if (!cands.length) { setStatus('ℹ️ Aucun RPP à l\'écran.' + (withPhoto ? ` (${withPhoto} avec photo, ignoré(s))` : '')); return; }

      const pad = 0.0009;
      const segs = [];
      for (const seg of (await DM().Segments.getAll()) || []) {
        const c = seg && seg.geometry && seg.geometry.coordinates;
        if (!c || c.length < 2) continue;
        let w = Infinity; let s = Infinity; let e = -Infinity; let n = -Infinity;
        for (const q of c) { if (q[0] < w) w = q[0]; if (q[0] > e) e = q[0]; if (q[1] < s) s = q[1]; if (q[1] > n) n = q[1]; }
        if (e < b[0] - pad || w > b[2] + pad || n < b[1] - pad || s > b[3] + pad) continue;
        segs.push(seg.id);
      }
      if (segs.length > SCAN_MAX_SEGMENTS) { setStatus(`⚠️ ${fmtInt(segs.length)} segments à l'écran : zoomez pour en viser moins de ${SCAN_MAX_SEGMENTS}.`); return; }
      const hns = segs.length ? ((await DM().HouseNumbers.fetchHouseNumbers({ segmentIds: segs })) || []) : [];
      const cache = new Map();
      const found = [];
      for (const { v, p } of cands) {
        const addr = simplifyAddress(await DM().Venues.getAddress({ venueId: String(v.id) }));
        if (!addr.number || !addr.street) continue;
        for (const h of hns) {
          if (normNum(h.number) !== normNum(addr.number)) continue;
          const hp = pointOf(h.geometry);
          if (!hp) continue;
          const d = distM(p, hp);
          if (d > DUP_RADIUS_M) continue;
          const sa = await segmentAddress(h.segmentId, cache);
          if (!sa || !sameStreet(addr, sa) || !sameCity(addr, sa)) continue;
          found.push({ venueId: String(v.id), addr, d, p, checked: true });
          break;
        }
      }
      state.dups = found;
      setStatus(found.length
        ? `ℹ️ ${found.length} RPP doublent un HN (sur ${cands.length} RPP à l'écran${withPhoto ? `, ${withPhoto} avec photo ignoré(s)` : ''}). Vérifiez la liste.`
        : `✅ Aucun RPP ne double un HN (${cands.length} RPP examiné(s)).`);
    } catch (e) {
      console.error(`${SCRIPT_NAME}: recherche des doublons`, e);
      setStatus('❌ Recherche impossible (voir console).');
    } finally {
      setBusy(false);
      renderDups();
    }
  }

  async function onDeleteDups() {
    if (state.busy) return;
    const chosen = state.dups.filter((d) => d.checked);
    if (!chosen.length) { setStatus('⚠️ Aucun RPP coché.'); return; }
    const room = quotaRemaining() / COST_DELETE;
    const batch = chosen.slice(0, Math.floor(room));
    if (!batch.length) { setStatus('⚠️ Plafond horaire atteint : aucune suppression possible pour le moment.'); refreshQuota(); return; }
    const cut = batch.length < chosen.length ? `\n\nPlafond horaire : seuls ${batch.length} sur ${chosen.length} seront supprimés maintenant.` : '';
    const sample = batch.slice(0, 8).map((d) => `• ${label(d.addr)}`).join('\n');
    const ok = window.confirm(`Supprimer ${batch.length} RPP qui doublent un HN ?\n\n${sample}${batch.length > 8 ? `\n… et ${batch.length - 8} autre(s)` : ''}${cut}\n\nLe HN correspondant est conservé. Vérifiez avant d'enregistrer.`);
    if (!ok) return;
    setBusy(true);
    let deleted = 0; let failed = 0; let stopped = false;
    try {
      for (const d of batch) {
        try {
          await write(() => DM().Venues.deleteVenue({ venueId: d.venueId }));
          deleted++;
          state.dups = state.dups.filter((x) => x !== d);
        } catch (e) {
          if (e && e.quota) { stopped = true; break; }
          console.error(`${SCRIPT_NAME}: suppression du RPP ${d.venueId}`, e);
          failed++;
        }
      }
    } finally {
      setBusy(false);
      renderDups();
    }
    setStatus(`${failed || stopped ? '⚠️' : '✅'} ${deleted} RPP supprimé(s)${failed ? `, ${failed} échec(s) (voir console)` : ''}${stopped ? ', plafond horaire atteint' : ''} — vérifiez puis Enregistrer dans WME.`);
  }

  // ---------------------------------------------------------------------
  // Interface
  // ---------------------------------------------------------------------
  function injectStyles() {
    const ID_STYLE = 'rh-styles';
    if (document.getElementById(ID_STYLE)) return;
    const style = document.createElement('style');
    style.id = ID_STYLE;
    style.textContent = `
#rh-panel {
    --rh-bg: #ffffff; --rh-bg-subtle: #f8fafc; --rh-border: #e2e8f0; --rh-text: #1e293b;
    --rh-text-secondary: #64748b; --rh-accent: #1a73e8; --rh-accent-light: #e8f0fe;
    --rh-danger: #d93025; --rh-danger-light: #fce8e6; --rh-purple: #7e57c2; --rh-purple-light: #ede7f6;
    --rh-ok: #137333; --rh-ok-light: #e6f4ea; --rh-warn: #b45309; --rh-warn-light: #fef3c7;
    --rh-radius: 12px; --rh-radius-sm: 8px;
    --rh-shadow: 0 1px 3px rgba(15,23,42,.06), 0 1px 2px rgba(15,23,42,.04);
    padding: 8px; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: var(--rh-text);
    box-sizing: border-box; font-size: 12px;
}
#rh-panel * { box-sizing: border-box; }
#rh-header {
    display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px;
    background: var(--rh-bg-subtle); border: 1px solid var(--rh-border); border-radius: var(--rh-radius); margin-bottom: 10px;
}
#rh-header .rh-title { font-size: 14px; font-weight: 800; letter-spacing: -0.01em; }
#rh-header .rh-badge { font-size: 10px; padding: 3px 9px; border-radius: 999px; background: var(--rh-accent-light); color: var(--rh-accent); font-weight: 700; white-space: nowrap; }
.rh-quota { padding: 9px 12px; margin-bottom: 10px; border: 1px solid var(--rh-border); border-radius: var(--rh-radius); background: var(--rh-bg); box-shadow: var(--rh-shadow); }
.rh-quota__text { font-size: 11px; font-weight: 700; }
.rh-quota__bar { height: 6px; margin: 6px 0 4px; background: var(--rh-border); border-radius: 999px; overflow: hidden; }
.rh-quota__bar > div { height: 100%; width: 0; background: var(--rh-accent); transition: width .3s; }
.rh-quota.is-full .rh-quota__bar > div { background: var(--rh-danger); }
.rh-quota__sub { font-size: 10px; color: var(--rh-text-secondary); }
.rh-status {
    display: none; margin-bottom: 10px; padding: 9px 11px; border-radius: var(--rh-radius-sm);
    background: var(--rh-bg-subtle); border: 1px solid var(--rh-border); font-size: 12px; font-weight: 600; line-height: 1.4;
}
.rh-status.is-ok { background: var(--rh-ok-light); border-color: #b7dfc3; color: var(--rh-ok); }
.rh-status.is-warn { background: var(--rh-warn-light); border-color: #f3dc9a; color: var(--rh-warn); }
.rh-status.is-err { background: var(--rh-danger-light); border-color: #f4c2bd; color: var(--rh-danger); }
.rh-card { background: var(--rh-bg); border: 1px solid var(--rh-border); border-radius: var(--rh-radius); margin-bottom: 10px; box-shadow: var(--rh-shadow); overflow: hidden; }
.rh-card__head { display: flex; align-items: center; gap: 6px; padding: 10px 14px; background: var(--rh-bg-subtle); border-bottom: 1px solid var(--rh-border); font-size: 12px; font-weight: 700; }
.rh-card__head .rh-tag { margin-left: auto; font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: var(--rh-accent-light); color: var(--rh-accent); }
.rh-card__body { padding: 12px 14px; }
.rh-sub { font-size: 10px; color: var(--rh-text-secondary); line-height: 1.45; margin: 0 0 8px; }
.rh-pick { padding: 8px 10px; margin-bottom: 8px; border-radius: var(--rh-radius-sm); background: var(--rh-bg-subtle); border: 1px solid var(--rh-border); font-size: 11px; line-height: 1.4; }
.rh-pick.is-set { background: var(--rh-purple-light); border-color: #d1c4e9; }
.rh-pick b { font-weight: 700; }
#rh-panel button { width: 100%; padding: 9px 10px; border: none; border-radius: var(--rh-radius-sm); background: var(--rh-accent); color: #fff; font-weight: 700; font-size: 12px; cursor: pointer; transition: background .15s, transform .05s; }
#rh-panel button:active:not(:disabled) { transform: translateY(1px); }
#rh-panel button:disabled { opacity: .45; cursor: not-allowed; }
#rh-panel button.rh-secondary { background: #eef2f7; color: var(--rh-text); }
#rh-panel button.rh-secondary:hover:not(:disabled) { background: #dbeafe; }
#rh-panel button.rh-danger { background: var(--rh-danger); }
#rh-panel button.rh-danger:hover:not(:disabled) { background: #b3261e; }
#rh-panel button.rh-primary:hover:not(:disabled) { background: #145a9e; }
#rh-panel button.rh-purple { background: var(--rh-purple); }
#rh-panel button.rh-purple:hover:not(:disabled) { background: #5e3fa3; }
.rh-row { display: flex; gap: 6px; }
.rh-row > * { flex: 1; margin: 0; }
.rh-list { max-height: 260px; overflow-y: auto; margin: 8px 0; border: 1px solid var(--rh-border); border-radius: var(--rh-radius-sm); padding: 4px; }
.rh-item { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border: 1px solid var(--rh-border); border-left: 4px solid var(--rh-danger); border-radius: var(--rh-radius-sm); margin-bottom: 4px; font-size: 11px; }
.rh-item span.rh-item__txt { flex: 1; line-height: 1.35; }
.rh-item small { display: block; color: var(--rh-text-secondary); font-size: 10px; }
#rh-panel .rh-goto { width: auto; padding: 3px 8px; font-size: 13px; background: var(--rh-accent-light); color: var(--rh-accent); }
.rh-details > summary { cursor: pointer; list-style: none; }
.rh-details > summary::-webkit-details-marker { display: none; }
.rh-details:not([open]) > summary { border-bottom: none; }
.rh-details .rh-card__body p { margin: 0 0 8px; font-size: 11px; line-height: 1.5; color: var(--rh-text-secondary); }
.rh-details .rh-card__body p:last-child { margin-bottom: 0; }
`;
    document.head.appendChild(style);
  }

  function setStatus(msg) {
    const el = document.querySelector('#rh-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.display = msg ? 'block' : 'none';
    el.classList.remove('is-ok', 'is-warn', 'is-err');
    if (msg && msg.indexOf('✅') === 0) el.classList.add('is-ok');
    else if (msg && msg.indexOf('⚠️') === 0) el.classList.add('is-warn');
    else if (msg && msg.indexOf('❌') === 0) el.classList.add('is-err');
  }

  function setBusy(b) {
    state.busy = b;
    const root = document.querySelector('#rh-panel');
    if (!root) return;
    root.querySelectorAll('button').forEach((btn) => {
      if (btn.dataset.always) return;
      btn.disabled = b;
    });
    if (!b) { renderPicked(); renderDups(); }
  }

  async function refreshSelection() {
    const el = document.querySelector('#rh-sel');
    if (!el) return;
    try {
      const sel = state.sdk.Editing.getSelection();
      if (!sel || sel.objectType !== 'venue' || !sel.ids || sel.ids.length !== 1) { el.textContent = 'Aucun RPP sélectionné.'; el.classList.remove('is-set'); return; }
      const v = await DM().Venues.getById({ venueId: String(sel.ids[0]) });
      if (!v || !v.isResidential) { el.textContent = 'Le lieu sélectionné n\'est pas un RPP.'; el.classList.remove('is-set'); return; }
      const a = simplifyAddress(await DM().Venues.getAddress({ venueId: String(sel.ids[0]) }));
      el.innerHTML = `RPP sélectionné : <b>${esc(label(a))}</b>`;
      el.classList.add('is-set');
    } catch (e) { el.textContent = 'Sélectionnez un RPP dans WME.'; }
  }

  function renderPicked() {
    const box = document.querySelector('#rh-picked');
    const btn = document.querySelector('#hn-convert');
    const pickBtn = document.querySelector('#hn-pick');
    if (!box || !btn || !pickBtn) return;
    if (state.picking) {
      box.classList.remove('is-set');
      box.textContent = '👆 Cliquez sur la carte, au plus près du numéro à convertir…';
      pickBtn.textContent = '❌ Annuler le choix';
      pickBtn.disabled = false;
      btn.disabled = true;
      return;
    }
    pickBtn.textContent = '🎯 Choisir un HN sur la carte';
    pickBtn.disabled = state.busy;
    if (state.picked) {
      box.classList.add('is-set');
      box.innerHTML = `HN choisi : <b>${esc(state.picked.number)} ${esc(state.picked.street || '(sans rue)')}</b>${state.picked.city ? `, ${esc(state.picked.city)}` : ' (sans ville)'}`;
      btn.disabled = state.busy;
    } else {
      box.classList.remove('is-set');
      box.textContent = 'Aucun HN choisi.';
      btn.disabled = true;
    }
  }

  function renderDups() {
    const wrap = document.querySelector('#rh-dups');
    const delBtn = document.querySelector('#dup-delete');
    if (!wrap || !delBtn) return;
    if (!state.dups.length) { wrap.innerHTML = ''; delBtn.style.display = 'none'; return; }
    const shown = state.dups.slice(0, LIST_MAX);
    wrap.innerHTML = `<div class="rh-list">${shown.map((d, i) => `
      <div class="rh-item">
        <input type="checkbox" data-dup="${i}" ${d.checked ? 'checked' : ''} />
        <span class="rh-item__txt">${esc(label(d.addr))}<small>double un HN à ${Math.round(d.d)} m</small></span>
        <button class="rh-goto" data-goto="${i}" title="Aller sur ce RPP">🎯</button>
      </div>`).join('')}</div>${state.dups.length > LIST_MAX ? `<p class="rh-sub">${state.dups.length - LIST_MAX} autre(s) non listé(s) : traitez ceux-ci d'abord, puis relancez.</p>` : ''}`;
    wrap.querySelectorAll('[data-dup]').forEach((cb) => cb.addEventListener('change', () => {
      const d = shown[parseInt(cb.dataset.dup, 10)];
      if (d) d.checked = cb.checked;
      updateDelLabel();
    }));
    wrap.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => {
      const d = shown[parseInt(b.dataset.goto, 10)];
      if (!d) return;
      try { state.sdk.Map.setMapCenter({ lonLat: { lon: d.p[0], lat: d.p[1] }, zoomLevel: 22 }); } catch (e) { console.warn(e); }
    }));
    delBtn.style.display = '';
    updateDelLabel();
  }

  function updateDelLabel() {
    const delBtn = document.querySelector('#dup-delete');
    if (!delBtn) return;
    const n = state.dups.filter((d) => d.checked).length;
    delBtn.textContent = `🧹 Supprimer les ${n} RPP cochés`;
    delBtn.disabled = state.busy || n === 0;
  }

  async function buildUI() {
    const { tabLabel, tabPane } = await state.sdk.Sidebar.registerScriptTab();
    tabLabel.innerText = '🧹 RPP&HN';
    injectStyles();

    tabPane.innerHTML = `
      <div id="rh-panel">
        <div id="rh-header">
          <span class="rh-title">🧹 Tool RPP&amp;HN</span>
          <span class="rh-badge">v${VERSION_SCRIPT}</span>
        </div>

        <div id="rh-quota" class="rh-quota">
          <div class="rh-quota__text"></div>
          <div class="rh-quota__bar"><div></div></div>
          <div class="rh-quota__sub"></div>
        </div>

        <div id="rh-status" class="rh-status"></div>

        <div class="rh-card">
          <div class="rh-card__head">🔀 RPP → HN <span class="rh-tag">un à la fois</span></div>
          <div class="rh-card__body">
            <p class="rh-sub">Sélectionnez un RPP dans WME. Le numéro est recréé sur le segment le plus proche portant la même rue ET la même ville (50 m maximum), puis le RPP est supprimé.</p>
            <div id="rh-sel" class="rh-pick">Aucun RPP sélectionné.</div>
            <button id="rpp-convert" class="rh-primary">🔀 Convertir le RPP sélectionné</button>
          </div>
        </div>

        <div class="rh-card">
          <div class="rh-card__head">🔄 HN → RPP <span class="rh-tag">un à la fois</span></div>
          <div class="rh-card__body">
            <p class="rh-sub">Choisissez un HN d'un clic sur la carte. Le RPP est créé avec le même numéro, la même rue et la même ville, et son adresse est vérifiée avant de supprimer le HN.</p>
            <div id="rh-picked" class="rh-pick">Aucun HN choisi.</div>
            <div class="rh-row">
              <button id="hn-pick" class="rh-secondary" data-always="1">🎯 Choisir un HN sur la carte</button>
              <button id="hn-convert" class="rh-purple" disabled>🔄 Convertir ce HN</button>
            </div>
          </div>
        </div>

        <div class="rh-card">
          <div class="rh-card__head">🧹 RPP en doublon d'un HN <span class="rh-tag">écran visible</span></div>
          <div class="rh-card__body">
            <p class="rh-sub">Liste les RPP de l'écran (sans photo) qui doublent un HN : même numéro, même rue, même ville, à moins de ${DUP_RADIUS_M} m. Vous choisissez ceux à supprimer ; le HN est conservé.</p>
            <button id="dup-scan" class="rh-secondary">🔍 Chercher les doublons</button>
            <div id="rh-dups"></div>
            <button id="dup-delete" class="rh-danger" style="display:none;">🧹 Supprimer les RPP cochés</button>
          </div>
        </div>

        <details class="rh-card rh-details">
          <summary class="rh-card__head">ℹ️ Bon à savoir</summary>
          <div class="rh-card__body">
            <p>Chaque action demande une confirmation et ne modifie que des objets visibles dans votre session ; rien n'est enregistré par le script : c'est vous qui cliquez sur « Enregistrer » dans WME.</p>
            <p>Les RPP avec photo sont toujours ignorés. Si le SDK n'indique pas les photos, le script ne touche à aucun RPP.</p>
            <p>Un doublon (HN ou RPP identique déjà présent) bloque la conversion. Si une opération échoue à mi-parcours, le script retire ce qu'il vient de créer.</p>
            <p>Les RPP créés sont verrouillés au niveau 1 au minimum, et jamais en dessous du verrou du segment. Le plafond de 150 éditions par heure est un garde-fou qui ne se règle pas.</p>
          </div>
        </details>
      </div>
    `;

    tabPane.querySelector('#rpp-convert').addEventListener('click', onConvertRpp);
    tabPane.querySelector('#hn-pick').addEventListener('click', () => { if (state.picking) { stopPicking(); setStatus(''); } else onPickStart(); });
    tabPane.querySelector('#hn-convert').addEventListener('click', onConvertHn);
    tabPane.querySelector('#dup-scan').addEventListener('click', onScanDups);
    tabPane.querySelector('#dup-delete').addEventListener('click', onDeleteDups);
    refreshQuota();
    renderPicked();
    refreshSelection();
    setInterval(refreshQuota, 15000);
    try { state.sdk.Events.on({ eventName: 'wme-selection-changed', eventHandler: () => { refreshSelection(); } }); } catch (e) { /* aperçu facultatif */ }
  }

  // ---------------------------------------------------------------------
  // Démarrage
  // ---------------------------------------------------------------------
  function bootstrap() {
    console.log(`${SCRIPT_NAME}: script chargé`);
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', bootstrap); return; }
    if (!pageWindow.SDK_INITIALIZED) { setTimeout(bootstrap, 200); return; }
    pageWindow.SDK_INITIALIZED.then(initScript);
  }

  function initScript() {
    state.sdk = pageWindow.getWmeSdk({ scriptId: 'wme-suppression-rpp', scriptName: SCRIPT_NAME });
    state.sdk.Events.once({ eventName: 'wme-ready' }).then(() => {
      console.log(`${SCRIPT_NAME}: wme-ready, construction de l'onglet`);
      ensurePickLayer();
      buildUI();
    });
  }

  bootstrap();
})();
