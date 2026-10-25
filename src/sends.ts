// Envios (mixes de retorno e matrizes). Estrutura conferida na WING real (fw 3.1):
//   /ch|aux/N/send/1..16  e  /ch|aux|bus/N/send/MX1..MX8, /main/N/send/MX1..MX8
//   cada envio: on (int 0..1), lvl (fader -oo..10 dB), mode (PRE|POST|GRP),
//   pon, plink, pan (pan fica r/o quando ligado ao do canal).
//   /bus/N/send/<bus> existe mas é somente leitura (bus não manda para bus).
//   Bus e main -> matriz não têm mode: usam pre (int 0 = pós, 1 = pré).

import type { WingValue } from "./osc.ts";
import type { StripKind } from "./strips.ts";
import { writeParam, type ParamWriteResult, type WingClient } from "./wing.ts";

export type SendDestKind = "bus" | "mtx";
export interface SendDest {
  kind: SendDestKind;
  index: number;
}

export type SendSourceKind = Extract<StripKind, "ch" | "aux" | "bus" | "main">;

export const SEND_SOURCES: Record<SendDestKind, { kind: SendSourceKind; count: number }[]> = {
  bus: [{ kind: "ch", count: 40 }, { kind: "aux", count: 8 }],
  mtx: [{ kind: "ch", count: 40 }, { kind: "aux", count: 8 }, { kind: "bus", count: 16 }, { kind: "main", count: 4 }],
};

export type SendParam = "on" | "lvl" | "mode" | "pre";

/** Parâmetro de pré/pós da fonte: canais e aux usam mode (PRE/POST/GRP); bus e main usam pre. */
export function modeParam(src: SendSourceKind): "mode" | "pre" {
  return src === "ch" || src === "aux" ? "mode" : "pre";
}

export function sendParams(src: SendSourceKind): SendParam[] {
  return ["on", "lvl", modeParam(src)];
}

/** "bus/3" -> {bus, 3}; "mtx/2" -> {mtx, 2}. */
export function parseDest(text: string): SendDest | null {
  const m = /^(bus|mtx)\/(\d+)$/.exec(text);
  if (!m) return null;
  const kind = m[1] as SendDestKind;
  const index = Number(m[2]);
  const max = kind === "bus" ? 16 : 8;
  return index >= 1 && index <= max ? { kind, index } : null;
}

/** Nome do destino dentro de /send/: buses "3", matrizes "MX2". */
export function destKey(dest: SendDest): string {
  return dest.kind === "bus" ? String(dest.index) : `MX${dest.index}`;
}

export function sendBase(src: SendSourceKind, index: number, dest: SendDest): string {
  return `/${src}/${index}/send/${destKey(dest)}`;
}

export function sendPaths(dest: SendDest): string[] {
  const out: string[] = [];
  for (const s of SEND_SOURCES[dest.kind]) {
    for (let i = 1; i <= s.count; i++) {
      for (const p of sendParams(s.kind)) out.push(`${sendBase(s.kind, i, dest)}/${p}`);
    }
  }
  return out;
}

export interface SendRow {
  kind: SendSourceKind;
  index: number;
  on: boolean | null;
  lvl: number | null;
  mode: string | null;
}

const SEND_PATH = /^\/(ch|aux|bus|main)\/(\d+)\/send\/(\d+|MX\d+)\/(on|lvl|mode|pre)$/;

/** Separa um caminho de envio; null se não for um. */
export function parseSendPath(
  path: string,
): { kind: SendSourceKind; index: number; destKey: string; param: SendParam } | null {
  const m = SEND_PATH.exec(path);
  if (!m) return null;
  return { kind: m[1] as SendSourceKind, index: Number(m[2]), destKey: m[3]!, param: m[4] as SendParam };
}

/** Aplica um valor lido da mesa a uma linha de envio. */
export function applySendValue(row: SendRow, param: SendParam, value: WingValue | null): void {
  if (!value) return;
  if (param === "on" && value.kind !== "string") row.on = value.value === 1;
  if (param === "lvl" && value.kind === "float") row.lvl = value.value;
  if (param === "mode") row.mode = value.text;
  // pre: 1 = PRE, 0 = POST (mostrado igual ao mode dos canais).
  if (param === "pre" && value.kind !== "string") row.mode = value.value === 1 ? "PRE" : "POST";
}

export interface SendSource {
  kind: SendSourceKind;
  index: number;
}

/** "ch/5" -> {ch, 5}, só se essa fonte manda para o tipo de destino (bus não manda para bus). */
export function parseSendSource(text: string, dest: SendDest): SendSource | null {
  const m = /^(ch|aux|bus|main)\/(\d+)$/.exec(text);
  if (!m) return null;
  const src = SEND_SOURCES[dest.kind].find((s) => s.kind === m[1]);
  const index = Number(m[2]);
  return src && index >= 1 && index <= src.count ? { kind: src.kind, index } : null;
}

/** Caminho de um parâmetro de envio, ou null se a fonte não usa esse parâmetro (mode x pre). */
export function sendParamPath(src: SendSource, dest: SendDest, param: string): string | null {
  if (!(sendParams(src.kind) as string[]).includes(param)) return null;
  return `${sendBase(src.kind, src.index, dest)}/${param}`;
}

/**
 * Escreve UM parâmetro de envio (nível, on/off, mode ou pre), ou só valida com dryRun.
 * Tipo, faixa e opções vêm da descrição atual do nó na mesa; depois lê de volta.
 */
export async function writeSend(
  wing: WingClient,
  srcText: unknown,
  destText: unknown,
  param: unknown,
  value: unknown,
  dryRun = false,
): Promise<ParamWriteResult> {
  const dest = typeof destText === "string" ? parseDest(destText) : null;
  if (!dest) throw new Error(`Destino inválido: ${String(destText)} (use bus/1..16 ou mtx/1..8)`);
  const src = typeof srcText === "string" ? parseSendSource(srcText, dest) : null;
  if (!src) {
    const allowed = SEND_SOURCES[dest.kind].map((s) => `${s.kind}/1..${s.count}`).join(", ");
    throw new Error(`Fonte inválida para ${destText}: ${String(srcText)} (aceitas: ${allowed})`);
  }
  const path = typeof param === "string" ? sendParamPath(src, dest, param) : null;
  if (!path) throw new Error(`Parâmetro inválido para ${srcText}: ${String(param)} (aceitos: ${sendParams(src.kind).join(", ")})`);
  return writeParam(wing, path, value, dryRun);
}

/** Monta as linhas do destino a partir das leituras. */
export function buildSendRows(dest: SendDest, values: Map<string, WingValue | null>): SendRow[] {
  const rows: SendRow[] = [];
  for (const s of SEND_SOURCES[dest.kind]) {
    for (let i = 1; i <= s.count; i++) {
      const row: SendRow = { kind: s.kind, index: i, on: null, lvl: null, mode: null };
      for (const p of sendParams(s.kind)) applySendValue(row, p, values.get(`${sendBase(s.kind, i, dest)}/${p}`) ?? null);
      rows.push(row);
    }
  }
  return rows;
}
