// Strips do mixer: canais, aux, buses, mains, matrizes, DCAs e mute groups.
// Quantidades e parâmetros conferidos na WING real (firmware 3.1) via GET de nó e
// descrição ",s #": /ch 40, /aux 8, /bus 16, /main 4, /mtx 8, /dca 16, /mgrp 8.
// DCA não tem pan; mute group só tem nome e mute.

import type { WingValue } from "./osc.ts";

export type StripKind = "ch" | "aux" | "bus" | "main" | "mtx" | "dca" | "mgrp";

export interface StripKindInfo {
  kind: StripKind;
  label: string;
  count: number;
  /** Parâmetros lidos (sufixo do caminho /<kind>/<n>/...). */
  params: readonly StripParam[];
  /** Token de medidor do protocolo nativo e quantos valores vêm por strip (Table 4/5). */
  meter: { token: number; words: number } | null;
}

export type StripParam = "name" | "col" | "mute" | "fdr" | "pan" | "$solo" | "in/set/$g";

const FULL: readonly StripParam[] = ["name", "col", "mute", "fdr", "pan", "$solo"];

export const STRIP_KINDS: readonly StripKindInfo[] = [
  { kind: "ch", label: "Canais", count: 40, params: [...FULL, "in/set/$g"], meter: { token: 0xa0, words: 8 } },
  { kind: "aux", label: "Aux", count: 8, params: FULL, meter: { token: 0xa1, words: 8 } },
  { kind: "bus", label: "Buses", count: 16, params: FULL, meter: { token: 0xa2, words: 8 } },
  { kind: "main", label: "Mains", count: 4, params: FULL, meter: { token: 0xa3, words: 8 } },
  { kind: "mtx", label: "Matrizes", count: 8, params: FULL, meter: { token: 0xa4, words: 8 } },
  // DCA: pre fader L/R, post fader L/R (Table 5).
  { kind: "dca", label: "DCAs", count: 16, params: ["name", "col", "mute", "fdr", "$solo"], meter: { token: 0xa5, words: 4 } },
  { kind: "mgrp", label: "Mute groups", count: 8, params: ["name", "mute"], meter: null },
];

export const STRIP_INFO = Object.fromEntries(STRIP_KINDS.map((k) => [k.kind, k])) as Record<StripKind, StripKindInfo>;

export interface StripMeter {
  l: number;
  r: number;
}

export interface StripState {
  kind: StripKind;
  index: number;
  name: string;
  col: number | null;
  mute: boolean | null;
  faderDb: number | null;
  pan: number | null;
  solo: boolean | null;
  gainDb: number | null;
  meter: StripMeter | null;
}

export type Strips = Record<StripKind, StripState[]>;

export function createStrips(): Strips {
  const out = {} as Strips;
  for (const k of STRIP_KINDS) {
    out[k.kind] = Array.from({ length: k.count }, (_, i) => ({
      kind: k.kind,
      index: i + 1,
      name: "",
      col: null,
      mute: null,
      faderDb: null,
      pan: null,
      solo: null,
      gainDb: null,
      meter: null,
    }));
  }
  return out;
}

export function stripPaths(kind: StripKind, index: number): string[] {
  return STRIP_INFO[kind].params.map((p) => `/${kind}/${index}/${p}`);
}

const STRIP_PATH = /^\/(ch|aux|bus|main|mtx|dca|mgrp)\/(\d+)\/(name|col|mute|fdr|pan|\$solo|in\/set\/\$g)$/;

/** Aplica um valor vindo da mesa ao estado. Devolve o strip alterado ou null. */
export function applyStripValue(strips: Strips, address: string, value: WingValue): StripState | null {
  const m = STRIP_PATH.exec(address);
  if (!m) return null;
  const kind = m[1] as StripKind;
  const st = strips[kind][Number(m[2]) - 1];
  if (!st || !STRIP_INFO[kind].params.includes(m[3] as StripParam)) return null;
  const num = value.kind === "string" ? null : value.value;
  switch (m[3]) {
    case "name":
      st.name = value.text;
      break;
    case "col":
      if (num !== null) st.col = num;
      break;
    case "mute":
      if (num !== null) st.mute = num === 1;
      break;
    case "$solo":
      if (num !== null) st.solo = num === 1;
      break;
    case "fdr":
      if (value.kind === "float") st.faderDb = value.value;
      break;
    case "pan":
      if (value.kind === "float") st.pan = value.value;
      break;
    case "in/set/$g":
      if (value.kind === "float") st.gainDb = value.value;
      break;
  }
  return st;
}

/** L/R exibidos: saída do strip (palavras 2 e 3 em todas as seções, inclusive DCA pós-fader). */
export function stripMeterFromWords(words: number[]): StripMeter | null {
  const l = words[2];
  const r = words[3];
  return l === undefined || r === undefined ? null : { l, r };
}

/** Report id da coleção única de medidores. */
export const METER_REPORT_ID = 1;

/** Tipos com medidor, na ordem em que vão no pedido (e voltam no pacote). */
export const METERED_KINDS = STRIP_KINDS.filter((k) => k.meter);

/** Grupos do pedido de medidores: todos os strips de todos os tipos com medidor. */
export function meterGroups(): { token: number; indices: number[] }[] {
  return METERED_KINDS.map((k) => ({
    token: k.meter!.token,
    indices: Array.from({ length: k.count }, (_, i) => i + 1),
  }));
}

/**
 * Separa o pacote da coleção única em medidores por strip, na ordem do pedido.
 * Pacote: report id (4 bytes) + int16 BE em 1/256 dB.
 */
export function splitMeterPacket(packet: Buffer): { kind: StripKind; index: number; meter: StripMeter | null }[] | null {
  if (packet.length < 4 || packet.readUInt32BE(0) !== METER_REPORT_ID) return null;
  const out: { kind: StripKind; index: number; meter: StripMeter | null }[] = [];
  let off = 4;
  for (const k of METERED_KINDS) {
    const words = k.meter!.words;
    for (let i = 1; i <= k.count; i++) {
      if (off + words * 2 > packet.length) return out;
      const vals: number[] = [];
      for (let w = 0; w < words; w++) vals.push(packet.readInt16BE(off + w * 2) / 256);
      out.push({ kind: k.kind, index: i, meter: stripMeterFromWords(vals) });
      off += words * 2;
    }
  }
  return out;
}
