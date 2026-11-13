// Atlas PCH Colombia · aplicación web (versión 2)
// Orden del archivo: utilidades → estado → carga de datos → red y perfiles → mapa → interacción
//                    → fichas → lista de sitios → búsqueda → guardados/exportación → fuentes → inicio.
import * as maplibregl from './vendor/maplibre-gl.mjs';
import {POWER_BANDS, CONSTRAINTS, bandOf, constraintsOf, powerImage, powerColor, registerMapSymbols, symbolSVG, protectedCategoryNote} from './map-symbols.mjs?v=2.1.0';
import {fdcSigma, fdcQ, fdcTurbined, predesign, economics, ECON_DEFAULTS} from './engineering.mjs?v=2.1.0';
import {EMPTY, fc, bboxOf, distance, hydraulicPowerKW, normalize, cellKeyFromInt, pointFeature, lineFeature} from './geo.mjs?v=2.1.0';

/* ───────────── Utilidades ───────────── */
const V = 'data/v2/';
// Cambiar al regenerar los datos (scripts/pipeline/06): obliga a los navegadores a descargar la versión nueva.
const DATA_VERSION = '2026-11-12.1';
const versioned = url => url + (url.includes('?') ? '&' : '?') + 'd=' + DATA_VERSION;
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const isNum = n => n !== null && n !== undefined && n !== '' && Number.isFinite(Number(n));
const fmt = (n, d = 0) => isNum(n) ? Number(n).toLocaleString('es-CO', {maximumFractionDigits: d, minimumFractionDigits: 0}) : '—';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const safeURL = s => { try { const u = new URL(s, location.href); return /^https?:$/.test(u.protocol) ? u.href : '#'; } catch { return '#'; } };
const link = (url, text = 'Consultar fuente') => `<a href="${esc(safeURL(url))}" target="_blank" rel="noopener noreferrer">${esc(text)} ↗</a>`;
const icon = id => `<svg aria-hidden="true"><use href="#i-${id}"/></svg>`;
const power = kw => !isNum(kw) ? '—' : kw >= 1000 ? `${fmt(kw / 1000, 2)} MW` : `${fmt(kw, kw < 10 ? 1 : 0)} kW`;
const flow = q => !isNum(q) ? 'Sin dato' : `${fmt(q, q < 1 ? 3 : q < 100 ? 2 : 0)} m³/s`;
const abs = p => new URL(p, location.href).href;
const riverTitle = name => name || 'Afluente sin nombre registrado';

