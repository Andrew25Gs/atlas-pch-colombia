// Cálculos de ingeniería y economía para la ficha (revisión del panel, 2026-11-12).
// Todo es PRELIMINAR: supuestos editables y rangos, no diseño. Unidades SI (Q en m³/s, H en m, P en kW).

/* ───────── Estadística normal ───────── */
export function normCdf(x) {               // Φ(x) con erf de Abramowitz-Stegun (error < 1,5e-7)
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
export function normInv(p) {               // Φ⁻¹(p), aproximación de Acklam (error relativo < 1,2e-9)
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pl = 0.02425;
  if (p <= 0) return -Infinity; if (p >= 1) return Infinity;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/* ───────── Curva de duración de caudales (revisión hidrológica) ─────────
 * Lognormal con media Qm (caudal medio de año medio, ENA 2022) y σ obtenida del Índice de Regulación Hídrica
 * de la subzona (IRH, ENA 2022 Anexo 2): σ = −2·Φ⁻¹(IRH/2).
 * Q_p (caudal superado una fracción p del tiempo) = Qm·exp(σ·Φ⁻¹(1−p) − σ²/2).
 * Volumen turbinable medio con caudal ambiental a y caudal de diseño d: E = C(a) − C(a+d),
 * con C(K) = Qm·Φ(d₁) − K·Φ(d₁−σ), d₁ = (ln(Qm/K) + σ²/2)/σ.  Factor de planta = E/d. */
export function fdcSigma(irh) {
  const v = Math.min(Math.max(Number(irh) || 0.65, 0.2), 0.95);
  return -2 * normInv(v / 2);
}
export function fdcQ(qm, sigma, p) { return qm * Math.exp(sigma * normInv(1 - p) - sigma * sigma / 2); }
function callC(qm, sigma, k) {
  if (k <= 0) return qm;
  const d1 = (Math.log(qm / k) + sigma * sigma / 2) / sigma;
  return qm * normCdf(d1) - k * normCdf(d1 - sigma);
}
/** Caudal medio turbinado y factor de planta para un caudal ambiental a y un caudal de diseño d. */
export function fdcTurbined(qm, sigma, a, d) {
  if (!(qm > 0) || !(d > 0)) return {qTurb: 0, plantFactor: 0};
  const qTurb = Math.max(0, callC(qm, sigma, a) - callC(qm, sigma, a + d));
  return {qTurb, plantFactor: Math.min(1, qTurb / d)};
}

/* ───────── Prediseño mecánico (revisión del ingeniero mecánico) ─────────
 * Esquema canal + tubería de presión: canal (pérdida 0,8 m + 1 m/km) hasta la cámara de carga y tubería
 * de longitud Lp ≈ 2,6·Hp. Diámetro de Fahlbusch (acero) D = 1,12·Hp^−0,12·Q^0,45; fricción Swamee-Jain;
 * turbina por salto y potencia; eficiencias por tipo y tamaño (ESHA). */
function interpLog(x, xs, ys) {
  const lx = Math.log10(Math.max(x, xs[0]));
  for (let i = 1; i < xs.length; i++) if (lx <= Math.log10(xs[i])) {
    const a = Math.log10(xs[i - 1]), b = Math.log10(xs[i]);
    return ys[i - 1] + (ys[i] - ys[i - 1]) * (lx - a) / (b - a);
  }
  return ys[ys.length - 1];
}
export function predesign({q, hg, conduitKm, riverKm}) {
  const g = 9.81, lc = conduitKm * 1000, lr = riverKm * 1000;
  if (!(q > 0) || !(hg > 0)) return null;
  const lCanal = Math.min(Math.max(lr, 1.15 * lc), 1.6 * lc);
  const hCanal = 0.8 + 0.001 * lCanal;
  const hp = Math.max(hg - hCanal, 1), lp = 2.6 * hp;
  const d = 1.12 * Math.pow(hp, -0.12) * Math.pow(q, 0.45);
  const v = 4 * q / (Math.PI * d * d), re = v * d / 1.1e-6, eps = 1e-4;
  const f = 0.25 / Math.log10(eps / (3.7 * d) + 5.74 / Math.pow(re, 0.9)) ** 2;
  const hf = (f * lp / d + 0.85) * v * v / (2 * g);
  let hn = hp - hf;
  const pHyd = g * q * hn, units = pHyd > 3000 ? 2 : 1, pu = pHyd / units;
  const type = pu < 300 && hn < 120 ? 'Banki (flujo cruzado)' : hn > 150 ? 'Pelton' : hn >= 25 ? 'Francis' : 'Kaplan';
  hn -= type === 'Pelton' ? 2.5 : type.startsWith('Banki') ? 1 : 0;
  const peakBase = {Pelton: 0.90, Francis: 0.93, Kaplan: 0.92}[type] ?? 0.82;
  const peak = peakBase - (!type.startsWith('Banki') && pu < 2000 ? 0.02 * Math.log10(2000 / Math.max(pu, 20)) : 0);
  const etaGen = interpLog(pu, [10, 100, 1000, 20000], [0.91, 0.95, 0.97, 0.98]);
  const eta = peak * 0.985 * etaGen * 0.98 * (type.startsWith('Banki') ? 0.97 : 1);
  const pKW = g * q * hn * eta;
  // Golpe de ariete: tiempo de arranque del agua en la tubería (Tw > 3 s pide chimenea o válvula de alivio)
  const tw = lp * v / (g * Math.max(hn, 1));
  return {hn, lossPct: 100 * (hg - hn) / hg, d, v, type, units, eta, pKW, pPCH: Math.min(pKW, 19900),
    capped: pKW > 19900, qPCH: pKW > 19900 ? 19900 / (g * hn * eta) : q, lCanal, lp, tw};
}

/* ───────── Economía indicativa (revisiones de negocios, mecánica y eléctrica) ─────────
 * Inversión: 2.800 USD/kW·(P/10 MW)^−0,2, ×1,2 si H < 50 m, ×0,9 si H > 150 m, acotada a 1.800–9.000 USD/kW
 * (orden de magnitud IRENA para pequeña hidro), banda −30 % / +50 %. Túnel: 5.000 USD/m (rango 3.000–8.000).
 * Costo nivelado = inversión·(FRC + 2,5 % O&M)/energía. Todo editable en la ficha. */
export const ECON_DEFAULTS = {trm: 4000, priceCOPkWh: 330, rate: 0.10, years: 30, omPct: 2.5, tunnelUSDm: 5000};
export function economics({pKW, head, energyMWh, tunnelKm = 0, gridMCOP = 0, opts = {}}) {
  const o = {...ECON_DEFAULTS, ...opts};
  if (!(pKW > 0) || !(energyMWh > 0)) return null;
  let usdKW = 2800 * Math.pow(pKW / 10000, -0.2) * (head < 50 ? 1.2 : head > 150 ? 0.9 : 1);
  usdKW = Math.min(Math.max(usdKW, 1800), 9000);
  const plantUSD = usdKW * pKW;
  const tunnelUSD = tunnelKm * 1000 * o.tunnelUSDm;
  const gridUSD = gridMCOP * 1e6 / o.trm;
  const capex = plantUSD + tunnelUSD + gridUSD;
  const crf = o.rate * (1 + o.rate) ** o.years / ((1 + o.rate) ** o.years - 1);
  const annualCost = capex * (crf + o.omPct / 100);
  const lcoeUSD = annualCost / (energyMWh * 1000);             // USD/kWh
  const revenueUSD = energyMWh * 1000 * o.priceCOPkWh / o.trm;
  const payback = revenueUSD > capex * o.omPct / 100 ? capex / (revenueUSD - capex * o.omPct / 100) : Infinity;
  return {usdKW, plantUSD, tunnelUSD, gridUSD, capex, capexLow: capex * 0.7, capexHigh: capex * 1.5,
    lcoeUSD, lcoeCOP: lcoeUSD * o.trm, revenueUSD, revenueCOP: revenueUSD * o.trm, payback, o};
}
