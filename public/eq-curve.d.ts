// Tipos de eq-curve.js (o arquivo é JavaScript puro porque também roda no navegador).

export type BandShape = "peq" | "low" | "high";
export interface Band {
  shape: BandShape;
  f: number;
  g: number;
  q: number;
}
export interface Cut {
  on: boolean;
  f: number;
  slope: number;
}
export interface EqModel {
  eqOn: boolean;
  bands: Band[];
  lc: Cut | null;
  hc: Cut | null;
}

export const FS: number;
export const F_MIN: number;
export const F_MAX: number;
export function bandCoefs(shape: BandShape, f0: number, gainDb: number, q: number, fs?: number): number[];
export function bandDb(band: Band, f: number, fs?: number): number;
export function cutDb(kind: "hp" | "lp", f: number, fc: number, slope: number): number;
export function responseDb(model: EqModel, f: number, fs?: number): number;
export function logFreqs(n: number, fmin?: number, fmax?: number): number[];
export function quantize(value: number, range: { type: string; min: number; max: number; steps?: number }): number;