/** Lee JSON o JSON comprimido con gzip (los .gz se descomprimen en el navegador). */
async function json(url, timeoutMs = 30000) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(/^https?:/.test(url) ? url : versioned(url), {signal: controller.signal});
    if (!r.ok) throw Error(`${url}: ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes[0] === 31 && bytes[1] === 139) {
      if (typeof DecompressionStream === 'undefined') throw Error('Actualiza el navegador para leer datos comprimidos.');
      return await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json();
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally { clearTimeout(timer); }
}

/* ───────────── Estado ───────────── */
// Supuestos editables. Coinciden con los del cálculo nacional (scripts/pipeline/04_sites.py).
const DEFAULTS = {eta: 85, loss: 5, plantFactor: 50, maxConduit: 3, minHead: 10, minGradient: 20, maxRiver: 8};
const S = {
  // Filtros por defecto (revisión del panel): solo PCH ≤ 20 MW, sin Parques Nacionales ni embalses, sin caudal regulado.
  view: 'explore', power: 'pch', area: '', dept: '', maxGrid: '', hideRegulated: true, hideQuality: false,
  constraint: 'no-spnn', colorBy: 'plain', listLimit: 20,
  scenario: {amb: 'ena'}, econ: {...ECON_DEFAULTS},
  data: {}, sites: [], siteById: new Map(), cells: new Map(), reaches: new Map(), siteCtx: new Map(),
  subzonas: null, manifest: null, riverSearch: null,
  selection: null, tab: 'summary', saved: [], mapReady: false, params: {...DEFAULTS},
};
try { S.saved = JSON.parse(localStorage.getItem('atlas-pch-saved-v2') || '[]'); if (!Array.isArray(S.saved)) S.saved = []; } catch {}
let map, mini, toastTimer, moveTimer, popup;

function toast(text) { $('#toast').textContent = text; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 5000); }
function showError(text) { $('#map-error').textContent = text; $('#map-error').hidden = false; }
function setData(name, data) { map?.getSource(name)?.setData(data || EMPTY); }
function visibility(id, show) { if (map?.getLayer(id)) map.setLayoutProperty(id, 'visibility', show ? 'visible' : 'none'); }
const on = id => $('#layer-' + id)?.checked;

/* ───────────── Red hidrográfica y perfiles (datos por celda) ───────────── */
// Cada celda de 1° trae, por tramo: hidrología, mejor alternativa y estaciones del lecho cada ≤100 m.
function loadCell(key) {
  if (!key) return Promise.resolve(null);
  if (!S.cells.has(key)) S.cells.set(key, json(`${V}reaches/${key}.json.gz`).catch(e => { S.cells.delete(key); console.warn(e.message); return null; }));
  return S.cells.get(key);
}
const cumsum = a => { let s = 0; return a.map(v => (s += v)); };

/** Decodifica un tramo: [down_id, down_cell, upa, len, strahler, szh, name, q×5, q95, q_hr, mask, ext, best, dx, dy, dz]. */
async function getReach(id, cellKey) {
  const key = String(id);
  if (S.reaches.has(key)) return S.reaches.get(key);
  const cell = await loadCell(cellKey);
  const r = cell?.[key];
  if (!r) return null;
  const xs = cumsum(r[17]).map(v => v / 1e5), ys = cumsum(r[18]).map(v => v / 1e5), zs = cumsum(r[19]);
  const reach = {
    id: key, cellKey, down: r[0] ? String(r[0]) : null, downCell: r[1], upa: r[2], length: r[3], strahler: r[4], szh: r[5], name: r[6],
    q: {medio: r[7], seco: r[8], humedo: r[9], disp: r[10], dispSeco: r[11]}, q95: r[12], qHydroRivers: r[13],
    mask: r[14], external: r[15], best: r[16], regFrac: r[20] || 0, regName: r[21] || null,
    stations: xs.map((x, i) => ({x, y: ys[i], z: zs[i] < -9000 ? null : zs[i]})),
  };
  S.reaches.set(key, reach);
  if (S.reaches.size > 6000) S.reaches.delete(S.reaches.keys().next().value);
  return reach;
}

/** Recorre la red aguas abajo desde (tramo, estación) durante `steps` estaciones. */
async function walk(reach, offset, steps) {
  let r = reach, i = offset;
  const out = [{...r.stations[i], reach: r}];
  for (let k = 0; k < steps; k++) {
    if (i + 1 < r.stations.length) i++;
    else {
      if (!r.down) break;
      const next = await getReach(r.down, r.downCell);
      if (!next) break;
      r = next; i = 0;
    }
    out.push({...r.stations[i], reach: r});
  }
  let d = 0;
  out.forEach((s, j) => { if (j) d += distance([out[j - 1].x, out[j - 1].y], [s.x, s.y]); s.d = d; });
  return out;
}

/** Arma la alternativa (bocatoma → casa de máquinas) a partir del recorrido. */
function optionFromPath(path, qDesign, extra = {}) {
  const a = path[0], b = path.at(-1);
  const head = extra.head ?? (isNum(a.z) && isNum(b.z) ? a.z - b.z : null);
  const conduitKm = extra.conduitKm ?? distance([a.x, a.y], [b.x, b.y]);
  return {
    path, intake: [a.x, a.y], powerhouse: [b.x, b.y], head, conduitKm,
    riverKm: extra.riverKm ?? b.d, qDesign,
    pKW: extra.pKW ?? (isNum(head) ? hydraulicPowerKW(qDesign, head * (1 - DEFAULTS.loss / 100), DEFAULTS.eta / 100) : null),
    ...extra,
  };
}

/** Búsqueda de la mejor casa de máquinas desde cada estación del tramo, con criterios editables. */
async function searchBest(reach, params) {
  let best = null;
  for (let o = 0; o < reach.stations.length; o++) {
    const a = reach.stations[o];
    if (!isNum(a.z)) continue;
    const path = await walk(reach, o, 95);
    for (let j = 1; j < path.length; j++) {
      const b = path[j];
      if (b.d > params.maxRiver) break;
      if (!isNum(b.z)) continue;
      const h = a.z - b.z, lc = distance([a.x, a.y], [b.x, b.y]);
      if (h >= params.minHead && lc <= params.maxConduit && h >= params.minGradient * Math.max(lc, .05) && (!best || h > best.head))
        best = {offset: o, steps: j, head: h, conduitKm: lc, riverKm: b.d};
    }
  }
  if (!best) return null;
  const path = (await walk(reach, best.offset, best.steps));
  return optionFromPath(path, reach.q.disp, {head: best.head, conduitKm: best.conduitKm, riverKm: best.riverKm});
}

/* ───────────── Mapa ───────────── */
function baseStyle() {
  return {version: 8, glyphs: abs('assets/glyphs/') + '{fontstack}/{range}.pbf', sources: {},
    layers: [{id: 'background', type: 'background', paint: {'background-color': '#eaf0e4'}}]};
}
async function attachBasemap(target, before) {
  try {
    const style = await json('assets/basemap-style.json');
    for (const [id, source] of Object.entries(style.sources)) if (!target.getSource('base-' + id)) target.addSource('base-' + id, source);
    if (style.sprite) target.setSprite(style.sprite);
    for (const l of style.layers) {
      if (l.type === 'background' || l['source-layer'] === 'waterway') continue; // los ríos los dibuja la red unificada
      target.addLayer({...l, id: 'base-' + l.id, ...(l.source ? {source: 'base-' + l.source} : {})}, before);
    }
  } catch (e) { console.warn('Cartografía de contexto:', e.message); }
}

// Ríos principales, medianos y pequeños; los pequeños vienen en MINOR_PARTS piezas regionales
// (debe coincidir con MINOR_PARTS en scripts/pipeline/06_web_data.py).
const MINOR_PARTS = 8;
const MINOR_TIERS = Array.from({length: MINOR_PARTS}, (_, i) => `minor-${i + 1}`);
const RIVER_TIERS = ['major', 'mid', ...MINOR_TIERS];
// MapLibre admite una sola interpolación por zoom en cada expresión: el resaltado del río
// seleccionado (feature-state) se suma dentro de cada escalón.
const selectedExtra = ['case', ['boolean', ['feature-state', 'selected'], false], 2.5, 0];
const riverWidth = ['interpolate', ['linear'], ['zoom'],
  3, ['+', selectedExtra, ['*', ['get', 'o'], .13]],
  8, ['+', selectedExtra, ['*', ['get', 'o'], .3]],
  13, ['+', selectedExtra, 1.1, ['*', ['get', 'o'], .38]]];
function riverColor() {
  const base = S.colorBy === 'flow'
    ? ['interpolate', ['linear'], ['coalesce', ['get', 'q'], 0], 0, '#c3d9de', .1, '#8cb8d0', 1, '#5a9bb9', 10, '#3a7f9f', 100, '#335e91', 1000, '#274775']
    : S.colorBy === 'potential' ? powerColor : '#2f7f8a';
  return ['case', ['boolean', ['feature-state', 'selected'], false], '#123f37', base];
}
const POINT_LAYERS = {
  'site-point': {source: 'sites', kind: 'site'},
  'site-point-small': {source: 'sites', kind: 'site'},
  'site-point-mid': {source: 'sites', kind: 'site'},
  'upme-point': {source: 'upme2015', kind: 'upme2015'},
  'station-point': {source: 'stations', kind: 'station'},
  'substation-point': {source: 'substations', kind: 'substation'},
  'project-point': {source: 'projects', kind: 'project'},
  'plant-municipal': {source: 'municipal-plants', kind: 'plant'},
  'plant-point': {source: 'plants', kind: 'plant'},
};

function setupMap() {
  const firstSymbol = map.getStyle().layers.find(l => l.type === 'symbol')?.id;
  const demURL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
  map.addSource('terrain-dem', {type: 'raster-dem', tiles: [demURL], tileSize: 512, encoding: 'terrarium', maxzoom: 12,
    attribution: 'Relieve 3D: <a href="https://mapterhorn.com/attribution/" target="_blank">Mapterhorn · Copernicus GLO-30</a>'});
  map.addSource('hillshade-dem', {type: 'raster-dem', tiles: [demURL], tileSize: 512, encoding: 'terrarium', maxzoom: 12});
  map.addLayer({id: 'relief', type: 'hillshade', source: 'hillshade-dem', layout: {visibility: 'none'},
    paint: {'hillshade-shadow-color': '#566d3e', 'hillshade-highlight-color': '#f5f4df', 'hillshade-accent-color': '#9aa578', 'hillshade-exaggeration': .38}}, firstSymbol);
  map.addSource('satellite', {type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 18,
    attribution: 'Imagen: Esri, Maxar, Earthstar Geographics'});
  map.addLayer({id: 'satellite-layer', type: 'raster', source: 'satellite', layout: {visibility: 'none'}}, firstSymbol);
  map.addSource('hazard', {type: 'raster', tiles: ['https://srvags.sgc.gov.co/arcgis/rest/services/SIMMA/ZonificacionAmenazaCache/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 15,
    attribution: 'Amenaza por movimientos en masa: <a href="https://www2.sgc.gov.co/sgc/mapas/" target="_blank">Servicio Geológico Colombiano</a>'});
  // Desaturada para que sus amarillos y rojos no compitan con los rayos de potencia (revisión de diseño)
  map.addLayer({id: 'hazard-layer', type: 'raster', source: 'hazard', layout: {visibility: 'none'},
    paint: {'raster-opacity': .4, 'raster-saturation': -0.5, 'raster-contrast': -0.1}}, firstSymbol);

  for (const k of ['boundary', 'departments', 'grid', 'route', 'conduit', 'endpoints', 'selected-point', 'sites', 'upme2015', 'stations', 'substations', 'projects', 'plants', 'municipal-plants'])
    map.addSource(k, {type: 'geojson', data: EMPTY});
  map.addLayer({id: 'colombia-tint', type: 'fill', source: 'boundary', paint: {'fill-color': '#789550', 'fill-opacity': .045}}, firstSymbol);
  map.addLayer({id: 'department-lines', type: 'line', source: 'departments', paint: {'line-color': '#8c9b7b', 'line-width': .6, 'line-opacity': .45, 'line-dasharray': [3, 3]}}, firstSymbol);
  map.addLayer({id: 'boundary-line', type: 'line', source: 'boundary', paint: {'line-color': '#748761', 'line-width': 1.2, 'line-opacity': .75}}, firstSymbol);

  // Restricciones (teselas vectoriales): un estilo por bit
  map.addSource('constraints', {type: 'vector', url: 'pmtiles://' + abs(versioned(V + 'tiles/constraints.pmtiles'))});
  for (const c of CONSTRAINTS) {
    map.addLayer({id: `c-${c.key}-fill`, type: 'fill', source: 'constraints', 'source-layer': 'constraints', filter: ['==', ['get', 'b'], c.bit],
      paint: {'fill-color': c.color, 'fill-opacity': c.opacity}}, firstSymbol);
    map.addLayer({id: `c-${c.key}-line`, type: 'line', source: 'constraints', 'source-layer': 'constraints', filter: ['==', ['get', 'b'], c.bit],
      paint: {'line-color': c.color, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1, 12, 2.2], 'line-opacity': .9, ...(c.dash ? {'line-dasharray': c.dash} : {})}}, firstSymbol);
  }

  // Ríos (teselas vectoriales por nivel de detalle)
  for (const t of RIVER_TIERS) {
    map.addSource('rivers-' + t, {type: 'vector', url: 'pmtiles://' + abs(versioned(V + `tiles/rivers-${t}.pmtiles`)), promoteId: 'id'});
    map.addLayer({id: 'river-' + t, type: 'line', source: 'rivers-' + t, 'source-layer': 'rivers', layout: {'line-cap': 'round', 'line-join': 'round'},
      paint: {'line-color': riverColor(), 'line-opacity': .85, 'line-width': riverWidth}}, firstSymbol);
  }
  for (const t of RIVER_TIERS)
    map.addLayer({id: 'river-hit-' + t, type: 'line', source: 'rivers-' + t, 'source-layer': 'rivers', paint: {'line-color': '#000', 'line-opacity': 0, 'line-width': 13}});

  map.addLayer({id: 'grid-line', type: 'line', source: 'grid', layout: {visibility: 'none'},
    paint: {'line-color': '#6d438a', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, .8, 12, 2], 'line-dasharray': [4, 2], 'line-opacity': .8}});
  map.addLayer({id: 'route-casing', type: 'line', source: 'route', layout: {'line-cap': 'round', 'line-join': 'round'}, paint: {'line-color': '#5a3a0a', 'line-width': 7, 'line-opacity': .9}});
  map.addLayer({id: 'route-line', type: 'line', source: 'route', layout: {'line-cap': 'round', 'line-join': 'round'}, paint: {'line-color': '#e08a1e', 'line-width': 4}});
  map.addLayer({id: 'conduit-line', type: 'line', source: 'conduit', paint: {'line-color': '#1f2a2a', 'line-width': 2.5, 'line-dasharray': [2, 1.2]}});

  registerMapSymbols(map);
  const size = ['interpolate', ['linear'], ['zoom'], 4, .55, 8, .8, 12, 1.05];
  map.addLayer({id: 'upme-point', type: 'circle', source: 'upme2015', layout: {visibility: 'none'},
    paint: {'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 10, 6], 'circle-color': '#ffffff', 'circle-stroke-color': '#7d6a3a', 'circle-stroke-width': 2}});
  map.addLayer({id: 'station-point', type: 'symbol', source: 'stations', layout: {'icon-image': ['case', ['==', ['get', 'status'], 'Activa'], 'atlas-station-active', 'atlas-station-other'], 'icon-size': size, visibility: 'none'}});
  map.addLayer({id: 'substation-point', type: 'symbol', source: 'substations', layout: {'icon-image': 'atlas-substation', 'icon-size': size, visibility: 'none'}});
  map.addLayer({id: 'project-point', type: 'symbol', source: 'projects', layout: {'icon-image': 'atlas-project', 'icon-size': size, 'icon-allow-overlap': true, visibility: 'none'}});
  map.addLayer({id: 'plant-municipal', type: 'symbol', source: 'municipal-plants', minzoom: 6, layout: {'icon-image': 'atlas-municipal', 'icon-size': size}});
  map.addLayer({id: 'plant-point', type: 'symbol', source: 'plants', layout: {'icon-image': 'atlas-plant', 'icon-size': size, 'icon-allow-overlap': true}});
  // Sitios escalonados por zoom (revisión de diseño): ≥ 5 MW siempre; 0,5–5 MW desde z6,5; < 0,5 MW desde z9.
  // La clase > 20 MW (fuera de rango PCH) se dibuja atenuada.
  const siteLayout = {'icon-image': powerImage,
    'icon-size': ['interpolate', ['linear'], ['zoom'], 4, ['+', .42, ['*', ['min', ['get', 'c'], 5], .05]], 9, ['+', .7, ['*', ['min', ['get', 'c'], 5], .06]], 13, 1.15],
    'symbol-sort-key': ['*', -1, ['get', 'p']], 'icon-padding': 2};
  const sitePaint = {'icon-opacity': ['case', ['==', ['get', 'c'], 6], 0.55, 1]};
  map.addLayer({id: 'site-point-small', type: 'symbol', source: 'sites', minzoom: 9, filter: ['<', ['get', 'p'], 500], layout: siteLayout, paint: sitePaint});
  map.addLayer({id: 'site-point-mid', type: 'symbol', source: 'sites', minzoom: 6.5, filter: ['all', ['>=', ['get', 'p'], 500], ['<', ['get', 'p'], 5000]], layout: siteLayout, paint: sitePaint});
  map.addLayer({id: 'site-point', type: 'symbol', source: 'sites', filter: ['>=', ['get', 'p'], 5000], layout: siteLayout, paint: sitePaint});
  // Esquema seleccionado inequívoco: bocatoma (círculo verde) y casa de máquinas (cuadrado vino), con etiquetas.
  map.addLayer({id: 'endpoint-ring', type: 'circle', source: 'endpoints', filter: ['==', ['get', 'role'], 'intake'],
    paint: {'circle-radius': 7, 'circle-color': '#0f5e4f', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2}});
  map.addLayer({id: 'endpoint-house', type: 'circle', source: 'endpoints', filter: ['==', ['get', 'role'], 'powerhouse'],
    paint: {'circle-radius': 7, 'circle-color': '#7a2e0e', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2}});
  map.addLayer({id: 'endpoint-label', type: 'symbol', source: 'endpoints', layout: {
    'text-field': ['case', ['==', ['get', 'role'], 'intake'], 'Bocatoma', 'Casa de máquinas'], 'text-font': ['Noto Sans Regular'],
    'text-size': 12, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-allow-overlap': true},
    paint: {'text-color': '#1f2a2a', 'text-halo-color': '#fff', 'text-halo-width': 1.6}});
  map.addLayer({id: 'selection-point', type: 'circle', source: 'selected-point',
    paint: {'circle-radius': 12, 'circle-color': '#fff', 'circle-opacity': .1, 'circle-stroke-color': '#245e4b', 'circle-stroke-width': 2}});

  const clickable = [...Object.keys(POINT_LAYERS), ...RIVER_TIERS.map(t => 'river-hit-' + t)];
  for (const layer of clickable) {
    map.on('mouseenter', layer, () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', layer, () => map.getCanvas().style.cursor = '');
  }
  map.on('click', e => onMapClick(e, clickable));
  updateLayers();
}

let selectedReachState = null;
function highlightReach(id) {
  if (selectedReachState) for (const t of RIVER_TIERS) map.setFeatureState({source: 'rivers-' + t, sourceLayer: 'rivers', id: selectedReachState}, {selected: false});
  selectedReachState = id ? Number(id) : null;
  if (selectedReachState) for (const t of RIVER_TIERS) map.setFeatureState({source: 'rivers-' + t, sourceLayer: 'rivers', id: selectedReachState}, {selected: true});
}

function updateLayers() {
  if (!S.mapReady) return;
  for (const t of RIVER_TIERS) { visibility('river-' + t, on('rivers')); visibility('river-hit-' + t, on('rivers')); map.setPaintProperty('river-' + t, 'line-color', riverColor()); }
  visibility('relief', on('relief') && !on('satellite')); visibility('satellite-layer', on('satellite')); visibility('hazard-layer', on('hazard'));
  if (map.getPitch() > 5 && on('relief')) map.setTerrain({source: 'terrain-dem', exaggeration: 1}); else map.setTerrain(null);
  for (const c of CONSTRAINTS) { const show = on(c.group); visibility(`c-${c.key}-fill`, show); visibility(`c-${c.key}-line`, show); }
  visibility('plant-point', on('plants')); visibility('plant-municipal', on('plants'));
  visibility('project-point', on('projects')); visibility('grid-line', on('grid'));
  visibility('station-point', on('stations')); visibility('substation-point', on('substations'));
  visibility('upme-point', on('upme2015')); visibility('site-point', on('sites')); visibility('site-point-mid', on('sites')); visibility('site-point-small', on('sites'));
  for (const [key, file, source] of [['stations', 'data/stations.geojson', 'stations'], ['substations', 'data/energy-substations.geojson', 'substations'],
    ['grid', V + 'grid-lines.geojson.gz', 'grid'], ['projects', V + 'assigned-projects.geojson.gz', 'projects'], ['upme2015', 'data/opportunities.geojson', 'upme2015']])
    if (on(key) || (key === 'substations' && S.selection)) void ensureLayerData(key, file, source);
  renderMapKey();
}
const layerData = {};
function ensureLayerData(key, file, source) {
  if (!layerData[key]) layerData[key] = json(file + (file.endsWith('.gz') ? '' : '.gz')).catch(() => json(file)).then(d => {
    S.data[key] = d; setData(source, d); return d;
  }).catch(e => { delete layerData[key]; console.warn(e.message); return null; });
  return layerData[key];
}

function renderMapKey() {
  const row = (mark, label) => `<li>${mark}<span>${esc(label)}</span></li>`;
  const section = (title, rows) => `<section><h3>${esc(title)}</h3><ul>${rows.join('')}</ul></section>`;
  let html = '';
  if (on('sites')) html += section('Sitios candidatos · potencia de referencia', POWER_BANDS.map(b => row(symbolSVG('power-' + b.key), b.label)));
  if (on('rivers')) {
    if (S.colorBy === 'flow') html += section('Caudal disponible ENA 2022', [row('<i class="legend-gradient flow"></i>', 'De 0,1 a más de 1.000 m³/s')]);
    else if (S.colorBy === 'potential') html += section('Potencial del mejor esquema desde cada tramo', [...POWER_BANDS.map(b => row(`<i class="legend-line" style="background:${b.color}"></i>`, b.label)), row('<i class="legend-line" style="background:#a9bcbc"></i>', 'Sin esquema que cumpla los criterios')]);
    else html += section('Red hidrográfica', [row('<i class="legend-line"></i>', 'Ríos y afluentes (grosor = orden del cauce)')]);
  }
  const groups = CONSTRAINTS.filter(c => on(c.group));
  if (groups.length) html += section('Restricciones', groups.map(c => row(`<i class="env-swatch" style="--swatch:${c.color};--edge:${c.border || 'solid'}"></i>`, c.label)));
  if (on('hazard')) html += section('Amenaza (SGC)', [row('<i class="legend-gradient hazard"></i>', 'Baja → muy alta, según la leyenda del SGC')]);
  const infra = [];
  if (on('plants')) infra.push(row(symbolSVG('plant'), 'Central hidroeléctrica'), row(symbolSVG('municipal'), 'Central · referencia municipal'));
  if (on('projects')) infra.push(row(symbolSVG('project'), 'Proyecto hidráulico con capacidad asignada'));
  if (on('grid')) infra.push(row('<i class="legend-line grid"></i>', 'Línea de transmisión'));
  if (on('substations')) infra.push(row(symbolSVG('substation'), 'Subestación'));
  if (on('stations')) infra.push(row(symbolSVG('station-active'), 'Estación activa'), row(symbolSVG('station-other'), 'Estación suspendida'));
  if (on('upme2015')) infra.push(row('<i class="legend-ring"></i>', 'Referencia Atlas UPME 2015'));
  if (infra.length) html += section('Infraestructura y referencias', infra);
  if (S.selection?.option) html += section('Esquema seleccionado', [row('<i class="legend-dot intake"></i>', 'Bocatoma'), row('<i class="legend-line dashed"></i>', 'Conducción (línea recta)'), row('<i class="legend-line route"></i>', 'Tramo con caudal reducido'), row('<i class="legend-dot powerhouse"></i>', 'Casa de máquinas y restitución')]);
  $('#map-key-body').innerHTML = html || '<p>Activa una capa para ver su simbología.</p>';
}

/* ───────────── Interacción con el mapa ───────────── */
async function onMapClick(e, clickable) {
  const hit = map.queryRenderedFeatures(e.point, {layers: clickable.filter(l => map.getLayoutProperty(l, 'visibility') !== 'none')})[0];
  const coord = [e.lngLat.lng, e.lngLat.lat];
  if (hit) {
    const layer = POINT_LAYERS[hit.layer.id];
    if (layer?.kind === 'site') return selectSite(S.siteById.get(Number(hit.properties.id)));
    if (layer) {
      const list = S.data[{'plant-municipal': 'municipalPlants', 'plant-point': 'plants', 'station-point': 'stations', 'substation-point': 'substations', 'project-point': 'projects', 'upme-point': 'upme2015'}[hit.layer.id]];
      const f = list?.features.find(f => String(f.properties.id) === String(hit.properties.id));
      if (f) return selectFeature(layer.kind, f);
      return;
    }
    return selectReach(hit.properties.id, cellKeyFromInt(hit.properties.k), coord);
  }
  const area = map.queryRenderedFeatures(e.point, {layers: CONSTRAINTS.filter(c => on(c.group)).map(c => `c-${c.key}-fill`)})[0];
  if (area) {
    popup?.remove();
    const p = area.properties;
    popup = new maplibregl.Popup().setLngLat(coord).setHTML(`<b>${esc(p.n)}</b><br><small>${esc(p.cat)}</small><br><small>${esc(p.st)}</small>${p.url ? '<br>' + link(p.url) : ''}`).addTo(map);
  }
}

function clearSelectionLayers() { for (const s of ['route', 'conduit', 'endpoints', 'selected-point']) setData(s, EMPTY); highlightReach(null); }
function drawOption(opt) {
  if (!opt) return;
  setData('route', fc([lineFeature(opt.path.map(s => [s.x, s.y]))]));
  setData('conduit', fc([lineFeature([opt.intake, opt.powerhouse])]));
  setData('endpoints', fc([pointFeature(opt.intake, {role: 'intake'}), pointFeature(opt.powerhouse, {role: 'powerhouse'})]));
}

async function selectSite(site) {
  if (!site) return;
  const p = site.properties;
  const reach = await getReach(p.r, p.k);
  if (!reach) return toast('No se pudo cargar el tramo de este sitio. Revisa la conexión.');
  const path = await walk(reach, p.o, p.st);
  const option = optionFromPath(path, p.q, {head: p.h, conduitKm: p.lc, riverKm: p.rk, pKW: p.p, pDryKW: p.ps, qDry: p.qs, q95: p.q95});
  setSelection({kind: 'site', id: 'site-' + p.id, site: p, reach, option, coord: site.geometry.coordinates,
    title: riverTitle(p.n), subtitle: [p.mu, p.d].filter(Boolean).join(' · ') || 'Colombia'});
  if (!S.siteCtx.has(p.k)) S.siteCtx.set(p.k, json(`${V}sites-context/${p.k}.json.gz`).catch(() => null));
  S.siteCtx.get(p.k).then(ctx => { if (S.selection?.site?.id === p.id) { S.selection.context = ctx?.[String(p.id)] || null; renderDetail(); } });
}

async function selectReach(id, cellKey, coord) {
  const reach = await getReach(id, cellKey);
  if (!reach) return toast('No se encontró la información de este tramo.');
  let option = null;
  if (reach.best) {
    const [offset, steps, head, conduitKm, riverKm, pKW] = reach.best;
    option = optionFromPath(await walk(reach, offset, steps), reach.q.disp, {head, conduitKm, riverKm, pKW});
  }
  setSelection({kind: 'reach', id: 'reach-' + reach.id, reach, option, coord, title: riverTitle(reach.name), subtitle: subzoneName(reach.szh)});
}

function selectFeature(kind, f) {
  const p = f.properties;
  setSelection({kind, id: `${kind}-${p.id}`, feature: f, coord: f.geometry.coordinates, title: p.name || 'Lugar seleccionado',
    subtitle: [p.municipality, p.department].filter(Boolean).join(' · ') || p.area || 'Colombia'});
}

function setSelection(sel) {
  popup?.remove(); clearSelectionLayers();
  if (S.selection?.reach?.id !== sel.reach?.id || !sel.reach) S.scenario = {amb: 'ena'}; // supuestos propios por lugar
  if (sel.originalOption === undefined) sel.originalOption = sel.option;                // para "Volver al esquema original"
  S.selection = sel; S.tab = 'summary'; S.hazard = null;
  if (sel.reach) highlightReach(sel.reach.id);
  if (sel.option) drawOption(sel.option); else setData('selected-point', fc([pointFeature(sel.coord)]));
  $('#detail-panel').hidden = false; document.body.classList.add('detail-open'); $('#map-hint').hidden = true; $('#sidebar').classList.remove('mobile-open');
  $('#map-region').textContent = sel.subtitle || 'Selección';
  renderDetail(); renderList(); renderMapKey();
  $('.detail-scroll').scrollTop = 0; // cada ficha nueva empieza arriba
  $('#detail-title h2')?.focus({preventScroll: true}); // accesibilidad: el foco pasa a la ficha
  requestAnimationFrame(() => {
    map.resize();
    const pad = {top: 80, bottom: 80, left: 50, right: innerWidth > 660 && innerWidth <= 900 ? 390 : 50};
    if (sel.option) map.fitBounds(bboxOf(lineFeature([...sel.option.path.map(s => [s.x, s.y]), sel.option.intake]).geometry), {padding: pad, duration: 650, maxZoom: 13.5});
    else map.flyTo({center: sel.coord, zoom: Math.max(map.getZoom(), 9.5), duration: 650});
  });
  void updateMiniMap();
  if (sel.kind === 'site' || sel.kind === 'reach') void ensureLayerData('substations', 'data/energy-substations.geojson', 'substations').then(() => S.selection === sel && S.tab === 'context' && renderDetail());
}

function closeDetail() {
  $('#detail-panel').hidden = true; document.body.classList.remove('detail-open');
  S.selection = null; clearSelectionLayers();
  if (mini) { mini.remove(); mini = null; }
  map?.resize(); renderList(); renderMapKey();
}

// Glosario (revisión del usuario final): cada término técnico de la ficha tiene su explicación.
const GLOSSARY = {
  'PCH': 'Pequeña central hidroeléctrica. En Colombia se llama así, por convención, a las centrales de hasta 20 MW.',
  'Salto bruto': 'Diferencia de altura del lecho del río entre la bocatoma y la casa de máquinas, medida en el modelo de elevación (FABDEM). Error típico: unos pocos metros.',
  'Salto neto': 'Salto bruto menos lo que se pierde por fricción en el canal y en la tubería. Es el que realmente mueve la turbina.',
  'Conducción': 'Canal, tubería o túnel que lleva el agua desde la bocatoma hasta la casa de máquinas. Aquí se mide en línea recta: el trazado real es más largo.',
  'Bocatoma': 'Obra que capta parte del agua del río.',
  'Casa de máquinas': 'Edificio con la turbina y el generador. Después, el agua vuelve al río (restitución).',
  'Tramo con caudal reducido': 'Parte del río entre la bocatoma y la casa de máquinas, por donde solo pasa el caudal ambiental mientras la central opera.',
  'Caudal de diseño': 'Caudal máximo que la central puede turbinar. Aquí parte de la oferta disponible de año medio del IDEAM (ENA 2022).',
  'Caudal ambiental': 'Agua que debe quedar en el río para el ecosistema y otros usos. El exigible lo fija la autoridad ambiental en cada concesión o licencia.',
  'Factor de planta': 'Energía que produce la central en un año dividida por la que produciría a plena potencia todo el año. Depende de cuánto varía el caudal.',
  'Curva de duración': 'Gráfico que dice qué porcentaje del tiempo el río lleva al menos cierto caudal. Q95 es el caudal superado el 95 % del tiempo.',
  'Q95': 'Caudal que el río supera el 95 % del tiempo (caudal de estiaje).',
  'IRH': 'Índice de regulación hídrica del IDEAM (0 a 1): qué tan estable es el caudal de la subzona. Más alto = caudal más parejo.',
  'IUA': 'Índice de uso del agua del IDEAM: qué parte de la oferta ya se usa. "Alto" o "Crítico" anticipa competencia por el agua.',
  'Eficiencia': 'Fracción de la energía del agua que se convierte en electricidad (turbina, generador y transformador).',
  'Diámetro de la tubería': 'Diámetro de la tubería de presión estimado con la fórmula de Fahlbusch (acero). Orienta costos, no es diseño.',
  'Velocidad en la tubería': 'Velocidad del agua en la tubería de presión. Lo habitual es de 2 a 5 m/s.',
  'Tiempo de arranque del agua': 'Indicador del golpe de ariete (Tw). Si supera unos 3 s, suele necesitarse chimenea de equilibrio o válvula de alivio.',
  'Inversión indicativa': 'Orden de magnitud del costo total: obras, equipos, túnel probable y conexión. Banda de −30 % a +50 %.',
  'Costo nivelado': 'Costo medio de producir cada kWh durante la vida útil (LCOE), incluyendo inversión, financiación y operación.',
  'TRM': 'Tasa representativa del mercado: pesos colombianos por dólar.',
  'Clase regulatoria': 'Cómo trata la regulación a la central según su tamaño: generación distribuida, planta menor, despacho central…',
  'Consulta previa': 'Derecho de los pueblos indígenas y comunidades negras a ser consultados cuando un proyecto los afecta directamente.',
  'Sustracción': 'Trámite ante el MinAmbiente para sacar un área de una reserva forestal y poder construir en ella.',
  'ZNI': 'Zona no interconectada: sin red del sistema nacional; la electricidad suele venir de plantas diésel.',
  'Cuenca aportante': 'Área de terreno cuya lluvia escurre hasta ese punto del río.',
  'Orden del cauce (Strahler)': 'Número que crece al unirse ríos: 1 = quebrada de cabecera; 6 o más = río grande.',
};
const glossaryKey = label => Object.keys(GLOSSARY).find(k => label.toLowerCase().startsWith(k.toLowerCase()));
function term(label) {
  const k = glossaryKey(label);
  return k ? `<span class="term" tabindex="0" data-term="${esc(k)}" title="${esc(GLOSSARY[k])}">${esc(label)}<i aria-hidden="true">?</i></span>` : esc(label);
}
function kv(items) {
  return `<dl class="detail-kv">${items.filter(Boolean).map(([k, v]) => `<dt>${term(k)}</dt><dd>${esc(v ?? 'Sin dato')}</dd>`).join('')}</dl>`;
}

/* ───────────── Fichas ───────────── */
const subzoneName = code => S.subzonas?.[code]?.name ? `${S.subzonas[code].name} (${code})` : code ? `Subzona ${code}` : '';
const TABS = {summary: 'Resumen', hydrology: 'Hidrología', context: 'Entorno', business: 'Negocio', steps: 'Próximos pasos'};

function renderDetail() {
  const sel = S.selection; if (!sel) return;
  $('#detail-eyebrow').textContent = {site: 'SITIO CANDIDATO', reach: 'TRAMO DE RÍO', plant: 'CENTRAL EXISTENTE', station: 'ESTACIÓN IDEAM', substation: 'SUBESTACIÓN', project: 'PROYECTO CON CAPACIDAD ASIGNADA', upme2015: 'REFERENCIA UPME 2015'}[sel.kind] || 'FICHA';
  $('#detail-title').innerHTML = `<h2 tabindex="-1">${esc(sel.title)}</h2><p>${esc(sel.subtitle || '')}</p>`;
  const tabs = ['site', 'reach'].includes(sel.kind);
  $('.detail-tabs').hidden = !tabs;
  $$('.detail-tabs button').forEach(b => { b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)); b.tabIndex = b.dataset.tab === S.tab ? 0 : -1; });
  const html = !tabs ? featureHTML(sel) : S.tab === 'hydrology' ? hydrologyHTML(sel) : S.tab === 'context' ? contextHTML(sel)
    : S.tab === 'business' ? businessHTML(sel) : S.tab === 'steps' ? stepsHTML(sel) : summaryHTML(sel);
  $('#detail-content').innerHTML = html;
  $('#save-site').innerHTML = icon('save') + (S.saved.some(s => s.id === sel.id) ? 'Quitar de guardados' : 'Guardar lugar');
  if (S.tab === 'context' && tabs && !S.hazard) void loadHazard(sel);
}

/** Calcula prediseño y energía con los supuestos actuales de la ficha (S.scenario). */
function computeScenario(sel) {
  const o = sel.option, r = sel.reach; if (!o) return null;
  const sc = S.scenario;
  const qm = r.q.medio, sz = S.subzonas?.[r.szh];
  const sigma = fdcSigma(sz?.irh);
  const qDesign = isNum(sc.q) ? sc.q : o.qDesign;
  const ambient = sc.amb === 'conservador' ? fdcQ(qm, sigma, 0.75) : sc.amb === 'libre' && isNum(sc.ambValue) ? sc.ambValue
    : Math.max(0, qm - r.q.disp);                                   // ENA: caudal ambiental de planificación implícito
  const riverKm = o.path.at(-1).d;
  const pre = predesign({q: qDesign, hg: o.head, conduitKm: o.conduitKm, riverKm});
  if (!pre) return null;
  const eta = isNum(sc.eta) ? sc.eta / 100 : pre.eta;
  const dEff = pre.qPCH;                                           // con tope de 19,9 MW
  const t = fdcTurbined(qm, sigma, ambient, dEff);
  const pKW = 9.81 * dEff * pre.hn * eta;
  const energyMWh = 9.81 * eta * pre.hn * t.qTurb * 8766 / 1000;
  return {pre, eta, qDesign, dEff, ambient, sigma, qm, plantFactor: t.plantFactor, qTurb: t.qTurb, pKW, energyMWh,
    q95: fdcQ(qm, sigma, 0.95), q50: fdcQ(qm, sigma, 0.5), q30: fdcQ(qm, sigma, 0.3), irh: sz?.irh, riverKm};
}

function qualityPills(sel) {
  const pills = [];
  const qf = sel.kind === 'site' ? sel.site.qf : 0;
  const o = sel.option, r = sel.reach, c = sel.context;
  const pAtlas = o?.pKW || 0;
  if (pAtlas > 20000) pills.push(['prohibition', 'Supera 20 MW: fuera del rango PCH', 'Un aprovechamiento de este tamaño es una central mediana o grande (licencia ANLA desde 100 MW). En la ficha se dimensiona hasta 19,9 MW.']);
  if (c?.existing_plants?.length) pills.push(['prohibition', 'Central existente a menos de 2 km', `${c.existing_plants.map(p => `${p.name} (${fmt(p.mw, 1)} MW)`).join(', ')}: es probable que este salto ya esté aprovechado.`]);
  if (r?.regFrac > 0.1 || qf & 8) pills.push(['prohibition', `Caudal regulado por embalse${r?.regName ? ' (' + r.regName + ')' : ''}`, `El ${fmt((r?.regFrac || sel.site?.reg || 0) * 100)} % de la cuenca está aguas arriba de un embalse: el caudal depende de la operación de esa central y el cálculo regional no aplica.`]);
  if (qf & 1 || (o && maxStepShare(o) > 0.3)) pills.push(['review', 'Salto concentrado en un solo punto del perfil', 'Más del 30 % del salto está en un paso de ~100 m: puede ser una cascada, una presa, una obra existente o un error del modelo de elevación. Confirmar con topografía.']);
  if (qf & 2) pills.push(['review', 'Pendiente atípica para un río grande', 'La caída del sitio es 10 o más veces la pendiente regional del río: probable artefacto del modelo de elevación (agua editada o cañón no resuelto).']);
  if (c?.tunnel_km > 0.2) pills.push(['review', `Conducción probable en túnel (~${fmt(c.tunnel_km, 1)} km)`, `La línea recta cruza terreno hasta ${fmt(c.crest_m)} m por encima de la bocatoma: requiere túnel o un trazado más largo por la ladera.`]);
  if (c?.zni) pills.push(['review', 'Posible zona no interconectada', 'Sin red del sistema nacional a menos de 50 km: el uso típico es abastecer comunidades (referencia: diésel, ~1.400 COP/kWh).']);
  return pills.map(([sev, t, d]) => `<div class="detail-pill ${sev}"><b>${esc(t)}</b><br>${esc(d)}</div>`).join('');
}
const maxStepShare = o => { const z = o.path.map(s => s.z).filter(isNum); let m = 0; for (let i = 1; i < z.length; i++) m = Math.max(m, z[i - 1] - z[i]); return o.head > 0 ? m / o.head : 0; };

function constraintPills(mask, hits) {
  const list = constraintsOf(mask || 0);
  if (!list.length) return '<div class="detail-pill neutral">Sin coincidencias del corredor con las capas de restricción incorporadas. No equivale a viabilidad ni autorización: faltan, por ejemplo, POMCA, rondas hídricas, zonificaciones de las CAR y zonas de utilidad pública.</div>';
  return list.map(c => {
    const own = (hits || []).filter(h => h.bit === c.bit);
    const names = own.map(h => h.name).filter(Boolean);
    let sev = c.severity, note = c.note;
    if (c.key === 'protected') {           // la categoría concreta define el régimen (revisión legal)
      const special = own.map(h => protectedCategoryNote(h.category)).find(Boolean);
      if (special) { sev = special.severity; note = special.note; }
    }
    return `<div class="detail-pill ${sev}"><b>${esc(c.label)}</b>${names.length ? ': ' + esc(names.slice(0, 3).join(', ')) + (names.length > 3 ? '…' : '') : ''}<br>${esc(note)}</div>`;
  }).join('');
}

function summaryHTML(sel) {
  const r = sel.reach, o = sel.option;
  let html = '';
  if (o) {
    const band = bandOf(o.pKW || 0);
    const sc = computeScenario(sel);
    html += `<span class="metric-label">Potencia de referencia${sel.kind === 'site' ? '' : ' del mejor esquema desde este tramo'}</span>
      <div class="power-readout ${o.pKW > 20000 ? 'over' : ''}"><strong>${esc(power(o.pKW).split(' ')[0])}</strong><span>${esc(power(o.pKW).split(' ')[1] || '')}</span></div>
      <span class="source-badge">${symbolSVG('power-' + band.key)} ${esc(band.label.toUpperCase())}${sel.kind === 'site' ? ` · SITIO N.º ${fmt(sel.site.id)}` : ''}</span>
      ${qualityPills(sel)}
      ${constraintPills(sel.kind === 'site' ? sel.site.m : r.mask, sel.context?.hits)}
      ${kv([
        ['Salto bruto', fmt(o.head, 1) + ' m'],
        ['Conducción en línea recta', fmt(o.conduitKm, 2) + ' km'],
        ['Salto por km de conducción', fmt(o.head / Math.max(o.conduitKm, .05), 0) + ' m/km'],
        ['Tramo con caudal reducido', fmt(o.path.at(-1).d, 2) + ' km'],
        ['Caudal de diseño', flow(o.qDesign)],
        ['Elevación bocatoma → casa de máquinas', `${fmt(o.path[0].z)} → ${fmt(o.path.at(-1).z)} m`],
      ])}
      <div class="detail-section-title">Perfil del lecho <span class="mini-tag">FABDEM · CONDICIONADO</span></div>
      ${profileSVG(o)}
      <div class="route-endpoints"><span><i></i>Bocatoma</span><span><i></i>Casa de máquinas</span></div>
      ${o.head < 20 ? '<div class="detail-pill review">Salto pequeño frente a la precisión del modelo de elevación (unos pocos metros). Requiere confirmación topográfica.</div>' : ''}
      <div class="detail-divider"></div>
      <div class="detail-section-title">Prediseño y energía <span class="mini-tag">PRELIMINAR</span></div>
      <p class="detail-note">Esquema canal + tubería de presión, turbina según salto y potencia, y energía con la curva de duración de caudales de la subzona (IRH del IDEAM). Cambia los supuestos para comparar.</p>
      <div class="scenario-form">
        <label>Caudal de diseño (m³/s)<input id="sc-q" type="number" min="0" step="0.01" value="${isNum(S.scenario.q) ? S.scenario.q : +o.qDesign.toFixed(3)}"></label>
        <label>Caudal ambiental<select id="sc-amb">
          <option value="ena" ${S.scenario.amb === 'ena' ? 'selected' : ''}>ENA (planificación)</option>
          <option value="conservador" ${S.scenario.amb === 'conservador' ? 'selected' : ''}>Conservador (Q75)</option>
          <option value="libre" ${S.scenario.amb === 'libre' ? 'selected' : ''}>Valor propio</option></select></label>
        <label>Caudal ambiental propio (m³/s)<input id="sc-ambv" type="number" min="0" step="0.01" value="${isNum(S.scenario.ambValue) ? S.scenario.ambValue : ''}" ${S.scenario.amb === 'libre' ? '' : 'disabled'}></label>
        <label>Eficiencia (%)<input id="sc-eta" type="number" min="40" max="95" step="1" placeholder="auto" value="${isNum(S.scenario.eta) ? S.scenario.eta : ''}"></label>
      </div>
      <div id="scenario-result" class="scenario-result">${scenarioHTML(sc)}</div>`;
    if (sel.originalSel)
      html += `<button class="secondary-button wide-button" id="restore-option">${icon('arrow')} Volver al esquema original</button>`;
  } else {
    html += `<span class="source-badge">RED HIDROGRÁFICA UNIFICADA</span>
      ${r.regFrac > 0.1 ? qualityPills(sel) : ''}
      <div class="detail-pill neutral">Desde este tramo no hay un esquema con salto ≥ ${S.params.minHead} m, conducción ≤ ${S.params.maxConduit} km y al menos ${S.params.minGradient} m de salto por km de conducción.</div>`;
  }
  html += `<div class="detail-divider"></div><div class="detail-section-title">Buscar otro esquema desde este tramo</div>
    <p class="detail-note">Ajusta los criterios y el navegador vuelve a recorrer el río aguas abajo con el perfil FABDEM.</p>
    <div class="scenario-form params-form">
      <label>Conducción máx. (km)<input id="pa-conduit" type="number" min="0.1" max="10" step="0.1" value="${S.params.maxConduit}"></label>
      <label>Salto mínimo (m)<input id="pa-head" type="number" min="2" max="500" step="1" value="${S.params.minHead}"></label>
      <label>Salto por km mín. (m/km)<input id="pa-grad" type="number" min="0" max="500" step="1" value="${S.params.minGradient}"></label>
      <label>Recorrido máx. (km)<input id="pa-river" type="number" min="0.5" max="9" step="0.5" value="${S.params.maxRiver}"></label>
    </div>
    <button class="primary-button wide-button" id="research">${icon('arrow')} Buscar desde este tramo</button>
    <div class="detail-divider"></div>${kv([
      ['Cuenca aportante', fmt(r.upa, 1) + ' km²'], ['Longitud del tramo', fmt(r.length, 2) + ' km'],
      ['Orden del cauce (Strahler)', r.strahler], ['Subzona hidrográfica', subzoneName(r.szh)]])}`;
  return html;
}

function scenarioHTML(sc) {
  if (!sc) return 'Introduce un caudal de diseño para calcular.';
  const p = sc.pre, gwh = sc.energyMWh / 1000;
  return `<div class="scenario-grid">
    <div><span>Potencia instalable</span><strong>${esc(power(sc.pKW))}</strong>${p.capped ? '<small>limitada a 19,9 MW</small>' : ''}</div>
    <div><span>Energía anual</span><strong>${gwh >= 1 ? fmt(gwh, 2) + ' GWh' : fmt(sc.energyMWh, 0) + ' MWh'}</strong><small>≈ ${fmt(sc.energyMWh * 1000 / 1800, 0)} hogares*</small></div>
    <div><span>Factor de planta</span><strong>${fmt(sc.plantFactor * 100, 0)} %</strong></div>
    <div><span>Turbina sugerida</span><strong>${esc(p.type)}</strong><small>${p.units} unidad${p.units > 1 ? 'es' : ''}</small></div>
  </div>
  ${kv([
    ['Salto neto', `${fmt(p.hn, 1)} m (pérdidas ${fmt(p.lossPct, 0)} %)`],
    ['Diámetro de la tubería', `${fmt(p.d, 2)} m · ${fmt(p.lp / 1000, 2)} km de tubería + ${fmt(p.lCanal / 1000, 2)} km de canal`],
    ['Velocidad en la tubería', fmt(p.v, 1) + ' m/s'],
    ['Eficiencia', fmt(sc.eta * 100, 0) + ' %' + (isNum(S.scenario.eta) ? ' (propia)' : ' (según turbina y tamaño)')],
    ['Tiempo de arranque del agua', fmt(p.tw, 1) + ' s' + (p.tw > 3 ? ' · requiere chimenea o válvula de alivio' : '')],
    ['Caudal ambiental supuesto', flow(sc.ambient)],
    ['Caudal medio turbinado', flow(sc.qTurb)],
  ])}
  <p class="detail-note">* Hogares a 150 kWh/mes. Curva de duración lognormal calibrada con el IRH de la subzona (${isNum(sc.irh) ? fmt(sc.irh, 2) : 'sin dato, 0,65'}): es una estimación sin series diarias del sitio.</p>`;
}

function profileSVG(o) {
  const pts = o.path.filter(s => isNum(s.z));
  if (pts.length < 2) return '<p class="detail-note">El perfil no tiene elevaciones suficientes.</p>';
  const w = 310, h = 175, L = 44, R = 10, T = 22, B = 28;
  let min = Math.min(...pts.map(s => s.z)), max = Math.max(...pts.map(s => s.z));
  const pad = Math.max(4, (max - min) * .15); min -= pad; max += pad;
  const len = pts.at(-1).d || 1;
  const x = d => L + d / len * (w - L - R), y = v => h - B - (v - min) / (max - min) * (h - T - B);
  const path = pts.map((s, i) => (i ? 'L' : 'M') + x(s.d).toFixed(1) + ',' + y(s.z).toFixed(1)).join(' ');
  const a = pts[0], b = pts.at(-1);
  const stepY = [5, 10, 20, 50, 100, 200, 500].find(s => (max - min) / s <= 5) || 1000;
  let ticks = '';
  for (let v = Math.ceil(min / stepY) * stepY; v <= max; v += stepY)
    ticks += `<path class="profile-grid" d="M${L} ${y(v).toFixed(1)}H${w - R}"/><text x="${L - 5}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${fmt(v)}</text>`;
  const stepX = len > 4 ? 1 : len > 2 ? 0.5 : 0.25;
  for (let d = stepX; d < len; d += stepX) ticks += `<text x="${x(d).toFixed(1)}" y="${h - 10}" text-anchor="middle">${fmt(d, 2)}</text>`;
  return `<svg class="profile" viewBox="0 0 ${w} ${h}" role="img" aria-label="Perfil del lecho: de ${fmt(a.z)} a ${fmt(b.z)} metros en ${fmt(len, 2)} kilómetros por el cauce">
    <text x="${L}" y="12" class="profile-axis-title">Elevación (m s. n. m.)</text>
    ${ticks}
    <path class="profile-axis" d="M${L} ${T}V${h - B}H${w - R}"/>
    <path class="profile-area" d="${path} L${x(b.d)},${h - B} L${x(a.d)},${h - B} Z"/>
    <path class="profile-line" d="${path}"/>
    <path class="profile-head" d="M${x(a.d)},${y(a.z)} H${x(b.d)} V${y(b.z)}"/>
    <text x="${x(b.d) - 4}" y="${(y(a.z) + y(b.z)) / 2}" text-anchor="end" class="profile-label">H ≈ ${fmt(o.head, 0)} m</text>
    <circle cx="${x(a.d)}" cy="${y(a.z)}" r="4" class="profile-intake"/><rect x="${x(b.d) - 4}" y="${y(b.z) - 4}" width="8" height="8" class="profile-powerhouse"/>
    <text x="${L}" y="${h - 10}" text-anchor="start">0</text><text x="${w - R}" y="${h - 10}" text-anchor="end">${fmt(len, 2)} km</text></svg>`;
}

