// Resposta de frequência do EQ e dos filtros, para desenhar a curva.
// JavaScript puro: carregado pela página (/eq-curve.js) e importado pelos testes.
// PEQ e shelves: biquads do "Audio EQ Cookbook" (R. Bristow-Johnson) a 48 kHz.
// Passa-alta/baixa: Butterworth de ordem slope/6 (magnitude analógica).
// É uma aproximação para a tela: a curva exata da WING não é publicada.

export const FS = 48000;
export const F_MIN = 20;
export const F_MAX = 20000;

/** Magnitude em dB de um biquad [b0, b1, b2, a0, a1, a2] na frequência f. */
function biquadDb(c, f, fs) {
  const w = (2 * Math.PI * f) / fs;
  const cos1 = Math.cos(w), sin1 = Math.sin(w), cos2 = Math.cos(2 * w), sin2 = Math.sin(2 * w);
  const nr = c[0] + c[1] * cos1 + c[2] * cos2, ni = c[1] * sin1 + c[2] * sin2;
  const dr = c[3] + c[4] * cos1 + c[5] * cos2, di = c[4] * sin1 + c[5] * sin2;
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

/** Coeficientes de uma banda: shape "peq" | "low" (shelf) | "high" (shelf). */
export function bandCoefs(shape, f0, gainDb, q, fs = FS) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const cs = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  if (shape === "peq") return [1 + alpha * A, -2 * cs, 1 - alpha * A, 1 + alpha / A, -2 * cs, 1 - alpha / A];
  const s = 2 * Math.sqrt(A) * alpha;
  if (shape === "low") {
    return [A * (A + 1 - (A - 1) * cs + s), 2 * A * (A - 1 - (A + 1) * cs), A * (A + 1 - (A - 1) * cs - s),
      A + 1 + (A - 1) * cs + s, -2 * (A - 1 + (A + 1) * cs), A + 1 + (A - 1) * cs - s];
  }
  return [A * (A + 1 + (A - 1) * cs + s), -2 * A * (A - 1 + (A + 1) * cs), A * (A + 1 + (A - 1) * cs - s),
    A + 1 - (A - 1) * cs + s, 2 * (A - 1 - (A + 1) * cs), A + 1 - (A - 1) * cs - s];
}

export function bandDb(band, f, fs = FS) {
  if (!band.g) return 0;
  return biquadDb(bandCoefs(band.shape, band.f, band.g, band.q, fs), f, fs);
}

/** Filtro de corte: kind "hp" (passa-alta) | "lp" (passa-baixa), slope em dB/oitava. */
export function cutDb(kind, f, fc, slope) {
  const n = slope / 6;
  const r = kind === "hp" ? fc / f : f / fc;
  return -10 * Math.log10(1 + Math.pow(r, 2 * n));
}

/**
 * Curva total em dB na frequência f.
 * model: { eqOn, bands: [{shape, f, g, q}], lc: {on, f, slope}, hc: {on, f, slope} }
 */
export function responseDb(model, f, fs = FS) {
  let db = 0;
  if (model.eqOn) for (const b of model.bands) db += bandDb(b, f, fs);
  if (model.lc && model.lc.on) db += cutDb("hp", f, model.lc.f, model.lc.slope);
  if (model.hc && model.hc.on) db += cutDb("lp", f, model.hc.f, model.hc.slope);
  return db;
}

/** n frequências em escala logarítmica de fmin a fmax. */
export function logFreqs(n, fmin = F_MIN, fmax = F_MAX) {
  const out = [];
  const r = Math.log(fmax / fmin);
  for (let i = 0; i < n; i++) out.push(fmin * Math.exp((r * i) / (n - 1)));
  return out;
}

/**
 * Arredonda para o passo mais próximo da faixa descrita pela mesa
 * (log: passos iguais em razão; lin: passos iguais em diferença).
 */
export function quantize(value, { type, min, max, steps }) {
  const v = Math.min(max, Math.max(min, value));
  if (!steps || steps < 2) return v;
  if (type === "log" && min > 0) {
    const k = Math.round((Math.log(v / min) / Math.log(max / min)) * (steps - 1));
    return min * Math.pow(max / min, k / (steps - 1));
  }
  const k = Math.round(((v - min) / (max - min)) * (steps - 1));
  return min + ((max - min) * k) / (steps - 1);
}
