// Dinâmica dos canais: gate (/ch/N/gate) e compressor (/ch/N/dyn), em cima da base genérica.
// Os parâmetros NÃO são fixos aqui: cada modelo de gate/compressor da WING tem os seus, então
// o painel mostra o que a descrição do nó na mesa trouxer (tipo, faixa, opções, somente leitura).
// Toda escrita passa por writeParam: confere a descrição atual do nó, escreve uma vez e lê de
// volta. Com dryRun só valida e devolve o comando exato (nada é escrito).
// A lista de parâmetros da WING real ainda não foi capturada em fixture; o simulador usa uma
// versão plausível (thr, range, att, hld, rel, ratio, knee, gain, mix...).

import { paramState, type NodeChild, type ParamState } from "./schema.ts";
import { isValidChannel, writeParam, type ParamWriteResult, type WingClient } from "./wing.ts";

export type DynSection = "gate" | "dyn";
export const DYN_SECTIONS: readonly DynSection[] = ["gate", "dyn"];

export function isDynSection(s: string): s is DynSection {
  return s === "gate" || s === "dyn";
}

/** Só um nome simples logo abaixo do nó (sem subnós nem curingas); a descrição decide o resto. */
const PARAM_NAME = /^\$?[A-Za-z0-9_]+$/;

export function dynParamPath(ch: number, section: DynSection, param: string): string | null {
  if (!isValidChannel(ch) || !PARAM_NAME.test(param)) return null;
  return `/ch/${ch}/${section}/${param}`;
}

export interface DynSectionState {
  path: string;
  /** Modelo (mdl) e liga/desliga (on), se o nó tiver. */
  model: string | null;
  on: number | null;
  /** Todos os parâmetros do nó, na ordem da mesa (somente leitura marcados). */
  params: ParamState[];
}

export interface ChannelDyn {
  ch: number;
  gate: DynSectionState;
  dyn: DynSectionState;
}

export function dynSectionState(ch: number, section: DynSection, children: NodeChild[]): DynSectionState {
  const path = `/ch/${ch}/${section}`;
  const params = children.flatMap((c) => (c.kind === "param" ? [paramState(`${path}/${c.name}`, c)] : []));
  const mdl = params.find((p) => p.name === "mdl");
  const on = params.find((p) => p.name === "on");
  return {
    path,
    model: typeof mdl?.value === "string" ? mdl.value : null,
    on: typeof on?.value === "number" ? on.value : null,
    params,
  };
}

/** Lê gate e compressor do canal com duas consultas de descrição (só leitura). */
export async function readChannelDyn(wing: WingClient, ch: number): Promise<ChannelDyn> {
  if (!isValidChannel(ch)) throw new DynRequestError(`Canal inválido: ${ch}`);
  const gate = await wing.describeNode(`/ch/${ch}/gate`);
  const dyn = await wing.describeNode(`/ch/${ch}/dyn`);
  return { ch, gate: dynSectionState(ch, "gate", gate), dyn: dynSectionState(ch, "dyn", dyn) };
}

/** Erro do pedido (canal, seção ou nome de parâmetro fora do que a rota aceita). */
export class DynRequestError extends Error {}

/**
 * Escreve UM parâmetro do gate ou do compressor (ou só valida, com dryRun).
 * Tipo, faixa, opções e somente leitura vêm da descrição atual do nó na mesa.
 */
export async function writeChannelDyn(
  wing: WingClient,
  ch: number,
  section: string,
  param: unknown,
  value: unknown,
  dryRun = false,
): Promise<ParamWriteResult> {
  if (!isDynSection(section)) throw new DynRequestError(`Seção inválida: ${section} (use gate ou dyn)`);
  if (!isValidChannel(ch)) throw new DynRequestError(`Canal inválido: ${ch}`);
  const path = typeof param === "string" ? dynParamPath(ch, section, param) : null;
  if (!path) throw new DynRequestError(`Parâmetro inválido em ${section}: ${String(param)}`);
  return writeParam(wing, path, value, dryRun);
}