function hydrologyHTML(sel) {
  const r = sel.reach, sz = S.subzonas?.[r.szh];
  const sigma = fdcSigma(sz?.irh), qm = r.q.medio;
  let html = `<div class="detail-section-title" style="margin-top:0">Caudal regionalizado · ENA 2022 (IDEAM)</div>
    ${r.regFrac > 0.1 ? `<div class="detail-pill prohibition"><b>Caudal regulado${r.regName ? ' por ' + esc(r.regName) : ''}</b><br>El ${fmt(r.regFrac * 100)} % de la cuenca está aguas arriba de un embalse: estos valores describen el régimen natural, no el real.</div>` : ''}
    ${kv([['Caudal medio, año medio', flow(r.q.medio)], ['Caudal medio, año seco', flow(r.q.seco)], ['Caudal medio, año húmedo', flow(r.q.humedo)],
      ['Oferta disponible, año medio', flow(r.q.disp)], ['Oferta disponible, año seco', flow(r.q.dispSeco)]])}
    <p class="detail-note" style="margin-top:10px">Rendimiento hídrico de la subzona × cuenca aportante, acumulado por la red. "Disponible" descuenta el caudal ambiental <b>de planificación</b> de la ENA; el exigible lo fija la autoridad ambiental en la concesión o la licencia. Son promedios de largo plazo: el error frente a estaciones del IDEAM puede ser de ±40 %, sobre todo en cabeceras.</p>`;
  if (r.external) html += '<div class="detail-pill review">Parte de la cuenca de este tramo está fuera de la red cargada (frontera): el caudal puede estar subestimado.</div>';
  html += `<div class="detail-section-title">Curva de duración estimada</div>
    ${kv([['Q95', flow(fdcQ(qm, sigma, .95))], ['Q50 (mediana)', flow(fdcQ(qm, sigma, .5))], ['Q30', flow(fdcQ(qm, sigma, .3))],
      ['IRH de la subzona', isNum(sz?.irh) ? fmt(sz.irh, 2) : 'Sin dato (se usa 0,65)']])}
    <p class="detail-note">Lognormal con la media de la ENA y la dispersión que implica el Índice de Regulación Hídrica. Orientativa: sin series diarias del sitio.</p>`;
  if (sz) html += `<div class="detail-section-title">Subzona ${esc(r.szh)}</div>${kv([['Nombre', sz.name], ['Área hidrográfica', sz.area],
    ['Rendimiento, año medio', fmt(sz.rend_medio, 1) + ' L/s/km²'], ['Rendimiento, año seco', fmt(sz.rend_seco, 1) + ' L/s/km²'],
    ['IUA, año medio / seco', `${sz.iua_medio || '—'} / ${sz.iua_seco || '—'}`]])}
    ${/alto|cr[ií]tic/i.test(sz.iua_seco || '') ? '<div class="detail-pill review"><b>Uso del agua alto en año seco</b><br>Hay competencia por el agua en la subzona: revisar concesiones existentes aguas arriba.</div>' : ''}`;
  html += `<div class="detail-divider"></div><div class="detail-section-title">Contraste con otras fuentes</div>
    ${kv([['Q95 Atlas UPME (clase indicativa)', r.q95 ? r.q95 + ' m³/s' : 'Sin correspondencia'], ['Caudal medio HydroRIVERS (1971–2000)', flow(r.qHydroRivers)]])}
    <p class="detail-note" style="margin-top:10px">La clase Q95 de la UPME y el modelo global HydroRIVERS sirven de contraste, no de validación: son otros modelos. La validación real requiere series medidas del IDEAM.</p>`;
  html += `<div class="detail-divider"></div><div class="detail-section-title">Estaciones IDEAM cercanas</div>`;
  const st = S.data.stations?.features;
  if (!st) { html += `<p class="detail-note">Cargando estaciones…</p>`; void ensureLayerData('stations', 'data/stations.geojson', 'stations').then(() => S.selection === sel && S.tab === 'hydrology' && renderDetail()); }
  else {
    const near = st.map(f => ({p: f.properties, d: distance(sel.coord, f.geometry.coordinates)})).sort((a, b) => a.d - b.d).slice(0, 4);
    html += near.map(({p, d}) => `<div class="context-item"><b>${esc(p.name)}</b><p>${esc(p.code)} · ${esc(p.status)} · ${fmt(d, 1)} km<br>${esc(p.river || p.category || '')}</p></div>`).join('');
  }
  html += `<div class="detail-pill neutral">Para un estudio se necesitan series diarias de caudal (curva de duración real), calidad del dato y usos existentes. El IDEAM publica caudales diarios de 943 estaciones en datos abiertos.</div>${link('https://www.datos.gov.co/d/jxnq-r3i9', 'Caudales diarios IDEAM (datos abiertos)')} · ${link('https://dhime.ideam.gov.co/atencionciudadano/', 'DHIME')}`;
  return html;
}

