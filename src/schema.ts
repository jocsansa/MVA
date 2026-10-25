// Descrição de nós da WING: resposta de "<nó> ,s #" (WING Remote Protocols, "Node description
// including values"). Formato real do firmware 3.1, uma linha por filho:
//   "  fdr            -44.6               fader [-oo .. 10.0 dB], 1024 steps"
//   "  $fdr           -44.6           r/o fader [-oo .. 10.0 dB], 1024 steps"
//   "  eq             (node)"
// Com "?" vem o mesmo sem a coluna de valor.

import type { OscArg } from "./osc.ts";

export type ParamType = "int" | "lin" | "log" | "fader" | "list" | "string";

export interface ParamDesc {
  name: string;
  kind: "param";
  type: ParamType;
  readOnly: boolean;
  /** Valor atual em texto, como a mesa mostra (só com "#"). */
  valueText: string | null;
  min?: number;
  max?: number;
  unit?: string;
  steps?: number;
  options?: string[];
  maxLength?: number;
}

export interface NodeRef {
  name: string;
  kind: "node";
}

export type NodeChild = ParamDesc | NodeRef;

const TYPES = ["int", "lin", "log", "fader", "list", "string"] as const;
const TYPE_RE = new RegExp(`^(?:(r/o)\\s+)?(${TYPES.join("|")})\\s+\\[(.*)\\](?:,\\s*(\\d+)\\s+steps)?\\s*$`);

/** "10k02" -> 10020, "1k08" -> 1080, "-oo" -> -Infinity, "+5.3" -> 5.3. */
export function parseWingNumber(text: string): number {
  const t = text.trim();
  if (t === "-oo") return -Infinity;
  if (t === "+oo" || t === "oo") return Infinity;
  // Monta pelos dígitos para não perder precisão: "10k02" = 1002 * 10 = 10020.
  const k = /^([+-]?\d+)k(\d{0,3})$/.exec(t);
  if (k) return Number(k[1]! + k[2]!) * 10 ** (3 - k[2]!.length);
  const n = Number(t);
  if (Number.isNaN(n)) throw new Error(`Número inválido na descrição: "${text}"`);
  return n;
}

function parseRange(type: ParamType, inner: string): Partial<ParamDesc> {
  if (type === "list") return { options: inner.split(",").map((s) => s.trim()) };
  if (type === "string") return { maxLength: Number(inner) };
  // "-oo .. 10.0 dB" | "20.0 .. 2k00 Hz" | "0 .. 1" | "-100 .. +100"
  const m = /^(\S+)\s+\.\.\s+(\S+)(?:\s+(.+))?$/.exec(inner.trim());
  if (!m) throw new Error(`Faixa inválida: "${inner}"`);
  let min = parseWingNumber(m[1]!);
  if (type === "fader" && min === -Infinity) min = -144; // a WING usa -144 como -∞
  return { min, max: parseWingNumber(m[2]!), ...(m[3] ? { unit: m[3] } : {}) };
}

/** Interpreta uma linha. withValues = resposta de "#" (tem coluna de valor). */
export function parseDescriptionLine(line: string, withValues: boolean): NodeChild | null {
  if (!line.trim()) return null;
  // Nome: tudo até o primeiro espaço depois do recuo.
  const m = /^\s*(\S+)\s+(.*)$/.exec(line);
  if (!m) return null;
  const name = m[1]!;
  const rest = m[2]!;
  if (rest.trim() === "(node)") return { name, kind: "node" };

  // O tipo fica no fim; procura o primeiro ponto (após o valor) em que o resto casa com TYPE_RE.
  // Isso aceita valores com espaços ("VOZ 1") e valores vazios.
  for (let i = 0; i <= rest.length; i++) {
    if (i > 0 && rest[i - 1] !== " ") continue;
    const t = TYPE_RE.exec(rest.slice(i));
    if (!t) continue;
    const valueText = rest.slice(0, i).trim();
    if (!withValues && valueText) continue;
    const type = t[2] as ParamType;
    return {
      name,
      kind: "param",
      type,
      readOnly: t[1] === "r/o",
      valueText: withValues ? valueText : null,
      ...parseRange(type, t[3]!),
      ...(t[4] ? { steps: Number(t[4]) } : {}),
    };
  }
  throw new Error(`Linha de descrição não reconhecida: "${line}"`);
}

