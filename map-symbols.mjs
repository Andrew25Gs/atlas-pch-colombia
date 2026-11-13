// Paleta y símbolos del mapa: una sola fuente para el mapa, la simbología y los filtros.
const bolt = {fill: 'M13 2 4.5 13H10l-.8 9L20 9.5h-6L15.5 2Z'};
const dam = {line: 'M3 15h18M5 15l3-9h8l3 9M10 6v9m4-9v9M3 19q2-2 4 0t4 0t4 0t4 0'};
const municipal = {line: 'M3 9V3h5m8 0h5v6M3 15v6h5m8 0h5v-6M6 15h12l-2.5-6h-7zM7 18q1.25-1.5 2.5 0t2.5 0t2.5 0t2.5 0'};
const gauge = {line: 'M8 3h8v13H8zM8 6h4m-4 3h6m-6 3h4M3 20q2-2 4 0t4 0t4 0t4 0'};
const tower = {line: 'M5 21 10 3h4l5 18M4 8h16M3 13h18M7.5 13l9 5m0-5-9 5M10 5l5.2 3M14 5l-5.2 3M5 8v2m14-2v2M4 13v2m16-2v2'};
const project = {line: 'M4 20V9l8-5 8 5v11M9 20v-6h6v6M3 20h18M12 4v3'};

