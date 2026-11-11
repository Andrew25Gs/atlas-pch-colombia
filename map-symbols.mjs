// Paleta y símbolos del mapa: una sola fuente para el mapa, la simbología y los filtros.
const bolt = {fill: 'M13 2 4.5 13H10l-.8 9L20 9.5h-6L15.5 2Z'};
const dam = {line: 'M3 15h18M5 15l3-9h8l3 9M10 6v9m4-9v9M3 19q2-2 4 0t4 0t4 0t4 0'};
const municipal = {line: 'M3 9V3h5m8 0h5v6M3 15v6h5m8 0h5v-6M6 15h12l-2.5-6h-7zM7 18q1.25-1.5 2.5 0t2.5 0t2.5 0t2.5 0'};
const gauge = {line: 'M8 3h8v13H8zM8 6h4m-4 3h6m-6 3h4M3 20q2-2 4 0t4 0t4 0t4 0'};
const tower = {line: 'M5 21 10 3h4l5 18M4 8h16M3 13h18M7.5 13l9 5m0-5-9 5M10 5l5.2 3M14 5l-5.2 3M5 8v2m14-2v2M4 13v2m16-2v2'};
const project = {line: 'M4 20V9l8-5 8 5v11M9 20v-6h6v6M3 20h18M12 4v3'};

// Clases de potencia (kW). La sexta señala lo que supera el rango de una PCH (20 MW).
export const POWER_BANDS = [
  {id: 1, key: 'micro', min: 0, max: 50, label: 'Menos de 50 kW', color: '#007b82'},
  {id: 2, key: 'mini', min: 50, max: 500, label: '50 a 500 kW', color: '#4a752b'},
  {id: 3, key: 'small', min: 500, max: 5000, label: '0,5 a 5 MW', color: '#a37808'},
  {id: 4, key: 'medium', min: 5000, max: 10000, label: '5 a 10 MW', color: '#bd4c1b'},
  {id: 5, key: 'large', min: 10000, max: 20000, label: '10 a 20 MW', color: '#82365c'},
  {id: 6, key: 'over', min: 20000, max: Infinity, label: 'Más de 20 MW (fuera de rango PCH)', color: '#454c55'},
];
export const bandOf = kw => POWER_BANDS.find(b => kw >= b.min && kw < b.max) || POWER_BANDS[0];
export const powerImage = ['match', ['get', 'c'], ...POWER_BANDS.flatMap(b => [b.id, 'atlas-power-' + b.key]), 'atlas-power-micro'];
export const powerColor = ['match', ['get', 'pc'], ...POWER_BANDS.flatMap(b => [b.id, b.color]), '#a9bcbc'];

const symbols = {
  ...Object.fromEntries(POWER_BANDS.map(b => ['power-' + b.key, {...bolt, color: b.color}])),
  plant: {...dam, color: '#245d46'}, municipal: {...municipal, color: '#885d25'},
  'station-active': {...gauge, color: '#226f9d'}, 'station-other': {...gauge, color: '#596771'},
  substation: {...tower, color: '#6d438a'}, project: {...project, color: '#8a3c2b'},
};
export function symbolSVG(id) {
  const {fill, line, color} = symbols[id];
  return `<svg class="atlas-symbol" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${
    fill ? `<path d="${fill}" fill="${color}" stroke="#fffdf5" stroke-width="1.5" stroke-linejoin="round"/>` : ''}${
    line ? `<path d="${line}" fill="none" stroke="#fffdf5" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="${line}" fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>` : ''}</svg>`;
}
export function registerMapSymbols(map) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 48;
  const ctx = canvas.getContext('2d', {willReadFrequently: true}); ctx.scale(2, 2); ctx.lineCap = ctx.lineJoin = 'round';
  for (const [id, {fill, line, color}] of Object.entries(symbols)) {
    ctx.clearRect(0, 0, 24, 24); const p = new Path2D(fill || line);
    ctx.strokeStyle = '#fffdf5'; ctx.lineWidth = fill ? 1.5 : 4; ctx.stroke(p);
    if (fill) { ctx.fillStyle = color; ctx.fill(p); } else { ctx.strokeStyle = color; ctx.lineWidth = 1.9; ctx.stroke(p); }
    if (!map.hasImage('atlas-' + id)) map.addImage('atlas-' + id, ctx.getImageData(0, 0, 48, 48), {pixelRatio: 2});
  }
}

// Bits de restricción calculados sobre el corredor (bocatoma, conducción, tramo intervenido y casa de máquinas).
export const CONSTRAINTS = [
  {bit: 256, key: 'embalse', group: 'environment', label: 'Embalse existente', note: 'El salto puede estar inundado o ya aprovechado por una central (IGAC 1:100.000 y OpenStreetMap).', color: '#2f6fa3', opacity: .35, severity: 'prohibition'},
  {bit: 1, key: 'spnn', group: 'environment', label: 'Parque Nacional (SPNN)', note: 'Prohibición general de actividades industriales (Decreto 1076 de 2015, art. 2.2.2.1.15.1).', color: '#a03530', opacity: .25, severity: 'prohibition'},
  {bit: 2, key: 'dmi', group: 'environment', label: 'DMI / DRMI', note: 'Revisar zonificación y plan de manejo.', color: '#ac651c', opacity: .23, dash: [2, 2], border: 'dashed', severity: 'review'},
  {bit: 4, key: 'protected', group: 'environment', label: 'Otra área protegida (RUNAP)', note: 'Revisar categoría y régimen de usos.', color: '#42754a', opacity: .20, severity: 'review'},
  {bit: 8, key: 'paramo', group: 'environment', label: 'Páramo delimitado', note: 'Revisar régimen de protección (Ley 1930 de 2018) y acto de delimitación.', color: '#783e94', opacity: .23, dash: [.9, 1.5], border: 'dotted', severity: 'review'},
  {bit: 16, key: 'ley2', group: 'environment', label: 'Reserva forestal Ley 2ª', note: 'Revisar zonificación y sustracción.', color: '#73751e', opacity: .14, dash: [4, 2], border: 'dashed', severity: 'review'},
  {bit: 32, key: 'resguardo', group: 'ethnic', label: 'Resguardo indígena', note: 'Consulta previa si el proyecto lo afecta (Convenio 169 OIT, Ley 21 de 1991).', color: '#b5527f', opacity: .16, dash: [3, 1.5], border: 'dashed', severity: 'consult'},
  {bit: 64, key: 'consejo', group: 'ethnic', label: 'Consejo comunitario', note: 'Consulta previa si el proyecto lo afecta (Ley 70 de 1993).', color: '#3d6fa8', opacity: .16, dash: [3, 1.5], border: 'dashed', severity: 'consult'},
  {bit: 128, key: 'zrc', group: 'ethnic', label: 'Zona de reserva campesina', note: 'Revisar plan de desarrollo sostenible.', color: '#9a7a2e', opacity: .14, dash: [1, 1.5], border: 'dotted', severity: 'review'},
];
export const constraintsOf = mask => CONSTRAINTS.filter(c => (mask & c.bit) !== 0);