export function parseNodeDescription(text: string, withValues = true): NodeChild[] {
  const out: NodeChild[] = [];
  for (const line of text.split("\n")) {
    const child = parseDescriptionLine(line, withValues);
    if (child) out.push(child);
  }
  return out;
}

/**
 * Converte o valor pedido no argumento OSC certo para o parâmetro, ou devolve o erro.
 * int -> 'i'; lin/log/fader -> 'f'; list/string -> 's'.
 */
export function encodeParamValue(desc: ParamDesc, value: unknown): { arg: OscArg } | { error: string } {
  if (desc.readOnly) return { error: `${desc.name} é somente leitura` };
  switch (desc.type) {
    case "int": {
      if (typeof value !== "number" || !Number.isInteger(value)) return { error: `${desc.name}: use um inteiro` };
      if (value < desc.min! || value > desc.max!) return { error: `${desc.name}: deve ficar entre ${desc.min} e ${desc.max}` };
      return { arg: { type: "i", value } };
    }
    case "lin":
    case "log":
    case "fader": {
      if (typeof value !== "number" || !Number.isFinite(value)) return { error: `${desc.name}: use um número` };
      const unit = desc.unit ? ` ${desc.unit}` : "";
      if (value < desc.min! || value > desc.max!) {
        return { error: `${desc.name}: deve ficar entre ${desc.min} e ${desc.max}${unit}` };
      }
      return { arg: { type: "f", value } };
    }
    case "list": {
      if (typeof value !== "string" || !desc.options!.includes(value)) {
        return { error: `${desc.name}: opções válidas: ${desc.options!.join(", ")}` };
      }
      return { arg: { type: "s", value } };
    }
    case "string": {
      if (typeof value !== "string") return { error: `${desc.name}: use um texto` };
      if (value.length > desc.maxLength!) return { error: `${desc.name}: máximo de ${desc.maxLength} caracteres` };
      if (!/^[\x20-\x7e]*$/.test(value)) return { error: `${desc.name}: use só caracteres ASCII (sem acento)` };
      return { arg: { type: "s", value } };
    }
  }
}

/** Caminho OSC aceito pela API genérica: sem curingas e sem os prefixos especiais /% e /*. */
export function isSafePath(path: string): boolean {
  return /^\/[A-Za-z0-9$_.+-]+(\/[A-Za-z0-9$_.+-]+)*$/.test(path);
}

export function splitPath(path: string): { parent: string; name: string } {
  const i = path.lastIndexOf("/");
  return { parent: i <= 0 ? "/" : path.slice(0, i), name: path.slice(i + 1) };
}

/**
 * Parâmetros que pedem um aviso extra antes de escrever (podem causar dano ou
 * mudar muita coisa de uma vez). O app ainda pede confirmação normal para todos.
 */
export function riskWarning(path: string): string | null {
  const leaf = path.slice(path.lastIndexOf("/") + 1);
  // Identificação visual nunca é risco.
  if (["name", "col", "icon", "led", "tags"].includes(leaf)) return null;
  if (/^\$?vph$/.test(leaf)) return "Phantom 48V: confirme o microfone ligado (pode danificar microfones de fita).";
  if (/\/conn\/(grp|in|altgrp|altin)$/.test(path) || /^\/io\/out\//.test(path) || leaf === "rmt") {
    return "Patch/roteamento: pode cortar um sinal ao vivo.";
  }
  if (/^\/io\/in\//.test(path)) {
    return "Entrada física: muda todos os canais que usam essa entrada.";
  }
  if (/^\/(\$ctl|cfg|\$syscfg)(\/|$)/.test(path)) return "Configuração/controle da mesa: pode afetar a mesa inteira.";
  return null;
}