// Clases de potencia (kW). La sexta señala lo que supera el rango de una PCH (20 MW).
// Paleta apta para daltonismo (revisión de diseño, 2026-11-12): azules = micro/mini, naranjas = PCH,
// vino = PCH grande, gris atenuado = fuera de rango. ΔE mínimo 13,3 en deuteranopia y 14,5 en protanopia.
export const POWER_BANDS = [
  {id: 1, key: 'micro', min: 0, max: 50, label: 'Menos de 50 kW', color: '#4a88c2'},
  {id: 2, key: 'mini', min: 50, max: 500, label: '50 a 500 kW', color: '#1f4f8f'},
  {id: 3, key: 'small', min: 500, max: 5000, label: '0,5 a 5 MW', color: '#bd7410'},
  {id: 4, key: 'medium', min: 5000, max: 10000, label: '5 a 10 MW', color: '#a3470d'},
  {id: 5, key: 'large', min: 10000, max: 20000, label: '10 a 20 MW', color: '#6e1a3c'},
  {id: 6, key: 'over', min: 20000, max: Infinity, label: 'Más de 20 MW (fuera de rango PCH)', color: '#7a828b'},
];
export const bandOf = kw => POWER_BANDS.find(b => kw >= b.min && kw < b.max) || POWER_BANDS[0];
export const powerImage = ['match', ['get', 'c'], ...POWER_BANDS.flatMap(b => [b.id, 'atlas-power-' + b.key]), 'atlas-power-micro'];
export const powerColor = ['match', ['get', 'pc'], ...POWER_BANDS.flatMap(b => [b.id, b.color]), '#d5ddd8'];

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
// Notas legales revisadas por el abogado del panel (2026-11-12), con su norma. Colores distinguibles entre sí
// y con daltonismo (revisión de diseño): los territorios étnicos van sin relleno fuerte para no tapar el mapa.
export const CONSTRAINTS = [
  {bit: 256, key: 'embalse', group: 'environment', label: 'Embalse existente', note: 'El salto puede estar inundado o ya aprovechado por una central. Probable concesión de aguas y zona de utilidad pública de otro titular (IGAC 1:100.000 y OpenStreetMap).', color: '#1d6fb8', opacity: .45, severity: 'prohibition'},
  {bit: 1, key: 'spnn', group: 'environment', label: 'Parque Nacional (SPNN)', note: 'Prohibidas las actividades industriales (Decreto 1076 de 2015, art. 2.2.2.1.15.1 num. 3). Las áreas del SPNN no se pueden sustraer.', color: '#b42318', opacity: .22, severity: 'prohibition'},
  {bit: 2, key: 'dmi', group: 'environment', label: 'DMI / DRMI', note: 'Se admite infraestructura solo en zonas de uso sostenible según el plan de manejo; en preservación o restauración está prohibido todo uso no permitido (Decreto 1076, arts. 2.2.2.1.4.1 y 2.2.2.1.4.2).', color: '#c26a0a', opacity: .2, dash: [2, 2], border: 'dashed', severity: 'review'},
  {bit: 4, key: 'protected', group: 'environment', label: 'Otra área protegida (RUNAP)', note: 'El régimen depende de la categoría: revisar el acto de declaratoria y el plan de manejo.', color: '#2e7d4f', opacity: .18, severity: 'review'},
  {bit: 8, key: 'paramo', group: 'environment', label: 'Páramo delimitado', note: 'La Ley 1930 de 2018 (art. 5) prohíbe nuevas vías, degradar la vegetación nativa y los usos incompatibles, y exige concepto previo del MinAmbiente para proyectos licenciados. Bocatomas, conducciones y accesos en páramo son en la práctica inviables.', color: '#7a3fa0', opacity: .2, dash: [.9, 1.5], border: 'dotted', severity: 'prohibition'},
  {bit: 16, key: 'ley2', group: 'environment', label: 'Reserva forestal Ley 2ª', note: 'Una PCH exige sustracción ante el MinAmbiente (Resolución 1705 de 2024); las PCH no figuran entre las actividades exentas. Revisar la zonificación (tipo A, B o C) y, si hay traslape étnico, la consulta previa.', color: '#4f5d1c', opacity: .08, dash: [6, 3], border: 'dashed', severity: 'review'},
  {bit: 32, key: 'resguardo', group: 'ethnic', label: 'Resguardo indígena', note: 'Territorio colectivo e inalienable (Constitución, arts. 63 y 329). La consulta previa depende de la afectación directa, no solo del título (Sentencia SU-123 de 2018); decide su procedencia la Dirección de la Autoridad Nacional de Consulta Previa del MinInterior (Decreto 2353 de 2019).', color: '#c0307a', opacity: .1, dash: [3, 1.5], border: 'dashed', severity: 'consult'},
  {bit: 64, key: 'consejo', group: 'ethnic', label: 'Consejo comunitario', note: 'Título colectivo de comunidad negra (Ley 70 de 1993), inalienable. Consulta previa por afectación directa (Convenio 169 OIT, Ley 21 de 1991); procedencia ante la Dirección de la Autoridad Nacional de Consulta Previa.', color: '#4a3528', opacity: .1, dash: [1.5, 1.5], border: 'dotted', severity: 'consult'},
  {bit: 128, key: 'zrc', group: 'ethnic', label: 'Zona de reserva campesina', note: 'No prohíbe proyectos, pero su plan de desarrollo sostenible orienta los usos y limita la adquisición de predios (Ley 160 de 1994, cap. XIII). No hay consulta previa étnica, pero sí participación.', color: '#8a6d1f', opacity: .1, dash: [1, 2], border: 'dotted', severity: 'review'},
];
export const constraintsOf = mask => CONSTRAINTS.filter(c => (mask & c.bit) !== 0);

/** Nota y gravedad según la categoría RUNAP concreta (la categoría "otra área protegida" mezcla regímenes). */
export function protectedCategoryNote(category = '') {
  const c = category.toLowerCase();
  if (c.includes('parque natural regional') || c.includes('parques naturales regionales'))
    return {severity: 'prohibition', note: 'Parque natural regional: la corporación autónoma no licencia infraestructura en estos parques (Decreto 1076, art. 2.2.2.3.2.3 num. 21). Trátelo como exclusión.'};
  if (c.includes('reserva forestal protectora'))
    return {severity: 'prohibition', note: 'Reserva forestal protectora: solo se admite el aprovechamiento de frutos secundarios del bosque (Decreto 1076, art. 2.2.2.1.2.3). Exige sustracción ante el MinAmbiente o la CAR (Resolución 1705 de 2024).'};
  if (c.includes('sociedad civil'))
    return {severity: 'review', note: 'Reserva natural de la sociedad civil: predio privado; hace falta el consentimiento de su titular (Decreto 1076, art. 2.2.2.1.17.11).'};
  return null;
}