function contextHTML(sel) {
  const c = sel.context, r = sel.reach;
  let html = `<div class="detail-section-title" style="margin-top:0">Restricciones en el corredor</div>
    <p class="detail-note">Bocatoma, conducción, tramo con caudal reducido y casa de máquinas, con un margen de 100 m.</p>
    ${constraintPills(sel.kind === 'site' ? sel.site.m : r.mask, c?.hits)}`;
  if (c?.hits?.length) html += c.hits.map(h => `<div class="context-item"><b>${esc(h.name)}</b><p>${esc(h.category)}<br>${esc(h.status || '')}${h.act ? '<br>' + esc(h.act) : ''}${h.people ? '<br>Pueblo: ' + esc(h.people) : ''}</p>${h.url ? link(h.url) : ''}</div>`).join('');
  if (c?.near_ethnic?.length || c?.near_spnn?.length) {
    html += `<div class="detail-section-title">Cerca del corredor</div>`;
    if (c.near_ethnic.length) html += `<div class="detail-pill consult"><b>Territorio étnico a ≤ 2 km:</b> ${esc(c.near_ethnic.map(e => `${e.name} (${fmt(e.km, 1)} km)`).join(', '))}<br>La consulta previa depende de la afectación directa, no solo del título: pedir pronunciamiento de procedencia a la Dirección de la Autoridad Nacional de Consulta Previa.</div>`;
    if (c.near_spnn.length) html += `<div class="detail-pill review"><b>Parque Nacional a ≤ 5 km:</b> ${esc(c.near_spnn.map(e => `${e.name} (${fmt(e.km, 1)} km)`).join(', '))}<br>El entorno cumple una función amortiguadora (Decreto 1076, art. 2.2.2.1.3.10); si la zona amortiguadora está determinada, la licencia es de la ANLA con concepto de Parques.</div>`;
  }
  html += `<div class="detail-divider"></div><div class="detail-section-title">Amenaza por movimientos en masa</div><div id="hazard-box">${hazardHTML()}</div>`;
  html += `<div class="detail-divider"></div><div class="detail-section-title">Conexión a la red</div>`;
  if (c?.grid) {
    const g = c.grid, t = g.target;
    html += kv([['Nivel de tensión sugerido', `${g.level_kv} kV`], ['Subestación objetivo', `${t.name} · ${t.kv} kV`],
      t.mva ? ['Capacidad y carga', `${fmt(t.mva, 1)} MVA · ${fmt(t.load_pct, 0)} % de carga`] : null,
      ['Distancia en línea recta', fmt(g.km, 1) + ' km (trazado ≈ ×1,3)'],
      ['Costo indicativo de conexión', `${fmt(g.cost_mcop)} millones COP (${fmt(g.cost_mcop_kw, 2)} M/kW)`]]);
    html += `<p class="detail-note" style="margin-top:8px">Se elige la opción más barata que cumple la caída de tensión (13,2 kV hasta 15 MW·km; 34,5 kV hasta 200 MW·km). Fuente: subestaciones de distribución UPME (con MVA y carga) y transmisión UPME. La cercanía no acredita capacidad disponible: la confirma el operador de red o la UPME.</p>`;
    html += kv([['Municipio', c.municipality], ['Departamento', c.department]]);
    if (c.existing_plants?.length) html += `<div class="detail-pill prohibition"><b>Central existente a menos de 2 km del corredor:</b> ${esc(c.existing_plants.map(p => `${p.name} (${fmt(p.mw, 1)} MW)`).join(', '))}.</div>`;
    if (c.assigned_projects?.length) html += `<div class="detail-pill review"><b>Proyecto con capacidad asignada cerca:</b> ${esc(c.assigned_projects.map(p => `${p.name} (${fmt(p.mw, 1)} MW, ${p.state})`).join(', '))}.</div>`;
    if (c.municipal_plants?.length) html += `<div class="detail-pill neutral">En el municipio hay centrales con ubicación aproximada: ${esc(c.municipal_plants.join(', '))}.</div>`;
  } else {
    const subs = S.data.substations?.features, ref = sel.option?.powerhouse || sel.coord;
    if (subs) { const n = subs.map(f => ({p: f.properties, d: distance(ref, f.geometry.coordinates)})).sort((a, b) => a.d - b.d)[0];
      html += kv([['Subestación de transmisión más cercana', `${n.p.name} · ${fmt(n.p.voltageKV)} kV · ${fmt(n.d, 1)} km`]]) + '<p class="detail-note">El análisis de la red de distribución está disponible en los sitios candidatos.</p>'; }
    else html += '<p class="detail-note">Cargando subestaciones…</p>';
  }
  html += `<div class="detail-divider"></div>${kv([['Bocatoma (lat, lon)', sel.option ? `${fmt(sel.option.intake[1], 5)}, ${fmt(sel.option.intake[0], 5)}` : `${fmt(sel.coord[1], 5)}, ${fmt(sel.coord[0], 5)}`],
    sel.option && ['Casa de máquinas (lat, lon)', `${fmt(sel.option.powerhouse[1], 5)}, ${fmt(sel.option.powerhouse[0], 5)}`]])}`;
  return html;
}

