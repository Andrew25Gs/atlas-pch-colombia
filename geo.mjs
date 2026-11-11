// Cálculos geográficos e hidroeléctricos del Atlas PCH (sin dependencias).
export const EMPTY = {type: 'FeatureCollection', features: []};
export const fc = features => ({type: 'FeatureCollection', features});
export const rad = v => v * Math.PI / 180;

/** Distancia geodésica en km entre [lon, lat] (fórmula del semiverseno). */
export function distance(a, b) {
  const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

export function bboxOf(geom) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  (function visit(c) {
    if (typeof c[0] === 'number') {
      box[0] = Math.min(box[0], c[0]); box[1] = Math.min(box[1], c[1]);
      box[2] = Math.max(box[2], c[0]); box[3] = Math.max(box[3], c[1]);
    } else c.forEach(visit);
  })(geom.coordinates);
  return box;
}

export const pointFeature = (coord, properties = {}) => ({type: 'Feature', geometry: {type: 'Point', coordinates: coord}, properties});
export const lineFeature = (coords, properties = {}) => ({type: 'Feature', geometry: {type: 'LineString', coordinates: coords}, properties});

/**
 * Potencia hidráulica (kW) = 9,81 · Q (m³/s) · H neto (m) · η.
 * 9,81 = gravedad (m/s²) × densidad del agua (1000 kg/m³) / 1000 (W → kW).
 */
export function hydraulicPowerKW(q, hNet, eta = 0.85) {
  if (![q, hNet, eta].every(Number.isFinite) || q < 0 || hNet < 0 || eta <= 0 || eta > 1) return null;
  return 9.81 * q * hNet * eta;
}

export function normalize(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Celda de 1° codificada como entero en las teselas → clave "lon_lat" de los archivos. */
export function cellKeyFromInt(k) {
  const lon = Math.floor(k / 1000) - 180, lat = (k % 1000) - 90;
  return `${lon}_${lat}`;
}
export const cellKeyFromCoord = ([lon, lat]) => `${Math.floor(lon)}_${Math.floor(lat)}`;
