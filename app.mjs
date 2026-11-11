// Atlas PCH Colombia · aplicación web (versión 2)
// Orden del archivo: utilidades → estado → carga de datos → red y perfiles → mapa → interacción
//                    → fichas → lista de sitios → búsqueda → guardados/exportación → fuentes → inicio.
import * as maplibregl from './vendor/maplibre-gl.mjs';
import {POWER_BANDS, CONSTRAINTS, bandOf, constraintsOf, powerImage, powerColor, registerMapSymbols, symbolSVG} from './map-symbols.mjs?v=2.0.5';
import {EMPTY, fc, bboxOf, distance, hydraulicPowerKW, normalize, cellKeyFromInt, pointFeature, lineFeature} from './geo.mjs?v=2.0.5';

/* ───────────── Utilidades ───────────── */
const V = 'data/v2/';
// Cambiar al regenerar los datos (scripts/pipeline/06): obliga a los navegadores a descargar la versión nueva.
const DATA_VERSION = '2026-11-10.3';
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
  view: 'explore', power: 'all', area: '', constraint: 'no-spnn', colorBy: 'plain', listLimit: 20,
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
    mask: r[14], external: r[15], best: r[16],
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

const RIVER_TIERS = ['major', 'mid', 'minor'];
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
    : S.colorBy === 'potential' ? powerColor : '#489ba4';
  return ['case', ['boolean', ['feature-state', 'selected'], false], '#123f37', base];
}
const POINT_LAYERS = {
  'site-point': {source: 'sites', kind: 'site'},
  'site-point-small': {source: 'sites', kind: 'site'},
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
  map.addLayer({id: 'hazard-layer', type: 'raster', source: 'hazard', layout: {visibility: 'none'}, paint: {'raster-opacity': .55}}, firstSymbol);

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
  map.addLayer({id: 'route-line', type: 'line', source: 'route', layout: {'line-cap': 'round', 'line-join': 'round'}, paint: {'line-color': '#ce8b3d', 'line-width': 5, 'line-opacity': .95}});
  map.addLayer({id: 'conduit-line', type: 'line', source: 'conduit', paint: {'line-color': '#1d3f39', 'line-width': 2.5, 'line-dasharray': [2, 1.2]}});

  registerMapSymbols(map);
  const size = ['interpolate', ['linear'], ['zoom'], 4, .55, 8, .8, 12, 1.05];
  map.addLayer({id: 'upme-point', type: 'circle', source: 'upme2015', layout: {visibility: 'none'},
    paint: {'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 10, 6], 'circle-color': '#ffffff', 'circle-stroke-color': '#7d6a3a', 'circle-stroke-width': 2}});
  map.addLayer({id: 'station-point', type: 'symbol', source: 'stations', layout: {'icon-image': ['case', ['==', ['get', 'status'], 'Activa'], 'atlas-station-active', 'atlas-station-other'], 'icon-size': size, visibility: 'none'}});
  map.addLayer({id: 'substation-point', type: 'symbol', source: 'substations', layout: {'icon-image': 'atlas-substation', 'icon-size': size, visibility: 'none'}});
  map.addLayer({id: 'project-point', type: 'symbol', source: 'projects', layout: {'icon-image': 'atlas-project', 'icon-size': size, 'icon-allow-overlap': true, visibility: 'none'}});
  map.addLayer({id: 'plant-municipal', type: 'symbol', source: 'municipal-plants', minzoom: 6, layout: {'icon-image': 'atlas-municipal', 'icon-size': size}});
  map.addLayer({id: 'plant-point', type: 'symbol', source: 'plants', layout: {'icon-image': 'atlas-plant', 'icon-size': size, 'icon-allow-overlap': true}});
  // Sitios: los de ≥ 1 MW siempre; los menores al acercarse (evita saturar la vista nacional).
  const siteLayout = {'icon-image': powerImage,
    'icon-size': ['interpolate', ['linear'], ['zoom'], 4, ['+', .42, ['*', ['get', 'c'], .05]], 9, ['+', .7, ['*', ['get', 'c'], .06]], 13, 1.15],
    'symbol-sort-key': ['*', -1, ['get', 'p']], 'icon-padding': 1};
  map.addLayer({id: 'site-point-small', type: 'symbol', source: 'sites', minzoom: 7.5, filter: ['<', ['get', 'p'], 1000], layout: siteLayout});
  map.addLayer({id: 'site-point', type: 'symbol', source: 'sites', filter: ['>=', ['get', 'p'], 1000], layout: siteLayout});
  map.addLayer({id: 'endpoint-ring', type: 'circle', source: 'endpoints',
    paint: {'circle-radius': 7, 'circle-color': ['case', ['==', ['get', 'role'], 'intake'], '#255f51', '#c18136'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2}});
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
  visibility('upme-point', on('upme2015')); visibility('site-point', on('sites')); visibility('site-point-small', on('sites'));
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
  S.selection = sel; S.tab = 'summary'; S.hazard = null;
  if (sel.reach) highlightReach(sel.reach.id);
  if (sel.option) drawOption(sel.option); else setData('selected-point', fc([pointFeature(sel.coord)]));
  $('#detail-panel').hidden = false; document.body.classList.add('detail-open'); $('#map-hint').hidden = true; $('#sidebar').classList.remove('mobile-open');
  $('#map-region').textContent = sel.subtitle || 'Selección';
  renderDetail(); renderList(); renderMapKey();
  $('.detail-scroll').scrollTop = 0; // cada ficha nueva empieza arriba
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

/* ───────────── Fichas ───────────── */
const subzoneName = code => S.subzonas?.[code]?.name ? `${S.subzonas[code].name} (${code})` : code ? `Subzona ${code}` : '';
function kv(items) { return `<dl class="detail-kv">${items.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v ?? 'Sin dato')}</dd>`).join('')}</dl>`; }

function renderDetail() {
  const sel = S.selection; if (!sel) return;
  $('#detail-eyebrow').textContent = {site: 'SITIO CANDIDATO', reach: 'TRAMO DE RÍO', plant: 'CENTRAL EXISTENTE', station: 'ESTACIÓN IDEAM', substation: 'SUBESTACIÓN', project: 'PROYECTO CON CAPACIDAD ASIGNADA', upme2015: 'REFERENCIA UPME 2015'}[sel.kind] || 'FICHA';
  $('#detail-title').innerHTML = `<h2>${esc(sel.title)}</h2><p>${esc(sel.subtitle || '')}</p>`;
  const tabs = ['site', 'reach'].includes(sel.kind);
  $('.detail-tabs').hidden = !tabs;
  $$('.detail-tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)));
  $('#detail-content').innerHTML = !tabs ? featureHTML(sel) : S.tab === 'hydrology' ? hydrologyHTML(sel) : S.tab === 'context' ? contextHTML(sel) : summaryHTML(sel);
  $('#save-site').innerHTML = icon('save') + (S.saved.some(s => s.id === sel.id) ? 'Quitar de guardados' : 'Guardar lugar');
  if (S.tab === 'context' && tabs && !S.hazard) void loadHazard(sel);
}

function constraintPills(mask, hits) {
  const list = constraintsOf(mask || 0);
  if (!list.length) return '<div class="detail-pill neutral">Sin coincidencias del corredor con las capas de restricción incorporadas. No equivale a viabilidad ni autorización.</div>';
  return list.map(c => {
    const names = (hits || []).filter(h => h.bit === c.bit).map(h => h.name).filter(Boolean);
    return `<div class="detail-pill ${c.severity}"><b>${esc(c.label)}</b>${names.length ? ': ' + esc(names.slice(0, 3).join(', ')) + (names.length > 3 ? '…' : '') : ''}<br>${esc(c.note)}</div>`;
  }).join('');
}

function summaryHTML(sel) {
  const r = sel.reach, o = sel.option;
  let html = '';
  if (o) {
    const band = bandOf(o.pKW || 0);
    html += `<span class="metric-label">Potencia de referencia${sel.kind === 'site' ? '' : ' del mejor esquema desde este tramo'}</span>
      <div class="power-readout"><strong>${esc(power(o.pKW).split(' ')[0])}</strong><span>${esc(power(o.pKW).split(' ')[1] || '')}</span></div>
      <span class="source-badge" style="--badge:${band.color}">${symbolSVG('power-' + band.key)} ${esc(band.label.toUpperCase())}${sel.kind === 'site' ? ` · SITIO N.º ${fmt(sel.site.id)}` : ''}</span>
      ${constraintPills(sel.kind === 'site' ? sel.site.m : r.mask, sel.context?.hits)}
      ${kv([
        ['Salto bruto (DEM)', fmt(o.head, 1) + ' m'],
        ['Conducción en línea recta', fmt(o.conduitKm, 2) + ' km'],
        ['Salto por km de conducción', fmt(o.head / Math.max(o.conduitKm, .05), 0) + ' m/km'],
        ['Tramo de río con caudal reducido', fmt(o.riverKm, 2) + ' km'],
        ['Caudal de diseño (disponible ENA)', flow(o.qDesign)],
        sel.kind === 'site' && ['Potencia en año seco', power(o.pDryKW)],
        sel.kind === 'site' && isNum(o.q95) && ['Potencia con Q95 UPME (mín. de clase)', power(hydraulicPowerKW(o.q95, o.head * .95, .85))],
        ['Elevación bocatoma → casa de máquinas', `${fmt(o.path[0].z)} → ${fmt(o.path.at(-1).z)} m`],
      ])}
      <div class="detail-section-title">Perfil del lecho <span class="mini-tag">FABDEM · CONDICIONADO</span></div>
      ${profileSVG(o)}
      <div class="route-endpoints"><span><i></i>Bocatoma</span><span><i></i>Casa de máquinas</span></div>
      ${o.head < 20 ? '<div class="detail-pill">Salto pequeño frente a la precisión del modelo de elevación (unos pocos metros). Requiere confirmación topográfica.</div>' : ''}
      <div class="detail-divider"></div>
      <div class="detail-section-title">Escenario de generación</div>
      <p class="detail-note">P = 9,81 × Q × H × (1 − pérdidas) × η. Cambia los supuestos para comparar.</p>
      <div class="scenario-form">
        <label>Caudal (m³/s)<input id="sc-q" type="number" min="0" step="0.01" value="${isNum(o.qDesign) ? +o.qDesign.toFixed(4) : ''}"></label>
        <label>Eficiencia (%)<input id="sc-eta" type="number" min="1" max="100" step="1" value="${DEFAULTS.eta}"></label>
        <label>Pérdidas de salto (%)<input id="sc-loss" type="number" min="0" max="60" step="1" value="${DEFAULTS.loss}"></label>
        <label>Factor de planta (%)<input id="sc-cf" type="number" min="1" max="100" step="1" value="${DEFAULTS.plantFactor}"></label>
      </div>
      <div id="scenario-result" class="scenario-result">${scenarioText(o.qDesign, DEFAULTS.eta / 100, DEFAULTS.loss / 100, DEFAULTS.plantFactor / 100, o.head)}</div>
      <p class="detail-note" style="margin-top:8px">El caudal inicial es la oferta disponible de año medio (ya descuenta el caudal ambiental estimado por el IDEAM). El factor de planta es un supuesto: la producción real depende de la curva de duración de caudales del sitio.</p>`;
  } else {
    html += `<span class="source-badge">RED HIDROGRÁFICA UNIFICADA</span>
      <div class="detail-pill neutral">Desde este tramo no hay un esquema con salto ≥ ${S.params.minHead} m, conducción ≤ ${S.params.maxConduit} km y al menos ${S.params.minGradient} m de salto por km de conducción.</div>`;
  }
  if (sel.kind === 'reach' || sel.kind === 'site') {
    html += `<div class="detail-divider"></div><div class="detail-section-title">Buscar otro esquema desde este tramo</div>
      <p class="detail-note">Ajusta los criterios y el navegador vuelve a recorrer el río aguas abajo con el perfil FABDEM.</p>
      <div class="scenario-form params-form">
        <label>Conducción máx. (km)<input id="pa-conduit" type="number" min="0.1" max="10" step="0.1" value="${S.params.maxConduit}"></label>
        <label>Salto mínimo (m)<input id="pa-head" type="number" min="2" max="500" step="1" value="${S.params.minHead}"></label>
        <label>Salto por km mín. (m/km)<input id="pa-grad" type="number" min="0" max="500" step="1" value="${S.params.minGradient}"></label>
        <label>Recorrido máx. (km)<input id="pa-river" type="number" min="0.5" max="9" step="0.5" value="${S.params.maxRiver}"></label>
      </div>
      <button class="primary-button wide-button" id="research">${icon('arrow')} Buscar desde este tramo</button>`;
    html += `<div class="detail-divider"></div>${kv([
      ['Cuenca aportante', fmt(r.upa, 1) + ' km²'], ['Longitud del tramo', fmt(r.length, 2) + ' km'],
      ['Orden del cauce (Strahler)', r.strahler], ['Subzona hidrográfica', subzoneName(r.szh)]])}`;
  }
  return html;
}

function scenarioText(q, eta, loss, cf, head) {
  const p = hydraulicPowerKW(q, head * (1 - loss), eta);
  if (p === null) return 'Introduce un caudal para calcular la potencia.';
  const mwh = p * 8760 * cf / 1000;
  return `Potencia instalable de referencia<br><strong>${esc(power(p))}</strong><br>Energía anual estimada: ${mwh >= 1000 ? fmt(mwh / 1000, 2) + ' GWh' : fmt(mwh, 0) + ' MWh'} con factor de planta ${fmt(cf * 100)} %.`;
}

function profileSVG(o) {
  const pts = o.path.filter(s => isNum(s.z));
  if (pts.length < 2) return '<p class="detail-note">El perfil no tiene elevaciones suficientes.</p>';
  const w = 310, h = 150, L = 40, R = 10, T = 14, B = 26;
  let min = Math.min(...pts.map(s => s.z)), max = Math.max(...pts.map(s => s.z));
  const pad = Math.max(4, (max - min) * .15); min -= pad; max += pad;
  const len = pts.at(-1).d || 1;
  const x = d => L + d / len * (w - L - R), y = v => h - B - (v - min) / (max - min) * (h - T - B);
  const path = pts.map((s, i) => (i ? 'L' : 'M') + x(s.d).toFixed(1) + ',' + y(s.z).toFixed(1)).join(' ');
  const a = pts[0], b = pts.at(-1);
  return `<svg class="profile" viewBox="0 0 ${w} ${h}" role="img" aria-label="Perfil del lecho del río: elevación en metros frente a distancia en kilómetros">
    <path class="profile-axis" d="M${L} ${T}V${h - B}H${w - R}"/>
    <path class="profile-area" d="${path} L${x(b.d)},${h - B} L${x(a.d)},${h - B} Z"/>
    <path class="profile-line" d="${path}"/>
    <path class="profile-head" d="M${x(a.d)},${y(a.z)} H${x(b.d)} V${y(b.z)}"/>
    <text x="${x(b.d) - 4}" y="${(y(a.z) + y(b.z)) / 2}" text-anchor="end" class="profile-label">H ≈ ${fmt(o.head, 0)} m</text>
    <circle cx="${x(a.d)}" cy="${y(a.z)}" r="3.5" class="profile-intake"/><circle cx="${x(b.d)}" cy="${y(b.z)}" r="3.5" class="profile-powerhouse"/>
    <text x="${L - 5}" y="${T + 5}" text-anchor="end">${fmt(max)}</text><text x="${L - 5}" y="${h - B}" text-anchor="end">${fmt(min)}</text>
    <text x="${L - 5}" y="${h / 2}" text-anchor="end">m</text><text x="${L}" y="${h - 8}">0</text>
    <text x="${w - R}" y="${h - 8}" text-anchor="end">${fmt(len, 2)} km por el cauce</text></svg>`;
}

function hydrologyHTML(sel) {
  const r = sel.reach, sz = S.subzonas?.[r.szh];
  let html = `<div class="detail-section-title" style="margin-top:0">Caudal regionalizado · ENA 2022 (IDEAM)</div>
    ${kv([['Año medio (oferta total)', flow(r.q.medio)], ['Año seco (oferta total)', flow(r.q.seco)], ['Año húmedo (oferta total)', flow(r.q.humedo)],
      ['Disponible año medio', flow(r.q.disp)], ['Disponible año seco', flow(r.q.dispSeco)]])}
    <p class="detail-note" style="margin-top:10px">Rendimiento hídrico de la subzona × área aportante, acumulado por la red. "Disponible" descuenta el caudal ambiental estimado por el IDEAM. Son promedios anuales de largo plazo, no aforos ni caudales concedidos.</p>`;
  if (r.external) html += '<div class="detail-pill">Parte de la cuenca de este tramo está fuera de la red cargada (frontera): el caudal puede estar subestimado.</div>';
  if (sz) html += `<div class="detail-section-title">Subzona ${esc(r.szh)}</div>${kv([['Nombre', sz.name], ['Área hidrográfica', sz.area], ['Rendimiento año medio', fmt(sz.rend_medio, 1) + ' L/s/km²'], ['Rendimiento año seco', fmt(sz.rend_seco, 1) + ' L/s/km²'], ['Variación interanual (CV)', fmt(sz.cv_pct, 1) + ' %']])}`;
  html += `<div class="detail-divider"></div><div class="detail-section-title">Contraste con otras fuentes</div>
    ${kv([['Q95 Atlas UPME (clase)', r.q95 ? r.q95 + ' m³/s' : 'Sin correspondencia'], ['Caudal medio HydroRIVERS (1971–2000)', flow(r.qHydroRivers)]])}
    <p class="detail-note" style="margin-top:10px">Q95: caudal superado el 95 % del tiempo, transferido desde la red UPME solo cuando la coincidencia es inequívoca. HydroRIVERS es un modelo global independiente: a nivel nacional su mediana coincide con la ENA (razón 0,99).</p>`;
  html += `<div class="detail-divider"></div><div class="detail-section-title">Estaciones IDEAM cercanas</div>`;
  const st = S.data.stations?.features;
  if (!st) { html += `<p class="detail-note">Activa la capa de estaciones para listarlas aquí.</p>`; void ensureLayerData('stations', 'data/stations.geojson', 'stations').then(() => S.selection === sel && S.tab === 'hydrology' && renderDetail()); }
  else {
    const near = st.map(f => ({p: f.properties, d: distance(sel.coord, f.geometry.coordinates)})).sort((a, b) => a.d - b.d).slice(0, 4);
    html += near.map(({p, d}) => `<div class="context-item"><b>${esc(p.name)}</b><p>${esc(p.code)} · ${esc(p.status)} · ${fmt(d, 1)} km<br>${esc(p.river || p.category || '')}</p></div>`).join('');
  }
  html += `<div class="detail-pill neutral">Para un estudio se necesitan series diarias de caudal (curva de duración), calidad del dato y usos existentes. Se solicitan en DHIME.</div>${link('https://dhime.ideam.gov.co/atencionciudadano/', 'Consultar series en DHIME')}`;
  return html;
}

function contextHTML(sel) {
  const c = sel.context, r = sel.reach;
  let html = `<div class="detail-section-title" style="margin-top:0">Restricciones en el corredor</div>
    <p class="detail-note">Bocatoma, conducción, tramo con caudal reducido y casa de máquinas, con un margen de 100 m.</p>
    ${constraintPills(sel.kind === 'site' ? sel.site.m : r.mask, c?.hits)}`;
  if (c?.hits?.length) html += c.hits.map(h => `<div class="context-item"><b>${esc(h.name)}</b><p>${esc(h.category)}<br>${esc(h.status || '')}${h.act ? '<br>' + esc(h.act) : ''}${h.people ? '<br>Pueblo: ' + esc(h.people) : ''}</p>${h.url ? link(h.url) : ''}</div>`).join('');
  html += `<div class="detail-divider"></div><div class="detail-section-title">Amenaza por movimientos en masa</div><div id="hazard-box">${hazardHTML()}</div>`;
  html += `<div class="detail-divider"></div><div class="detail-section-title">Conexión e infraestructura</div>`;
  if (c) {
    html += kv([['Subestación más cercana', `${c.substation.name} · ${fmt(c.substation.kv)} kV · ${fmt(c.substation.km, 1)} km`],
      ['Línea de transmisión más cercana', `${c.line.name || 'Sin nombre'} · ${fmt(c.line.kv)} kV · ${fmt(c.line.km, 1)} km`],
      ['Municipio', c.municipality], ['Departamento', c.department]]);
    if (c.existing_plants?.length) html += `<div class="detail-pill"><b>Central existente a menos de 2 km del corredor:</b> ${esc(c.existing_plants.map(p => `${p.name} (${fmt(p.mw, 1)} MW)`).join(', '))}. Es posible que este salto ya esté aprovechado.</div>`;
    if (c.assigned_projects?.length) html += `<div class="detail-pill"><b>Proyecto con capacidad asignada cerca:</b> ${esc(c.assigned_projects.map(p => `${p.name} (${fmt(p.mw, 1)} MW, ${p.state})`).join(', '))}.</div>`;
    if (c.municipal_plants?.length) html += `<div class="detail-pill neutral">En el municipio hay centrales con ubicación aproximada: ${esc(c.municipal_plants.join(', '))}.</div>`;
  } else {
    const subs = S.data.substations?.features;
    const ref = sel.option?.powerhouse || sel.coord;
    if (subs) {
      const n = subs.map(f => ({p: f.properties, d: distance(ref, f.geometry.coordinates)})).sort((a, b) => a.d - b.d)[0];
      html += kv([['Subestación más cercana', `${n.p.name} · ${fmt(n.p.voltageKV)} kV · ${fmt(n.d, 1)} km`]]);
    } else html += '<p class="detail-note">Cargando subestaciones…</p>';
  }
  html += `<p class="detail-note" style="margin-top:10px">La cercanía a una subestación o línea no acredita capacidad de conexión disponible.</p>`;
  html += `<div class="detail-divider"></div>${kv([['Bocatoma (lat, lon)', sel.option ? `${fmt(sel.option.intake[1], 5)}, ${fmt(sel.option.intake[0], 5)}` : `${fmt(sel.coord[1], 5)}, ${fmt(sel.coord[0], 5)}`],
    sel.option && ['Casa de máquinas (lat, lon)', `${fmt(sel.option.powerhouse[1], 5)}, ${fmt(sel.option.powerhouse[0], 5)}`]])}`;
  return html;
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
    for (const t of ['mid', 'minor']) {
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
    if (S.power !== 'all' && p.c !== Number(S.power)) return false;
    if (S.area && p.ah !== S.area) return false;
    if (S.constraint === 'no-spnn' && (p.m & (1 | 256))) return false;          // Parques Nacionales y embalses
    if (S.constraint === 'no-ethnic' && (p.m & (1 | 256 | 32 | 64))) return false;
    if (S.constraint === 'clean' && p.m) return false;
    return true;
  });
}
function applyFilters() { S.listLimit = 20; setData('sites', fc(filteredSites())); renderList(); renderMapKey(); }
function renderList() {
  const list = $('#site-list'); if (!list) return;
  if (S.view === 'saved') {
    $('#results-title').textContent = 'Tus lugares guardados'; $('#result-count').textContent = S.saved.length;
    list.innerHTML = S.saved.length ? S.saved.map(s => `<button class="opportunity-item" data-saved="${esc(s.id)}"><i class="dot"></i><span><span class="op-name">${esc(s.title)}</span><span class="op-area">${esc(s.subtitle || '')}</span></span>${icon('arrow')}</button>`).join('')
      : '<div class="saved-empty"><p>Selecciona un lugar y pulsa <b>Guardar lugar</b>. Quedará guardado en este navegador.</p></div>';
    return;
  }
  let fs = filteredSites();
  if ($('#viewport-only').checked && S.mapReady) { const b = map.getBounds(); fs = fs.filter(f => b.contains(f.geometry.coordinates)); }
  fs = fs.slice().sort((a, b) => b.properties.p - a.properties.p);
  $('#results-title').textContent = 'Sitios por potencia'; $('#result-count').textContent = fmt(fs.length);
  list.innerHTML = fs.slice(0, S.listLimit).map(f => {
    const p = f.properties, band = bandOf(p.p);
    return `<button class="opportunity-item ${S.selection?.site?.id === p.id ? 'selected' : ''}" data-site="${p.id}">${symbolSVG('power-' + band.key)}<span><span class="op-name">${esc(riverTitle(p.n))}</span><span class="op-area">${esc([p.mu, p.d].filter(Boolean).join(' · '))} · H ${fmt(p.h)} m${p.m ? ' · ⚠' : ''}</span></span><span class="op-power">${esc(power(p.p))}</span></button>`;
  }).join('') || '<p class="empty-list">No hay sitios con estos filtros.</p>';
  if (fs.length > S.listLimit) list.innerHTML += `<button class="text-button wide-button" id="list-more">Ver más sitios (${fmt(fs.length - S.listLimit)}) ${icon('arrow')}</button>`;
}

/* ───────────── Búsqueda ───────────── */
async function ensureRiverSearch() { if (!S.riverSearch) S.riverSearch = json(V + 'rivers-search.json.gz').catch(() => []); return S.riverSearch; }
async function search() {
  const q = normalize($('#search').value.trim()), el = $('#search-results');
  if (q.length < 2) { el.hidden = true; return; }
  const results = [];
  const rivers = await ensureRiverSearch();
  if (normalize($('#search').value.trim()) !== q) return;
  rivers.filter(r => normalize(r.name).includes(q)).map(r => {
    const n = normalize(r.name), bare = n.replace(/^(rio|quebrada|cano|canal|arroyo)\s+/, '');
    return {r, score: n === q || bare === q ? 100 : n.startsWith(q) || bare.startsWith(q) ? 50 : 10};
  }).sort((a, b) => b.score - a.score || b.r.upstream_km2 - a.r.upstream_km2).slice(0, 5)
    .forEach(({r}) => results.push({type: 'river', title: r.name, subtitle: `Río · cuenca ${fmt(r.upstream_km2)} km²`, value: r}));
  const munis = new Map();
  for (const f of S.sites) { const p = f.properties; if (p.mu && normalize(p.mu).includes(q) && !munis.has(p.mu + p.d)) munis.set(p.mu + p.d, f); if (munis.size >= 4) break; }
  for (const f of munis.values()) results.push({type: 'municipality', title: f.properties.mu, subtitle: `Municipio · ${f.properties.d}`, value: f});
  for (const f of [...(S.data.plants?.features || []), ...(S.data.municipalPlants?.features || [])]) { if (normalize(f.properties.name).includes(q)) results.push({type: 'plant', title: f.properties.name, subtitle: `Central · ${f.properties.department || ''}`, value: f}); if (results.length >= 12) break; }
  for (const f of S.data.departments?.features || []) if (normalize(f.properties.name).includes(q)) results.push({type: 'department', title: f.properties.name, subtitle: 'Departamento', value: f});
  el.innerHTML = results.length ? results.map((r, i) => `<button class="search-result" data-search="${i}"><b>${esc(r.title)}</b><small>${esc(r.subtitle)}</small></button>`).join('') : '<p class="empty-list">Sin resultados.</p>';
  el.hidden = false;
  el.onclick = async e => {
    const b = e.target.closest('[data-search]'); if (!b) return;
    const r = results[+b.dataset.search]; el.hidden = true; $('#search').value = r.title;
    if (r.type === 'river') { map.flyTo({center: r.value.center, zoom: 10, duration: 650}); await selectReach(r.value.id, r.value.cell, r.value.center); }
    else if (r.type === 'municipality') { map.flyTo({center: r.value.geometry.coordinates, zoom: 10, duration: 650}); $('#viewport-only').checked = true; setTimeout(renderList, 800); }
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
  const m = S.manifest || {}, rep = m.reports || {}, sites = rep.sites || {}, hyd = rep.hydrology || {}, ctx = rep.context || {}, prof = rep.profile || {};
  const par = sites.parameters || {};
  $('#sources-content').innerHTML = `<p>Herramienta de <b>exploración preliminar</b> a escala nacional. Cada número indica su fuente y su método. Ningún resultado es un diseño, una concesión de aguas ni una licencia: todos requieren estudios de campo. Datos procesados el ${esc(m.generated || '')}.</p>
  <div class="method-box"><h3>Cómo se calcula un sitio candidato</h3><p>
   1) <b>Caudal</b>: rendimiento hídrico de cada subzona (IDEAM, Estudio Nacional del Agua 2022) × área aportante de cada tramo, acumulado por la red. Se usa la <b>oferta disponible de año medio</b>, que ya descuenta el caudal ambiental estimado por el IDEAM.<br>
   2) <b>Salto</b>: perfil del lecho cada ≤100 m con FABDEM (sin bosque ni edificios), mínimo 3×3 píxeles y condicionamiento hidrológico (promedio de perfiles tallado y rellenado).<br>
   3) <b>Esquema</b>: desde cada estación se busca la casa de máquinas aguas abajo (≤${fmt(par.max_river_km)} km por el cauce) con más salto, con conducción en línea recta ≤${fmt(par.max_conduit_km)} km, salto ≥${fmt(par.min_head_m)} m y ≥${fmt(par.min_gradient_m_per_km)} m de salto por km de conducción.<br>
   4) <b>Potencia</b> = 9,81 × Q × H × (1 − ${fmt((par.head_loss || 0) * 100)} %) × ${fmt(par.efficiency, 2)}.<br>
   5) <b>Sin solapes</b>: de mayor a menor potencia, se descarta un sitio si su tramo intervenido ya pertenece a otro. Resultado: ${fmt(sites.sites)} sitios ≥ ${fmt(par.min_site_kw)} kW.<br>
   6) <b>Corredor</b>: bocatoma, conducción, tramo reducido y casa de máquinas se cruzan (margen ${fmt(ctx.corridor_buffer_m)} m) con áreas protegidas, páramos, reservas Ley 2ª, resguardos, consejos comunitarios y zonas de reserva campesina.</p></div>
  <div class="source-row"><h3>Red hidrográfica<br>${fmt(m.counts?.reaches)} tramos</h3><div><p>HydroSHEDS v2 (≈30 m, cuenca mínima 1 km²) como única geometría; nombres IGAC 1:25.000/1:100.000 por coincidencia espacial. Servida en teselas PMTiles.</p>${link('https://www.hydrosheds.org/products/hydrosheds-v2', 'HydroSHEDS v2 · CC BY 4.0')}</div></div>
  <div class="source-row"><h3>Caudal</h3><div><p>IDEAM, ENA 2022, Anexo 1: oferta total y disponible (año medio, seco y húmedo) de las 316 subzonas; polígonos de subzona publicados por la UPME (zonificación IDEAM 2013). Contraste con HydroRIVERS en ${fmt(hyd.contrast_hydrorivers?.pairs)} tramos: mediana de la razón ${fmt(hyd.contrast_hydrorivers?.ratio_ena_hydrorivers_median, 2)}; ${fmt(hyd.contrast_hydrorivers?.within_factor_2_pct, 0)} % dentro de un factor 2. Clase Q95 de la UPME transferida a ${fmt(hyd.q95_transferred)} tramos.</p>${link('https://www.ideam.gov.co/nuestra-entidad/hidrologia/estudio-nacional-del-agua-2022', 'ENA 2022')} · ${link('https://geo.upme.gov.co/server/rest/services/Capas_FuenteEnergia_Hidraulica', 'Capas hidráulicas UPME')}</div></div>
  <div class="source-row"><h3>Elevación</h3><div><p>FABDEM V1-2 (Copernicus WorldDEM-30 © DLR e.V., sin bosques ni edificios). ${fmt(prof.stations)} estaciones del lecho. Mosaicos verificados contra el CRC32 del archivo oficial de la Universidad de Bristol. <b>Licencia CC BY-NC-SA 4.0: uso no comercial.</b> El relieve 3D del mapa usa Copernicus GLO-30 (Mapterhorn) solo como visualización.</p>${link('https://data.bris.ac.uk/data/dataset/s5hqmjcdj8yo2ibzi9b4ew3sn', 'FABDEM')}</div></div>
  <div class="source-row"><h3>Restricciones</h3><div><p>RUNAP (Parques Nacionales), páramos y reservas Ley 2ª (MinAmbiente), resguardos indígenas y consejos comunitarios (Agencia Nacional de Tierras, 2026), zonas de reserva campesina (UPME), embalses existentes (IGAC 1:100.000 y OpenStreetMap © colaboradores, ODbL). Amenaza por movimientos en masa: servicio en vivo del SGC (no se redistribuye). Faltan determinantes de POMCA y POT, concesiones de agua existentes (RURH), vedas y decisiones judiciales.</p>${link('https://runap.parquesnacionales.gov.co/', 'RUNAP')} · ${link('https://data-agenciadetierras.opendata.arcgis.com/', 'Datos abiertos ANT')}</div></div>
  <div class="source-row"><h3>Infraestructura</h3><div><p>Centrales XM / UPME; subestaciones y líneas de transmisión UPME; proyectos con capacidad de transporte asignada (UPME); estaciones IDEAM. Referencias del Atlas UPME 2015 disponibles como capa de comparación.</p>${link('https://paratec.xm.com.co/', 'XM–PARATEC')} · ${link('https://geo.upme.gov.co/server/rest/services/Capas_EnergiaElectrica', 'Capas eléctricas UPME')}</div></div>
  <div class="method-box"><h3>Límites que el revisor debe tener presentes</h3><p>• El rendimiento es un promedio por subzona: no capta diferencias entre cabecera y valle dentro de ella.<br>• El salto viene de un modelo global (error de pocos metros): saltos menores de ~20 m son inciertos.<br>• FABDEM refleja el terreno de 2011–2015: presas y embalses posteriores se marcan con la capa de embalses, pero otras obras recientes pueden no estar.<br>• Contraste con 35 PCH existentes: todas tienen un esquema a menos de 3 km; la potencia estimada tiende a superar la instalada (mediana ×1,6), porque se toma el mejor esquema posible.<br>• La conducción se mide en línea recta; el trazado real será más largo.<br>• No se evalúan geotecnia, accesos, sedimentos, usos del agua existentes ni costos.<br>• Las coincidencias del corredor son alertas para revisar, no conceptos jurídicos.</p></div>`;
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
  for (const id of ['sources-open', 'method-open']) $('#' + id).onclick = () => { renderSources(); $('#sources-dialog').showModal(); };
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
  $('#detail-content').addEventListener('input', e => {
    if (!e.target.closest('.scenario-form') || e.target.closest('.params-form')) return;
    const o = S.selection?.option; if (!o) return;
    const q = $('#sc-q').value === '' ? NaN : Number($('#sc-q').value);
    $('#scenario-result').innerHTML = scenarioText(q, Number($('#sc-eta').value) / 100, Number($('#sc-loss').value) / 100, Number($('#sc-cf').value) / 100, o.head);
  });
  $('#detail-content').addEventListener('click', async e => {
    if (!e.target.closest('#research')) return;
    const sel = S.selection; if (!sel?.reach) return;
    S.params = {...S.params, maxConduit: +$('#pa-conduit').value || DEFAULTS.maxConduit, minHead: +$('#pa-head').value || DEFAULTS.minHead,
      minGradient: +$('#pa-grad').value >= 0 ? +$('#pa-grad').value : DEFAULTS.minGradient, maxRiver: Math.min(9, +$('#pa-river').value || DEFAULTS.maxRiver)};
    e.target.closest('#research').disabled = true; e.target.closest('#research').textContent = 'Recorriendo el río…';
    const option = await searchBest(sel.reach, S.params);
    if (S.selection !== sel) return;
    const next = {...sel, kind: 'reach', id: 'reach-' + sel.reach.id, option, site: undefined, context: undefined};
    setSelection(next);
    if (!option) toast('Con esos criterios no hay un esquema desde este tramo.');
  });
}
function setDimension(use3D) {
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
      applyFilters();
      $('#map-loading').hidden = true; document.body.dataset.atlasReady = 'true'; window.dispatchEvent(new Event('atlas-ready'));
      $('#data-status').textContent = `${fmt(S.sites.length)} sitios · 605.905 tramos`;
      void attachBasemap(map, 'relief');
      S.manifest = await manifestPromise; S.subzonas = await subzonaPromise; renderSources();
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