function businessHTML(sel) {
  const sc = computeScenario(sel), c = sel.context;
  if (!sc) return '<p class="detail-note">Este tramo no tiene un esquema calculado. Prueba "Buscar otro esquema" en el resumen.</p>';
  const e = economics({pKW: sc.pKW, head: sc.pre.hn, energyMWh: sc.energyMWh, tunnelKm: c?.tunnel_km || 0, gridMCOP: c?.grid?.cost_mcop || 0, opts: S.econ});
  const o = e.o;
  const usd = v => v >= 1e6 ? `${fmt(v / 1e6, 1)} M USD` : `${fmt(v / 1e3, 0)} mil USD`;
  const tags = c?.regulatory || [];
  return `<div class="detail-pill review" style="margin-top:0"><b>Orden de magnitud, no presupuesto.</b> Costos de referencia internacional (IRENA) ajustados por tamaño y salto; banda de −30 % a +50 %. Sin impuestos, deuda ni costos de desarrollo.</div>
    <div class="scenario-grid">
      <div><span>Inversión indicativa</span><strong>${usd(e.capex)}</strong><small>${usd(e.capexLow)} – ${usd(e.capexHigh)}</small></div>
      <div><span>Por kW instalado</span><strong>${fmt(e.capex / sc.pKW, 0)} USD/kW</strong></div>
      <div><span>Costo nivelado</span><strong>${fmt(e.lcoeCOP, 0)} COP/kWh</strong><small>${e.lcoeCOP <= o.priceCOPkWh ? 'por debajo' : 'por encima'} del precio supuesto</small></div>
      <div><span>Retorno simple</span><strong>${isFinite(e.payback) ? fmt(e.payback, 1) + ' años' : 'No se recupera'}</strong></div>
    </div>
    ${kv([['Planta (obras y equipos)', usd(e.plantUSD)], e.tunnelUSD ? ['Túnel probable', usd(e.tunnelUSD)] : null,
      ['Conexión a la red', e.gridUSD ? usd(e.gridUSD) : 'Sin dato (solo en sitios candidatos)'],
      ['Energía anual', fmt(sc.energyMWh / 1000, 2) + ' GWh'], ['Ingresos anuales', `${fmt(e.revenueCOP / 1e6, 0)} millones COP`]])}
    <div class="detail-section-title">Supuestos editables</div>
    <div class="scenario-form econ-form">
      <label>Precio de venta (COP/kWh)<input id="ec-price" type="number" min="50" max="3000" step="10" value="${o.priceCOPkWh}"></label>
      <label>TRM (COP/USD)<input id="ec-trm" type="number" min="1000" max="10000" step="50" value="${o.trm}"></label>
      <label>Tasa de descuento (%)<input id="ec-rate" type="number" min="1" max="30" step="0.5" value="${o.rate * 100}"></label>
      <label>Vida útil (años)<input id="ec-years" type="number" min="10" max="60" step="1" value="${o.years}"></label>
    </div>
    <p class="detail-note">Referencias: contratos de largo plazo ~300–335 COP/kWh; bolsa 2022–2026 entre ~220 y ~680 COP/kWh de promedio anual, con picos en El Niño, cuando una central a filo de agua produce menos. En zonas no interconectadas la referencia es el diésel (~1.400 COP/kWh).</p>
    <div class="detail-section-title">Clase regulatoria</div>
    ${tags.length ? `<ul class="plain-list">${tags.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '<p class="detail-note">Disponible en los sitios candidatos.</p>'}`;
}

function stepsHTML(sel) {
  const o = sel.option, c = sel.context, mask = sel.kind === 'site' ? sel.site.m : sel.reach.mask;
  const pKW = o?.pKW || 0;
  const zni = !!c?.zni;
  const ethnic = (mask & (32 | 64)) || c?.near_ethnic?.length;
  const forest = (mask & 16) || (c?.hits || []).some(h => /reserva forestal protectora/i.test(h.category || ''));
  const paramo = mask & 8;
  const anla = pKW >= 100000 || c?.near_spnn?.length;
  const steps = [
    ['Verificar el sitio en campo', 'Topografía del salto, aforos de caudal y recorrido de la conducción. Revisar las alertas de calidad de la ficha.', 'Consultor', '1–3 meses'],
    ['Predios y uso del suelo', 'Estudio de títulos (folios de matrícula) y certificado de uso del suelo según el POT o EOT del municipio.', 'Oficina de Registro · Alcaldía', 'Semanas'],
    ['Permiso de estudio del recurso hídrico', 'Da prioridad frente a otros solicitantes de concesión.', 'Corporación autónoma regional (CAR)', '1–3 meses'],
    ['Determinantes ambientales y DAA', 'Pedir a la CAR los determinantes (POMCA, rondas, áreas protegidas) y su pronunciamiento sobre la necesidad del Diagnóstico Ambiental de Alternativas (Decreto 1076, art. 2.2.2.3.4.2).', 'CAR', '1–3 meses'],
    ['Registro del proyecto en la UPME (fase 1)', 'Registro de proyectos de generación por fases (Resolución UPME 749 de 2025).', 'UPME', '1 mes'],
  ];
  if (ethnic) steps.push(['Procedencia de consulta previa', 'Solicitar el pronunciamiento de procedencia. Si procede: preconsulta, consulta y protocolización.', 'Dirección de la Autoridad Nacional de Consulta Previa (MinInterior)', '1–3 meses; consulta 6–24+ meses']);
  if (forest) steps.push(['Sustracción de la reserva forestal', 'Antes de la licencia (Resolución 1705 de 2024).', 'MinAmbiente (o la CAR en reservas regionales)', '6–18 meses']);
  if (paramo) steps.push(['Concepto previo del MinAmbiente (páramo)', 'Ley 1930 de 2018, art. 5 par. 2. En la práctica, las obras en páramo son inviables.', 'MinAmbiente', '—']);
  if (zni && pKW <= 10000) steps.push(['Concesión de aguas y ocupación de cauce', 'En zonas no interconectadas, las centrales de hasta 10 MW no requieren licencia ambiental, pero sí estos permisos.', 'CAR', '3–9 meses']);
  else steps.push(['Estudio de impacto ambiental y licencia', `${anla ? 'Licencia de la ANLA (≥ 100 MW o zona amortiguadora determinada de un Parque Nacional).' : 'Licencia de la CAR: en el sistema interconectado toda hidroeléctrica de menos de 100 MW la requiere.'} La licencia incluye la concesión de aguas (20 a 50 años), la ocupación de cauce y los aprovechamientos.`, anla ? 'ANLA' : 'CAR', 'EIA 8–14 meses; evaluación 4–12 meses']);
  steps.push(['Arqueología preventiva', 'Registro, diagnóstico y plan de manejo aprobado antes de obras (Decreto 138 de 2019).', 'ICANH', '3–9 meses']);
  if (!zni) steps.push(['Conexión a la red', `Solicitud de capacidad de transporte y concepto de conexión${c?.grid ? ` (nivel sugerido ${c.grid.level_kv} kV)` : ''} (CREG 075 de 2021).`, pKW < 1000 ? 'Operador de red' : 'UPME · operador de red', '6–18 meses']);
  steps.push(['Servidumbres y predios', 'Servidumbres de conducción de aguas y de línea eléctrica.', 'Propietarios · juez si no hay acuerdo', '6–24 meses']);
  steps.push(['Registro para operar', `${pKW >= 1000 ? 'Registro como planta menor ante XM' : 'Registro como generación distribuida o autogeneración'}${pKW > 10000 ? '; transferencias del 6 % de las ventas (Ley 99, art. 45)' : ''}.`, pKW >= 1000 ? 'XM' : 'Operador de red', 'Antes de operar']);
  return `<div class="detail-pill neutral" style="margin-top:0">Ruta general de trámites para una PCH en Colombia, adaptada a las alertas de este sitio. Revisada por el abogado del panel; no reemplaza asesoría legal. <b>Duración realista antes de construir: 3 a 6 años.</b></div>
    <ol class="steps-list">${steps.map(([t, d, who, time]) => `<li><b>${esc(t)}</b><p>${esc(d)}</p><small>${esc(who)} · ${esc(time)}</small></li>`).join('')}</ol>
    <p class="detail-note">Fuentes: Decreto 1076 de 2015; Ley 21 de 1991; Ley 1930 de 2018; Resolución MADS 1705 de 2024; Resolución UPME 749 de 2025; CREG 075 de 2021; Decreto 138 de 2019.</p>`;
}

// Consulta en vivo del resumen municipal de amenaza del SGC (no se redistribuyen sus datos).
async function loadHazard(sel) {
  const [x, y] = sel.option?.intake || sel.coord;
  S.hazard = {loading: true};
  const url = `https://srvags.sgc.gov.co/arcgis/rest/services/Mapa_Nacional_Amenaza_Mov_Masa_100K/Mapa_Nacional_Amenaza_Movimientos_Masa_100K/MapServer/identify?geometry=${x},${y}&geometryType=esriGeometryPoint&sr=4326&layers=all:3&tolerance=0&mapExtent=${x - .1},${y - .1},${x + .1},${y + .1}&imageDisplay=400,400,96&returnGeometry=false&f=json`;
  try {
    const r = await json(url, 12000);
    const a = r.results?.[0]?.attributes;
    S.hazard = a ? {municipality: a.MUNICIPIO, department: a.DEPARTAMEN, baja: +a.SUM_BAJA, media: +a.SUM_MEDIA, alta: +a.SUM_ALTA, muyAlta: +(a.SUM_Muy_Al ?? a.SUM_MUY_AL)} : {empty: true};
  } catch { S.hazard = {error: true}; }
  if (S.selection === sel && $('#hazard-box')) $('#hazard-box').innerHTML = hazardHTML();
}
function hazardHTML() {
  const h = S.hazard;
  if (!h || h.loading) return '<p class="detail-note">Consultando el servicio del SGC…</p>';
  if (h.error) return `<p class="detail-note">El servicio del SGC no respondió. ${link('https://www2.sgc.gov.co/sgc/mapas/Paginas/Imagenes-de-amenazas-.aspx', 'Mapas de amenaza del SGC')}</p>`;
  if (h.empty) return '<p class="detail-note">Sin dato del SGC para este punto.</p>';
  const bar = (v, cls) => `<span class="hz ${cls}" style="width:${Math.max(0, Math.min(100, v))}%"></span>`;
  return `<p class="detail-note">Distribución del área del municipio de <b>${esc(h.municipality)}</b> (${esc(h.department)}) por categoría de amenaza, Mapa Nacional 1:100.000. Es un dato municipal, no del sitio.</p>
    <div class="hazard-bar">${bar(h.baja, 'low')}${bar(h.media, 'mid')}${bar(h.alta, 'high')}${bar(h.muyAlta, 'vhigh')}</div>
    ${kv([['Baja', fmt(h.baja, 1) + ' %'], ['Media', fmt(h.media, 1) + ' %'], ['Alta', fmt(h.alta, 1) + ' %'], ['Muy alta', fmt(h.muyAlta, 1) + ' %']])}
    <p class="detail-note" style="margin-top:8px">Activa la capa "Amenaza por movimientos en masa" para ver la zonificación sobre el mapa.</p>`;
}

