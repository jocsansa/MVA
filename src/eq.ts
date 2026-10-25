// EQ e filtro dos canais, em cima da base genérica (descrição de nó + setParam).
// Estrutura conferida na WING real (fw 3.1), EQ modelo STD (fixtures ch_1_eq e ch_1_flt):
//   /ch/N/eq:  on, mdl, mix, lg/lf/lq/leq (PEQ|SHV), 1g..4q, hg/hf/hq/heq (PEQ|SHV)
//   /ch/N/flt: lc, lcf (20..2k Hz), lcs (6|12|18|24), hc, hcf (50..20k Hz), hcs (6|12), tf, mdl, tilt
// Toda escrita passa por WingClient.setParam: confere a descrição atual do nó, escreve uma
// vez e lê de volta. Com dryRun só valida e devolve o comando exato (nada é escrito).

import { parseWingNumber, riskWarning, type NodeChild, type ParamDesc, type ParamType } from "./schema.ts";
import { isValidChannel, writeParam, type ParamWriteResult, type WingClient } from "./wing.ts";

export type EqSection = "eq" | "flt";

/** As 6 bandas do PEQ: low (shelf ou PEQ), 1..4 (PEQ) e high (shelf ou PEQ). */
export const EQ_BANDS = [
  { id: "l", label: "LOW", shape: "leq" },
  { id: "1", label: "1", shape: null },
  { id: "2", label: "2", shape: null },
  { id: "3", label: "3", shape: null },
  { id: "4", label: "4", shape: null },
  { id: "h", label: "HIGH", shape: "heq" },
] as const;

/** Parâmetros que as rotas de EQ aceitam escrever (o resto do nó fica de fora). */
export const SECTION_PARAMS: Record<EqSection, readonly string[]> = {
  eq: ["on", ...EQ_BANDS.flatMap((b) => [`${b.id}g`, `${b.id}f`, `${b.id}q`]), "leq", "heq"],
  flt: ["lc", "lcf", "lcs", "hc", "hcf", "hcs"],
};

/** Modelo de EQ que o painel edita; os outros têm outros parâmetros. */
export const EDITABLE_EQ_MODEL = "STD";

export function isEqSection(s: string): s is EqSection {
  return s === "eq" || s === "flt";
}

/** Caminho OSC de um parâmetro de EQ/filtro do canal, ou null se não for aceito. */
export function eqParamPath(ch: number, section: EqSection, param: string): string | null {
  if (!isValidChannel(ch) || !SECTION_PARAMS[section].includes(param)) return null;
  return `/ch/${ch}/${section}/${param}`;
}

export interface EqParam {
  name: string;
  path: string;
  type: ParamType;
  /** Número para int/lin/log, texto para list. */
  value: number | string | null;
  readOnly: boolean;
  min?: number;
  max?: number;
  unit?: string;
  steps?: number;
  options?: string[];
  risk: string | null;
}

/** Valor do texto da descrição: "1k08" -> 1080, "SHV" -> "SHV". */
export function descValue(desc: ParamDesc): number | string | null {
  if (desc.valueText === null || desc.valueText === "") return null;
  if (desc.type === "list" || desc.type === "string") return desc.valueText;
  try {
    return parseWingNumber(desc.valueText);
  } catch {
    return null;
  }
}

/** Parâmetros aceitos da seção, com faixa e valor atual tirados da descrição. */
export function sectionState(ch: number, section: EqSection, children: NodeChild[]): Record<string, EqParam> {
  const out: Record<string, EqParam> = {};
  for (const c of children) {
    if (c.kind !== "param" || !SECTION_PARAMS[section].includes(c.name)) continue;
    const path = `/ch/${ch}/${section}/${c.name}`;
    const { kind: _kind, valueText: _text, ...range } = c;
    out[c.name] = { ...range, path, value: descValue(c), risk: c.readOnly ? null : riskWarning(path) };
  }
  return out;
}

export interface ChannelEq {
  ch: number;
  /** Modelo do EQ (/ch/N/eq/mdl); o painel só edita o STD. */
  model: string | null;
  editable: boolean;
  eq: Record<string, EqParam>;
  flt: Record<string, EqParam>;
}

/** Lê EQ e filtro do canal com duas consultas de descrição (só leitura). */
export async function readChannelEq(wing: WingClient, ch: number): Promise<ChannelEq> {
  if (!isValidChannel(ch)) throw new EqRequestError(`Canal inválido: ${ch}`);
  const eqNode = await wing.describeNode(`/ch/${ch}/eq`);
  const fltNode = await wing.describeNode(`/ch/${ch}/flt`);
  const mdl = eqNode.find((c) => c.name === "mdl");
  const model = mdl?.kind === "param" ? mdl.valueText : null;
  return {
    ch,
    model,
    editable: model === EDITABLE_EQ_MODEL,
    eq: sectionState(ch, "eq", eqNode),
    flt: sectionState(ch, "flt", fltNode),
  };
}

/** Erro do pedido (canal, seção ou parâmetro fora do que a rota aceita). */
export class EqRequestError extends Error {}

/**
 * Escreve UM parâmetro de EQ/filtro do canal (ou só valida, com dryRun).
 * A validação de tipo/faixa/opções é a da descrição atual do nó na mesa.
 */
export async function writeChannelEq(
  wing: WingClient,
  ch: number,
  section: string,
  param: unknown,
  value: unknown,
  dryRun = false,
): Promise<ParamWriteResult> {
  if (!isEqSection(section)) throw new EqRequestError(`Seção inválida: ${section} (use eq ou flt)`);
  const path = typeof param === "string" ? eqParamPath(ch, section, param) : null;
  if (!path) {
    if (!isValidChannel(ch)) throw new EqRequestError(`Canal inválido: ${ch}`);
    throw new EqRequestError(`Parâmetro inválido em ${section}: ${String(param)} (aceitos: ${SECTION_PARAMS[section].join(", ")})`);
  }
  return writeParam(wing, path, value, dryRun);
}