function featureHTML(sel) {
  const p = sel.feature.properties;
  if (sel.kind === 'plant') return `<span class="metric-label">Capacidad publicada</span><div class="power-readout"><strong>${fmt(p.capacityMW, 2)}</strong><span>MW</span></div>
    <span class="source-badge">${esc(p.status || 'Estado sin dato')} · XM / UPME</span>${kv([['Municipio', p.municipality], ['Operador', p.operator], ['Entrada en operación', p.operationDate || 'Sin dato']])}
    <div class="detail-pill ${p.locationType === 'municipal-reference' ? '' : 'neutral'}">${esc(p.locationNote || 'Coordenada de referencia de la fuente.')}</div>${link(p.sourceUrl)}`;
  if (sel.kind === 'station') return `<span class="source-badge">IDEAM · CATÁLOGO DE ESTACIONES</span>${kv([['Código', p.code], ['Estado', p.status], ['Categoría', p.category], ['Corriente registrada', p.river || 'Sin dato'], ['Altitud', p.altitudeM ? fmt(p.altitudeM) + ' m' : 'Sin dato'], ['Instalación', p.installedAt]])}
    <div class="detail-pill neutral">Las series de caudal no están incorporadas: se consultan en DHIME.</div>${link('https://dhime.ideam.gov.co/atencionciudadano/', 'Consultar series en DHIME')}`;
  if (sel.kind === 'substation') return `<span class="source-badge">INFRAESTRUCTURA ELÉCTRICA · UPME</span>${kv([['Tensión', fmt(p.voltageKV) + ' kV'], ['Sistema', p.system], ['Propietario', p.owner], ['Vigencia del registro', p.recordValidity]])}<p class="detail-note" style="margin-top:12px">${esc(p.connectionNote)}</p>${link(p.sourceUrl)}`;
  if (sel.kind === 'project') return `<span class="metric-label">Capacidad de transporte asignada</span><div class="power-readout"><strong>${fmt(p.mw, 2)}</strong><span>MW</span></div>
    <span class="source-badge">${esc(p.tech)} · ${esc(p.state)}</span>${kv([['Promotor', p.promoter], ['Punto de conexión', p.connection], ['Municipio', p.municipality], ['Año de entrada prevista', p.fpo]])}
    <div class="detail-pill neutral">Coordenada publicada por la UPME; puede representar el municipio y no las obras.</div>${link('https://geo.upme.gov.co/server/rest/services/Capas_EnergiaElectrica/capacidad_asignada/FeatureServer/31', 'Capa UPME')}`;
  if (sel.kind === 'upme2015') return `<span class="metric-label">Potencia de referencia del Atlas 2015</span><div class="power-readout"><strong>${fmt(p.powerMW >= 1 ? p.powerMW : p.powerKW, 2)}</strong><span>${p.powerMW >= 1 ? 'MW' : 'kW'}</span></div>
    <span class="source-badge">UPME · ATLAS 2015 · ${esc(String(p.category).toUpperCase())}</span><p class="detail-note">Máximo de referencia por subzona y categoría del estudio de 2015. Se muestra solo para comparar con el cálculo nuevo.</p>${kv([['Subzona', p.name], ['Código', p.subzoneCode]])}${link(p.sourceUrl, 'Dato original de la UPME')}`;
  return '';
}

/* ───────────── Mini mapa de la ficha ───────────── */
async function updateMiniMap() {
  const sel = S.selection; if (!sel) return;
  if (mini) { mini.remove(); mini = null; }
  const m = mini = new maplibregl.Map({container: 'mini-map', style: baseStyle(), center: sel.coord, zoom: 11, interactive: false, attributionControl: false, renderWorldCopies: false});
  m.once('load', () => {
    if (mini !== m) return;
    m.addSource('sat', {type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 18});
    m.addLayer({id: 'sat', type: 'raster', source: 'sat', paint: {'raster-opacity': .9}});
    for (const t of ['mid', ...MINOR_TIERS]) {
      m.addSource('r-' + t, {type: 'vector', url: 'pmtiles://' + abs(versioned(V + `tiles/rivers-${t}.pmtiles`))});
      m.addLayer({id: 'r-' + t, type: 'line', source: 'r-' + t, 'source-layer': 'rivers', paint: {'line-color': '#9fd3e0', 'line-width': 1.2, 'line-opacity': .9}});
    }
    if (sel.option) {
      m.addSource('route', {type: 'geojson', data: fc([lineFeature(sel.option.path.map(s => [s.x, s.y]))])});
      m.addLayer({id: 'route', type: 'line', source: 'route', paint: {'line-color': '#f0a44b', 'line-width': 3.5}});
      m.addSource('conduit', {type: 'geojson', data: fc([lineFeature([sel.option.intake, sel.option.powerhouse])])});
      m.addLayer({id: 'conduit', type: 'line', source: 'conduit', paint: {'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [2, 1.2]}});
      m.addSource('pts', {type: 'geojson', data: fc([pointFeature(sel.option.intake, {role: 'intake'}), pointFeature(sel.option.powerhouse, {role: 'ph'})])});
      m.addLayer({id: 'pts', type: 'circle', source: 'pts', paint: {'circle-radius': 5, 'circle-color': ['case', ['==', ['get', 'role'], 'intake'], '#2f8a6f', '#e09a43'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5}});
      m.fitBounds(bboxOf(lineFeature([...sel.option.path.map(s => [s.x, s.y]), sel.option.intake]).geometry), {padding: 22, duration: 0, maxZoom: 15});
    } else {
      m.addSource('pt', {type: 'geojson', data: fc([pointFeature(sel.coord)])});
      m.addLayer({id: 'pt', type: 'circle', source: 'pt', paint: {'circle-radius': 5, 'circle-color': '#245e4b', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2}});
    }
  });
}

/* ───────────── Lista de sitios y filtros ───────────── */
function filteredSites() {
  return S.sites.filter(f => {
    const p = f.properties;
    if (S.power === 'pch' && p.c > 5) return false;                               // por defecto: solo ≤ 20 MW
    if (S.power !== 'pch' && S.power !== 'all' && p.c !== Number(S.power)) return false;
    if (S.area && p.ah !== S.area) return false;
    if (S.dept && p.d !== S.dept) return false;
    if (S.maxGrid && !(p.gkm <= Number(S.maxGrid))) return false;
    if (S.hideRegulated && (p.qf & 8)) return false;                              // caudal regulado por embalse
    if (S.hideQuality && (p.qf & 3)) return false;                                // salto concentrado o gradiente atípico
    if (S.constraint === 'no-spnn' && (p.m & (1 | 256))) return false;           // Parques Nacionales y embalses
    if (S.constraint === 'no-ethnic' && (p.m & (1 | 256 | 32 | 64))) return false;
    if (S.constraint === 'clean' && p.m) return false;
    return true;
  });
}
function applyFilters() { S.listLimit = 20; setData('sites', fc(filteredSites())); renderList(); renderMapKey(); }
function visibleSites() {
  let fs = filteredSites();
  if ($('#viewport-only').checked && S.mapReady) { const b = map.getBounds(); fs = fs.filter(f => b.contains(f.geometry.coordinates)); }
  return fs.slice().sort((a, b) => b.properties.p - a.properties.p);
}
const QUALITY_LABELS = {1: 'salto concentrado', 2: 'pendiente atípica', 4: 'túnel probable', 8: 'caudal regulado'};
function renderList() {
  const list = $('#site-list'); if (!list) return;
  if (S.view === 'saved') {
    $('#results-title').textContent = 'Tus lugares guardados'; $('#result-count').textContent = S.saved.length;
    list.innerHTML = S.saved.length ? S.saved.map(s => `<button class="opportunity-item" data-saved="${esc(s.id)}"><i class="dot"></i><span><span class="op-name">${esc(s.title)}</span><span class="op-area">${esc(s.subtitle || '')}</span></span>${icon('arrow')}</button>`).join('')
      : '<div class="saved-empty"><p>Selecciona un lugar y pulsa <b>Guardar lugar</b>. Quedará guardado en este navegador.</p></div>';
    return;
  }
  const fs = visibleSites();
  $('#results-title').textContent = 'Sitios por potencia'; $('#result-count').textContent = fmt(fs.length);
  list.innerHTML = fs.slice(0, S.listLimit).map(f => {
    const p = f.properties, band = bandOf(p.p);
    const warn = [p.m ? 'restricciones' : '', ...Object.entries(QUALITY_LABELS).filter(([b]) => p.qf & b).map(([, l]) => l)].filter(Boolean);
    return `<button class="opportunity-item ${S.selection?.site?.id === p.id ? 'selected' : ''} ${p.c === 6 ? 'over' : ''}" data-site="${p.id}">${symbolSVG('power-' + band.key)}<span><span class="op-name">${esc(riverTitle(p.n))}</span><span class="op-area">${esc([p.mu, p.d].filter(Boolean).join(' · '))} · salto ${fmt(p.h)} m · red ${fmt(p.gkm)} km</span>${warn.length ? `<span class="op-warn"><span aria-hidden="true">⚠</span> ${esc(warn.join(', '))}</span>` : ''}</span><span class="op-power">${esc(power(p.p))}</span></button>`;
  }).join('') || '<p class="empty-list">No hay sitios con estos filtros.</p>';
  if (fs.length > S.listLimit) list.innerHTML += `<button class="text-button wide-button" id="list-more">Ver más sitios (${fmt(fs.length - S.listLimit)}) ${icon('arrow')}</button>`;
}
/** Exporta a CSV la lista filtrada (revisión de negocios): abre en Excel con separador ';' y decimales con coma. */
function exportCSV() {
  const cols = [['id', p => p.id], ['rio', p => riverTitle(p.n)], ['municipio', p => p.mu], ['departamento', p => p.d], ['area_hidrografica', p => p.ah],
    ['potencia_kW', p => p.p], ['salto_m', p => p.h], ['conduccion_km', p => p.lc], ['caudal_diseno_m3s', p => p.q], ['potencia_ano_seco_kW', p => p.ps],
    ['distancia_red_km', p => p.gkm], ['tension_sugerida_kV', p => p.glv], ['costo_conexion_MCOP', p => p.gc], ['tunel_probable_km', p => p.tun],
    ['regulado_fraccion', p => p.reg], ['posible_ZNI', p => p.zni ? 'sí' : 'no'],
    ['restricciones', p => constraintsOf(p.m).map(c => c.label).join(' | ')], ['alertas_calidad', p => Object.entries(QUALITY_LABELS).filter(([b]) => p.qf & b).map(([, l]) => l).join(' | ')],
    ['lat_bocatoma', (p, f) => f.geometry.coordinates[1]], ['lon_bocatoma', (p, f) => f.geometry.coordinates[0]]];
  const cell = v => { const s = typeof v === 'number' ? String(v).replace('.', ',') : String(v ?? ''); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = visibleSites().map(f => cols.map(([, g]) => cell(g(f.properties, f))).join(';'));
  const csv = '\ufeff' + cols.map(c => c[0]).join(';') + '\n' + rows.join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8'}));
  a.download = `atlas-pch-sitios-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Descargados ${fmt(rows.length)} sitios en CSV.`);
}
/* ───────────── Búsqueda ───────────── */
async function ensureRiverSearch() { if (!S.riverSearch) S.riverSearch = json(V + 'rivers-search.json.gz').catch(() => []); return S.riverSearch; }
async function search() {
  const q = normalize($('#search').value.trim()), el = $('#search-results');
  if (q.length < 2) { el.hidden = true; return; }
  const results = [];
  const idMatch = q.match(/^(?:sitio\s*)?(?:n\.?\s*º?\s*)?(\d{1,6})$/);
  if (idMatch && S.siteById.has(Number(idMatch[1]))) {
    const f = S.siteById.get(Number(idMatch[1]));
    results.push({type: 'site', title: `Sitio n.º ${idMatch[1]} · ${riverTitle(f.properties.n)}`, subtitle: `${power(f.properties.p)} · ${f.properties.mu}, ${f.properties.d}`, value: f});
  }
  const rivers = await ensureRiverSearch();
  if (normalize($('#search').value.trim()) !== q) return;
  rivers.filter(r => normalize(r.name).includes(q)).map(r => {
    const n = normalize(r.name), bare = n.replace(/^(rio|quebrada|cano|canal|arroyo)\s+/, '');
    return {r, score: n === q || bare === q ? 100 : n.startsWith(q) || bare.startsWith(q) ? 50 : 10};
  }).sort((a, b) => b.score - a.score || b.r.upstream_km2 - a.r.upstream_km2).slice(0, 5)
    .forEach(({r}) => results.push({type: 'river', title: r.name, subtitle: `Río · cuenca ${fmt(r.upstream_km2)} km²`, value: r}));
  const munis = new Map();
  for (const f of S.sites) { const p = f.properties; if (p.mu && normalize(p.mu).includes(q) && !munis.has(p.mu + p.d)) munis.set(p.mu + p.d, f); if (munis.size >= 4) break; }
  // Los municipios cuyo nombre coincide exactamente van primero (revisión del usuario final: 'Pasto' salía de último)
  const muniRes = [...munis.values()].map(f => ({type: 'municipality', title: f.properties.mu, subtitle: `Municipio · ${f.properties.d}`, value: f}));
  results.splice(idMatch ? 1 : 0, 0, ...muniRes.filter(m => normalize(m.title) === q));
  results.push(...muniRes.filter(m => normalize(m.title) !== q));
  for (const f of [...(S.data.plants?.features || []), ...(S.data.municipalPlants?.features || [])]) { if (normalize(f.properties.name).includes(q)) results.push({type: 'plant', title: f.properties.name, subtitle: `Central · ${f.properties.department || ''}`, value: f}); if (results.length >= 12) break; }
  for (const f of S.data.departments?.features || []) if (normalize(f.properties.name).includes(q)) results.push({type: 'department', title: f.properties.name, subtitle: 'Departamento', value: f});
  el.innerHTML = results.length ? results.map((r, i) => `<button class="search-result" data-search="${i}"><b>${esc(r.title)}</b><small>${esc(r.subtitle)}</small></button>`).join('') : '<p class="empty-list">Sin resultados.</p>';
  el.hidden = false;
  el.onclick = async e => {
    const b = e.target.closest('[data-search]'); if (!b) return;
    const r = results[+b.dataset.search]; el.hidden = true; $('#search').value = r.title;
    if (r.type === 'river') { map.flyTo({center: r.value.center, zoom: 10, duration: 650}); await selectReach(r.value.id, r.value.cell, r.value.center); }
    else if (r.type === 'municipality') { map.flyTo({center: r.value.geometry.coordinates, zoom: 10, duration: 650}); $('#viewport-only').checked = true; $('#map-region').textContent = ` · ${r.value.properties.d}`; $('#sidebar').classList.remove('mobile-open'); setTimeout(renderList, 800); }
    else if (r.type === 'site') { $('#sidebar').classList.remove('mobile-open'); selectSite(r.value); }
    else if (r.type === 'department') { map.fitBounds(bboxOf(r.value.geometry), {padding: 55, duration: 650}); $('#map-region').textContent = r.title; }
    else selectFeature('plant', r.value);
  };
}

/* ───────────── Guardados y exportación ───────────── */
function snapshot(sel) {
  const base = {id: sel.id, kind: sel.kind, title: sel.title, subtitle: sel.subtitle, coord: sel.coord, savedAt: new Date().toISOString()};
  if (sel.kind === 'site') return {...base, siteId: sel.site.id};
  if (sel.kind === 'reach') return {...base, reachId: sel.reach.id, cellKey: sel.reach.cellKey};
  return {...base, feature: sel.feature};
}
function restore(s) {
  if (s.kind === 'site') return selectSite(S.siteById.get(s.siteId));
  if (s.kind === 'reach') return selectReach(s.reachId, s.cellKey, s.coord);
  return selectFeature(s.kind, s.feature);
}
function saveSite() {
  const sel = S.selection; if (!sel) return;
  const i = S.saved.findIndex(s => s.id === sel.id);
  if (i >= 0) { S.saved.splice(i, 1); toast('Lugar eliminado de guardados.'); } else { S.saved.push(snapshot(sel)); toast('Lugar guardado en este navegador.'); }
  try { localStorage.setItem('atlas-pch-saved-v2', JSON.stringify(S.saved)); } catch { toast('No hay espacio para guardar en este navegador.'); }
  $('#saved-count').textContent = S.saved.length; renderDetail(); if (S.view === 'saved') renderList();
}
function exportSite() {
  const sel = S.selection; if (!sel) return;
  const props = {titulo: sel.title, ubicacion: sel.subtitle, tipo: sel.kind, exportado: new Date().toISOString(), fuente: 'Atlas PCH Colombia v2 · exploración preliminar, no es diseño ni autorización'};
  const features = [];
  const o = sel.option;
  if (o) {
    const hyd = {caudal_diseno_m3s: o.qDesign, salto_bruto_m: o.head, conduccion_km: o.conduitKm, tramo_reducido_km: o.riverKm, potencia_kw: o.pKW,
      restricciones: constraintsOf(sel.kind === 'site' ? sel.site.m : sel.reach.mask).map(c => c.label), caudales_ena: sel.reach.q, q95_upme: sel.reach.q95};
    features.push(pointFeature(o.intake, {...props, ...hyd, rol: 'bocatoma'}), pointFeature(o.powerhouse, {rol: 'casa de máquinas'}),
      lineFeature([o.intake, o.powerhouse], {rol: 'conducción en línea recta'}),
      lineFeature(o.path.map(s => [s.x, s.y]), {rol: 'tramo con caudal reducido', perfil: o.path.map(s => ({km: +s.d.toFixed(3), z_m: s.z}))}));
  } else features.push(pointFeature(sel.coord, {...props, ...(sel.feature?.properties || {})}));
  const blob = new Blob([JSON.stringify(fc(features), null, 2)], {type: 'application/geo+json'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `atlas-pch-${sel.id}.geojson`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ───────────── Fuentes y metodología ───────────── */
function renderSources() {
  const m = S.manifest || {}, rep = m.reports || {}, sites = rep.sites || {}, ctx = rep.context || {}, prof = rep.profile || {};
  const par = sites.parameters || {}, val = (S.validation || {}).existing_plants || {};
  $('#sources-content').innerHTML = `<p>Herramienta de <b>exploración preliminar</b> de sitios para <b>pequeñas centrales hidroeléctricas (PCH, hasta 20 MW)</b>. Cada número indica su fuente y su método. Ningún resultado es un diseño, una concesión de aguas ni una licencia: todos requieren estudios de campo. Datos procesados el ${esc(m.generated || '')}. Revisada por un panel de 8 especialistas (hidrología, mecánica de PCH, negocios, derecho ambiental, SIG, mercado eléctrico, usuario final y diseño).</p>
  <div class="method-box"><h3>Cómo se calcula un sitio candidato</h3><p>
   1) <b>Caudal</b>: rendimiento hídrico de cada subzona (IDEAM, Estudio Nacional del Agua 2022) × cuenca aportante, acumulado por la red. El caudal de diseño es la <b>oferta disponible de año medio</b>, que descuenta el caudal ambiental <i>de planificación</i> de la ENA (el exigible lo fija la autoridad ambiental). La energía sale de una curva de duración lognormal calibrada con el índice de regulación hídrica (IRH) de la subzona.<br>
   2) <b>Salto</b>: perfil del lecho cada ≤100 m con FABDEM (sin bosque ni edificios): mínimo de 3×3 píxeles, mediana móvil con contexto de los tramos vecinos y condicionamiento por tramo. Se descartan bocatomas más de 5 m por encima del río aguas arriba.<br>
   3) <b>Esquema</b>: desde cada estación se busca la casa de máquinas aguas abajo (≤${fmt(par.max_river_km)} km por el cauce) con más salto, con conducción en línea recta ≤${fmt(par.max_conduit_km)} km, salto ≥${fmt(par.min_head_m)} m y ≥${fmt(par.min_gradient_m_per_km)} m de salto por km. Bocatoma y casa de máquinas dentro de Colombia.<br>
   4) <b>Potencia de referencia</b> = 9,81 × Q × H × (1 − ${fmt((par.head_loss || 0) * 100)} %) × ${fmt(par.efficiency, 2)}. En la ficha se refina con salto neto, turbina y eficiencia por tipo y tamaño (prediseño).<br>
   5) <b>Sin solapes</b>: de mayor a menor potencia, se descarta un sitio si su tramo intervenido ya pertenece a otro. Resultado: ${fmt(sites.sites)} sitios ≥ ${fmt(par.min_site_kw)} kW.<br>
   6) <b>Corredor y entorno</b>: bocatoma, conducción, tramo reducido y casa de máquinas (margen ${fmt(ctx.corridor_buffer_m)} m) frente a áreas protegidas, páramos, Ley 2ª, territorios étnicos, zonas de reserva campesina y embalses; proximidad a territorios étnicos (≤ 2 km) y Parques Nacionales (≤ 5 km); túnel probable; caudal regulado; conexión a la red de distribución.</p></div>
  <div class="method-box"><h3>Validación</h3><p>Frente a ${fmt(val.small_plants_le_20mw)} PCH existentes con coordenada XM, comparando solo esquemas de caudal parecido (½ a 2 veces el real) y con tope de 19,9 MW: ${fmt(val.small_with_comparable_scheme_pct, 0)} % tiene un esquema comparable a ≤ 3 km; la potencia estimada da ${fmt(val.small_ratio_estimated_over_installed_median, 2)} veces la instalada en mediana (rango central ${fmt(val.small_ratio_p25_p75?.[0], 2)}–${fmt(val.small_ratio_p25_p75?.[1], 2)}). Frente a estaciones del IDEAM, el caudal de la ENA puede diferir ±40 %, sobre todo en cabeceras: la calibración con series diarias es la siguiente mejora prevista.</p></div>
  <div class="source-row"><h3>Red hidrográfica<br>${fmt(m.counts?.reaches)} tramos</h3><div><p>HydroSHEDS v2 (≈30 m, cuenca mínima 1 km²) como única geometría; nombres IGAC 1:25.000/1:100.000 por coincidencia espacial. Teselas PMTiles.</p>${link('https://www.hydrosheds.org/products/hydrosheds-v2', 'HydroSHEDS v2 · CC BY 4.0')}</div></div>
  <div class="source-row"><h3>Caudal</h3><div><p>IDEAM, ENA 2022: Anexo 1 (oferta total y disponible de las 316 subzonas) y Anexo 2 (IRH e IUA). Subzonas publicadas por la UPME (zonificación IDEAM 2013). Clase Q95 de la UPME y HydroRIVERS como contraste, no como validación. Embalses (IGAC y OpenStreetMap) para marcar el caudal regulado.</p>${link('https://www.ideam.gov.co/nuestra-entidad/hidrologia/estudio-nacional-del-agua-2022', 'ENA 2022')} · ${link('https://www.datos.gov.co/d/jxnq-r3i9', 'Caudales diarios IDEAM')}</div></div>
  <div class="source-row"><h3>Elevación</h3><div><p>FABDEM V1-2 (Copernicus WorldDEM-30 © DLR e.V., sin bosques ni edificios), ${fmt(prof.stations)} estaciones del lecho, mosaicos verificados contra el CRC32 del archivo oficial de la Universidad de Bristol. <b>Licencia CC BY-NC-SA 4.0: uso no comercial.</b> El relieve 3D usa Copernicus GLO-30 (Mapterhorn) solo como visualización.</p>${link('https://data.bris.ac.uk/data/dataset/s5hqmjcdj8yo2ibzi9b4ew3sn', 'FABDEM')}</div></div>
  <div class="source-row"><h3>Restricciones</h3><div><p>RUNAP (Parques Nacionales), páramos y reservas Ley 2ª (MinAmbiente), resguardos, consejos comunitarios y zonas de reserva campesina (Agencia Nacional de Tierras, 2026), embalses (IGAC 1:100.000 y © colaboradores de OpenStreetMap, ODbL). Amenaza por movimientos en masa: servicio en vivo del SGC (no se redistribuye). Faltan: zonificación de la Ley 2ª y sustracciones, POMCA, rondas hídricas, zonas de utilidad pública, títulos mineros, concesiones existentes y decisiones judiciales.</p>${link('https://runap.parquesnacionales.gov.co/', 'RUNAP')} · ${link('https://data-agenciadetierras.opendata.arcgis.com/', 'Datos abiertos ANT')}</div></div>
  <div class="source-row"><h3>Red eléctrica y mercado</h3><div><p>Subestaciones de distribución UPME (1.557, con capacidad y carga) y de transmisión UPME; líneas de transmisión; proyectos con capacidad de transporte asignada; centrales XM/UPME (incompleto frente a las ~129 PCH en operación). El trazado de las redes de 13,2 y 34,5 kV no es público. Costos de conexión y de inversión indicativos, a calibrar.</p>${link('https://geo.upme.gov.co/server/rest/services/SUBESTACIONES', 'Subestaciones UPME')} · ${link('https://paratec.xm.com.co/', 'XM–PARATEC')}</div></div>
  <div class="method-box"><h3>Límites que el revisor debe tener presentes</h3><p>• El rendimiento hídrico es un promedio por subzona: no distingue la cabecera del valle.<br>• El salto viene de un modelo global (error de pocos metros); saltos menores de ~20 m o concentrados en un punto son inciertos (se marcan).<br>• FABDEM refleja el terreno de 2011–2015: los embalses posteriores se marcan con la capa de embalses, pero otras obras recientes pueden faltar.<br>• La conducción se mide en línea recta; cuando cruza terreno alto se marca como túnel probable.<br>• No se evalúan geotecnia detallada, accesos, sedimentos ni concesiones existentes.<br>• Las coincidencias del corredor son alertas para revisar, no conceptos jurídicos.</p></div>`;
}
/* ───────────── Interfaz ───────────── */
function bindUI() {
  for (const el of $$('[data-map-symbol]')) el.innerHTML = symbolSVG(el.dataset.mapSymbol);
  $('#power-filters').insertAdjacentHTML('beforeend', POWER_BANDS.map(b => `<button data-power="${b.id}" class="power-chip" aria-pressed="false">${symbolSVG('power-' + b.key)}${esc(b.label.replace(' (fuera de rango PCH)', ''))}</button>`).join(''));
  for (const input of $$('.switch')) input.addEventListener('change', updateLayers);
  $('#layers-reset').onclick = () => { $$('.switch').forEach(el => el.checked = ['layer-rivers', 'layer-environment', 'layer-plants', 'layer-sites'].includes(el.id)); updateLayers(); };
  $$('.segmented [data-color]').forEach(b => b.onclick = () => {
    S.colorBy = b.dataset.color;
    $$('.segmented [data-color]').forEach(x => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    if (S.colorBy === 'potential') toast('Color = potencia del mejor esquema que nace en cada tramo (criterios nacionales).');
    if (S.colorBy === 'flow') toast('Color = caudal disponible de año medio, ENA 2022.');
    updateLayers();
  });
  $('#power-filters').onclick = e => {
    const b = e.target.closest('[data-power]'); if (!b) return;
    S.power = b.dataset.power;
    $$('[data-power]').forEach(x => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    applyFilters();
  };
  $('#constraint-filter').onchange = e => { S.constraint = e.target.value; applyFilters(); };
  $('#area-filter').onchange = e => { S.area = e.target.value; applyFilters(); };
  $('#viewport-only').onchange = renderList;
  $('#site-list').onclick = e => {
    const s = e.target.closest('[data-site]'), saved = e.target.closest('[data-saved]');
    if (s) selectSite(S.siteById.get(Number(s.dataset.site)));
    else if (saved) restore(S.saved.find(x => x.id === saved.dataset.saved));
    else if (e.target.closest('#list-more')) { S.listLimit += 30; renderList(); }
  };
  $$('.nav-button').forEach(b => b.onclick = () => {
    S.view = b.dataset.view; $$('.nav-button').forEach(x => x.classList.toggle('active', x === b));
    if (S.view === 'sites') { $('#layer-sites').checked = true; updateLayers(); }
    renderList(); if (innerWidth <= 660) $('#sidebar').classList.add('mobile-open');
    $('.potential-section').scrollIntoView({block: 'start', behavior: 'smooth'});
  });
  $('#national-view').onclick = () => { map?.fitBounds([[-79.1, -4.3], [-66.85, 12.5]], {padding: 60, duration: 700, pitch: 0, bearing: 0}); setDimension(false); $('#map-region').textContent = 'Vista nacional'; };
  $('#zoom-in').onclick = () => map?.zoomIn(); $('#zoom-out').onclick = () => map?.zoomOut();
  $('#view-2d').onclick = () => setDimension(false); $('#view-3d').onclick = () => setDimension(true);
  $('#hint-close').onclick = () => $('#map-hint').hidden = true; $('#detail-close').onclick = closeDetail;
  $$('.detail-tabs button').forEach(b => b.onclick = () => { S.tab = b.dataset.tab; renderDetail(); });
  for (const id of ['sources-open', 'method-open', 'method-open-2']) $('#' + id).onclick = () => { renderSources(); $('#sources-dialog').showModal(); };
  $('#sources-close').onclick = () => $('#sources-dialog').close();
  $('#save-site').onclick = saveSite; $('#export-site').onclick = exportSite;
  $('#mobile-sidebar').onclick = () => $('#sidebar').classList.toggle('mobile-open');
  $('#sidebar-close').onclick = () => $('#sidebar').classList.remove('mobile-open');
  $('#search').addEventListener('input', () => void search());
  document.addEventListener('click', e => { if (!e.target.closest('.search-wrap')) $('#search-results').hidden = true; });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('#search').focus(); }
    if (e.key === 'Escape') { $('#search-results').hidden = true; $('#sidebar').classList.remove('mobile-open'); }
  });
  // Escenario (prediseño y energía) y supuestos económicos editables
  const onScenario = e => {
    const sel = S.selection; if (!sel?.option) return;
    const id = e.target.id;
    if (id === 'sc-q') S.scenario.q = e.target.value === '' ? undefined : Number(e.target.value);
    else if (id === 'sc-amb') { S.scenario.amb = e.target.value; $('#sc-ambv').disabled = e.target.value !== 'libre'; }
    else if (id === 'sc-ambv') S.scenario.ambValue = e.target.value === '' ? undefined : Number(e.target.value);
    else if (id === 'sc-eta') S.scenario.eta = e.target.value === '' ? undefined : Number(e.target.value);
    else if (id.startsWith('ec-')) {
      const v = Number(e.target.value); if (!isNum(v)) return;
      if (id === 'ec-price') S.econ.priceCOPkWh = v; else if (id === 'ec-trm') S.econ.trm = v;
      else if (id === 'ec-rate') S.econ.rate = v / 100; else if (id === 'ec-years') S.econ.years = v;
      const keep = e.target.id; renderDetail(); const el = $('#' + keep); if (el) { el.focus(); }
      return;
    } else return;
    if ($('#scenario-result')) $('#scenario-result').innerHTML = scenarioHTML(computeScenario(sel));
  };
  $('#detail-content').addEventListener('change', onScenario);
  $('#detail-content').addEventListener('input', e => { if (e.target.matches('#sc-q, #sc-ambv, #sc-eta')) onScenario(e); });
  $('#detail-content').addEventListener('click', async e => {
    const t = e.target.closest('[data-term]');
    if (t) { openGlossary(t.dataset.term); return; }
    if (e.target.closest('#restore-option')) {
      const sel = S.selection; if (!sel?.originalSel) return;
      setSelection(sel.originalSel);
      return;
    }
    if (!e.target.closest('#research')) return;
    const sel = S.selection; if (!sel?.reach) return;
    S.params = {...S.params, maxConduit: +$('#pa-conduit').value || DEFAULTS.maxConduit, minHead: +$('#pa-head').value || DEFAULTS.minHead,
      minGradient: +$('#pa-grad').value >= 0 ? +$('#pa-grad').value : DEFAULTS.minGradient, maxRiver: Math.min(9, +$('#pa-river').value || DEFAULTS.maxRiver)};
    e.target.closest('#research').disabled = true; e.target.closest('#research').textContent = 'Recorriendo el río…';
    const option = await searchBest(sel.reach, S.params);
    if (S.selection !== sel) return;
    // Se conserva el sitio y su contexto para poder volver al esquema original
    setSelection({...sel, kind: 'reach', id: 'reach-' + sel.reach.id, site: undefined, context: undefined, option, originalOption: option, originalSel: sel.originalSel || sel});
    if (!option) toast('Con esos criterios no hay un esquema desde este tramo.');
  });
  $('#detail-content').addEventListener('keydown', e => { const t = e.target.closest('[data-term]'); if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openGlossary(t.dataset.term); } });
  // Filtros nuevos y exportación
  $('#dept-filter').onchange = e => { S.dept = e.target.value; applyFilters(); };
  $('#grid-filter').onchange = e => { S.maxGrid = e.target.value; applyFilters(); };
  $('#hide-regulated').onchange = e => { S.hideRegulated = e.target.checked; applyFilters(); };
  $('#hide-quality').onchange = e => { S.hideQuality = e.target.checked; applyFilters(); };
  $('#export-csv').onclick = exportCSV;
  $('#print-site').onclick = printSite;
  for (const id of ['glossary-open', 'glossary-open-2']) $('#' + id)?.addEventListener('click', () => openGlossary());
  $('#glossary-close').onclick = () => $('#glossary-dialog').close();
  // Pestañas de la ficha: vuelven arriba y responden a las flechas (accesibilidad)
  $$('.detail-tabs button').forEach(b => b.onclick = () => { S.tab = b.dataset.tab; renderDetail(); $('.detail-scroll').scrollTop = 0; });
  $('.detail-tabs').addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const tabs = $$('.detail-tabs button'), i = tabs.findIndex(b => b.dataset.tab === S.tab);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    next.click(); next.focus();
  });
}
function openGlossary(termKey) {
  $('#glossary-content').innerHTML = `<dl class="glossary">${Object.entries(GLOSSARY).map(([k, v]) => `<dt id="g-${esc(k.replace(/\W+/g, '-'))}" class="${k === termKey ? 'hit' : ''}">${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  $('#glossary-dialog').showModal();
  if (termKey) $(`#g-${termKey.replace(/\W+/g, '-')}`)?.scrollIntoView({block: 'center'});
}
/** Ficha imprimible: arma todas las pestañas en una sola página y abre el diálogo de impresión (PDF). */
function printSite() {
  const sel = S.selection; if (!sel) return;
  const tabs = ['site', 'reach'].includes(sel.kind) ? ['summary', 'hydrology', 'context', 'business', 'steps'] : [null];
  const prev = S.tab;
  const parts = tabs.map(t => { if (t) S.tab = t; const html = !t ? featureHTML(sel) : t === 'hydrology' ? hydrologyHTML(sel) : t === 'context' ? contextHTML(sel) : t === 'business' ? businessHTML(sel) : t === 'steps' ? stepsHTML(sel) : summaryHTML(sel);
    return `<section class="print-section">${t ? `<h2>${esc(TABS[t])}</h2>` : ''}${html}</section>`; });
  S.tab = prev;
  $('#print-area').innerHTML = `<header><b>Atlas PCH Colombia · ficha preliminar</b><span>${new Date().toLocaleDateString('es-CO')}</span></header>
    <h1>${esc(sel.title)}</h1><p>${esc(sel.subtitle || '')}</p>${parts.join('')}
    <footer>Exploración preliminar: no es diseño, concesión ni licencia. ${esc(location.href)}</footer>`;
  window.print();
}function setDimension(use3D) {
  if (!map) return;
  if (use3D) { $('#layer-relief').checked = true; map.setTerrain({source: 'terrain-dem', exaggeration: 1}); map.easeTo({pitch: 58, bearing: -15, zoom: Math.max(map.getZoom(), 7.3), duration: 750}); }
  else { map.setTerrain(null); map.easeTo({pitch: 0, bearing: 0, duration: 500}); }
  $('#view-2d').classList.toggle('active', !use3D); $('#view-3d').classList.toggle('active', use3D);
  $('#view-2d').setAttribute('aria-pressed', String(!use3D)); $('#view-3d').setAttribute('aria-pressed', String(use3D));
}

/* ───────────── Inicio ───────────── */
async function main() {
  bindUI(); $('#saved-count').textContent = S.saved.length;
  const protocol = new window.pmtiles.Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  const sitesPromise = json(V + 'sites.geojson.gz');
  const manifestPromise = json(V + 'atlas-manifest.json').catch(() => null);
  const subzonaPromise = json(V + 'subzonas.json.gz').catch(() => null);
  try {
    map = new maplibregl.Map({container: 'map', style: baseStyle(), center: [-73.6, 4.4], zoom: 4.65, minZoom: 3.4, maxZoom: 16, maxPitch: 75,
      attributionControl: {compact: true}, renderWorldCopies: false, maxBounds: [[-87, -10], [-60, 20]]});
  } catch (e) { showError('El navegador no pudo iniciar el mapa (WebGL). ' + e.message); $('#map-loading').hidden = true; return; }
  window.__atlas = {map, S}; // acceso de depuración desde la consola del navegador
  map.addControl(new maplibregl.ScaleControl({maxWidth: 90, unit: 'metric'}), 'bottom-left');
  let errors = 0; map.on('error', e => { console.warn('Mapa:', e.error?.message || e.message); if (++errors === 8) toast('Una fuente externa del mapa no responde. Los datos del atlas siguen disponibles.'); });
  map.on('mousemove', e => { $('#coordinates').textContent = `${fmt(Math.abs(e.lngLat.lat), 4)}° ${e.lngLat.lat >= 0 ? 'N' : 'S'} · ${fmt(Math.abs(e.lngLat.lng), 4)}° O`; });
  map.on('moveend', () => { clearTimeout(moveTimer); moveTimer = setTimeout(() => { if ($('#viewport-only').checked) renderList(); }, 150); });
  // Se arranca en cuanto el estilo está listo ('load' esperaría además las primeras teselas de todas las capas).
  // Con caché, el estilo puede quedar listo antes de registrar el evento: por eso se comprueba también al instante.
  let started = false;
  const start = async () => {
    if (started) return; started = true;
    try {
      S.mapReady = true; setupMap();
      map.fitBounds([[-79.1, -4.3], [-66.85, 12.5]], {padding: {top: 65, bottom: 55, left: 30, right: 45}, duration: 0});
      const sites = await sitesPromise;
      S.sites = sites.features; S.siteById = new Map(S.sites.map(f => [f.properties.id, f]));
      const depts = [...new Set(S.sites.map(f => f.properties.d).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
      $('#dept-filter').insertAdjacentHTML('beforeend', depts.map(d => `<option>${esc(d)}</option>`).join(''));
      applyFilters();
      $('#map-loading').hidden = true; document.body.dataset.atlasReady = 'true'; window.dispatchEvent(new Event('atlas-ready'));
      $('#data-status').textContent = `${fmt(S.sites.length)} sitios · 605.905 tramos`;
      void attachBasemap(map, 'relief');
      S.manifest = await manifestPromise; S.subzonas = await subzonaPromise; renderSources();
      json(V + 'validation.json').then(v => { S.validation = v; renderSources(); }).catch(() => {});
      for (const [key, file, source] of [['plants', 'data/plants.geojson', 'plants'], ['municipalPlants', 'data/plants-municipal-references.geojson', 'municipal-plants'],
        ['boundary', 'data/colombia-boundary.geojson', 'boundary'], ['departments', 'data/colombia-departments.geojson', 'departments']])
        void ensureLayerData(key, file, source);
    } catch (e) { $('#map-loading').hidden = true; showError('No se pudieron cargar los datos: ' + e.message + '. Recarga para volver a intentar.'); }
  };
  map.once('style.load', start);
  map.once('load', start);
  if (map.isStyleLoaded()) start();
}

main().catch(e => { console.error(e); $('#map-loading').hidden = true; showError('No se pudo preparar el atlas: ' + e.message); });
