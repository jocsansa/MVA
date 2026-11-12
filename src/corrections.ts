// Executor das correções do assistente (src/assistant.ts) na mesa.
// - plan*: só LEITURAS (fonte do canal, ganho, trims, descrição dos nós) e devolve as escritas exatas.
// - applySuggestion / undoWrites: escrevem pelo WingClient (que só escreve com WING_ALLOW_WRITES=1),
//   uma escrita por vez, validada na descrição da mesa e lida de volta. Primeiro o que ABAIXA o
//   nível, depois o que sobe, para nunca haver um pico no meio da correção. Se uma escrita falhar
//   no meio, as anteriores são desfeitas.
// Ganho: a correção muda o headamp da fonte e compensa no trim de TODOS os canais que usam a mesma
// fonte, então o nível depois do trim (PA, retornos, envios) fica igual.

import { CHANNEL_COUNT, describeMessage, gainAddress, type WingClient } from "./wing.ts";
import { splitPath, type ParamDesc } from "./schema.ts";
import type { WingValue } from "./osc.ts";
import type { PlannedWrite, Suggestion } from "./assistant.ts";

export class CorrectionUnavailable extends Error {}

const r1 = (n: number) => Math.round(n * 10) / 10;

function num(v: WingValue | null | undefined, what: string): number {
  if (!v || v.kind === "string") throw new Error(`Sem leitura de ${what}`);
  return v.value;
}

/** Passo da faixa da mesa: (máx − mín) / (passos − 1); sem passos, 0,1 dB. */
export function stepOf(desc: Pick<ParamDesc, "min" | "max" | "steps">): number {
  if (desc.min === undefined || desc.max === undefined || !desc.steps || desc.steps < 2) return 0.1;
  return (desc.max - desc.min) / (desc.steps - 1);
}

/**
 * Ganho novo na grade da mesa, sempre na direção pedida (ou o atual, se não der). Baixando,
 * arredonda para baixo (garante a margem pedida); subindo, também para baixo (nunca sobe mais que
 * o pedido). Fica dentro da faixa. O atual pode estar fora da grade.
 */
export function snapGain(current: number, delta: number, desc: Pick<ParamDesc, "min" | "max" | "steps">): number {
  const min = desc.min ?? -Infinity;
  const max = desc.max ?? Infinity;
  const step = stepOf(desc);
  const target = current + delta;
  const base = Number.isFinite(min) ? min : 0;
  const snapped = r1(Math.min(max, Math.max(min, base + Math.floor((target - base) / step + 1e-6) * step)));
  if (delta < 0 ? snapped >= current : snapped <= current) return current;
  return snapped;
}

/** Fonte de cada canal: entradas que ele usa ("LCL/3"; estéreo usa a seguinte também). */
export interface ChannelSource {
  inputs: string[];
  stereo: boolean;
}

const sourceCache = new WeakMap<WingClient, { at: number; map: Promise<Map<number, ChannelSource>> }>();

/**
 * Fonte efetiva de cada canal (entrada alternativa se altsrc = 1), lida de uma vez (só GETs).
 * Qualquer leitura perdida (UDP) recusa o mapa inteiro: sem ele completo, a compensação poderia
 * esquecer um canal. maxAgeMs > 0 reaproveita uma leitura recente (só para mostrar a sugestão).
 */
export function readSourceMap(wing: WingClient, maxAgeMs = 0): Promise<Map<number, ChannelSource>> {
  const cached = sourceCache.get(wing);
  if (maxAgeMs > 0 && cached && Date.now() - cached.at < maxAgeMs) return cached.map;
  const map = readSourceMapNow(wing);
  sourceCache.set(wing, { at: Date.now(), map });
  map.catch(() => sourceCache.delete(wing));
  return map;
}

async function readSourceMapNow(wing: WingClient): Promise<Map<number, ChannelSource>> {
  const paths: string[] = [];
  for (let ch = 1; ch <= CHANNEL_COUNT; ch++) {
    const b = `/ch/${ch}/in`;
    paths.push(`${b}/set/altsrc`, `${b}/set/$mode`, `${b}/conn/grp`, `${b}/conn/in`, `${b}/conn/altgrp`, `${b}/conn/altin`);
  }
  const v = await wing.readMany(paths);
  const missing = paths.filter((p) => !v.get(p));
  if (missing.length) throw new Error(`Leitura do patch incompleta (${missing.length} sem resposta, ex.: ${missing[0]}); nada foi enviado`);
  const out = new Map<number, ChannelSource>();
  for (let ch = 1; ch <= CHANNEL_COUNT; ch++) {
    const b = `/ch/${ch}/in`;
    const alt = v.get(`${b}/set/altsrc`)!;
    const isAlt = alt.kind !== "string" && alt.value === 1;
    const grp = v.get(`${b}/conn/${isAlt ? "altgrp" : "grp"}`)!.text;
    // Número da entrada: o TEXTO (1-based) da resposta ',sfi' (veja parseConnIndex em wing.ts).
    const idx = Number(v.get(`${b}/conn/${isAlt ? "altin" : "in"}`)!.text);
    const stereo = v.get(`${b}/set/$mode`)!.text !== "M";
    out.set(ch, { inputs: stereo ? [`${grp}/${idx}`, `${grp}/${idx + 1}`] : [`${grp}/${idx}`], stereo });
  }
  return out;
}

async function paramDesc(wing: WingClient, path: string): Promise<ParamDesc> {
  const { parent, name } = splitPath(path);
  const c = (await wing.describeNode(parent)).find((x) => x.name === name);
  if (!c || c.kind !== "param") throw new Error(`Parâmetro não existe na mesa: ${path}`);
  return c;
}

const fMsg = (path: string, value: number) => describeMessage({ address: path, args: [{ type: "f", value: r1(value) }] });
const iMsg = (path: string, value: number) => describeMessage({ address: path, args: [{ type: "i", value }] });

export function commandOf(w: PlannedWrite): string {
  return w.kind === "mute" ? iMsg(w.path, w.to) : fMsg(w.path, w.to);
}

/** A escrita abaixa o nível do som? (ganho/trim descendo, ou mutar) */
const lowers = (w: PlannedWrite) => (w.kind === "mute" ? w.to === 1 : w.to < w.from);

/** Ordem segura: primeiro o que abaixa, depois o que sobe. */
export function safeOrder(writes: PlannedWrite[]): PlannedWrite[] {
  return [...writes.filter(lowers), ...writes.filter((w) => !lowers(w))];
}

/** Plano de uma correção de ganho neutra no volume (só leituras). */
export async function planGain(wing: WingClient, ch: number, delta: number, opts: { sourceMaxAgeMs?: number } = {}): Promise<PlannedWrite[]> {
  // Canal estéreo (ST ou M/S) usa duas entradas: escrever o ganho só na primeira desequilibraria o par.
  // Até conferir na mesa real como a WING trata o par, o assistente não mexe.
  const chMode = (await wing.getParam(`/ch/${ch}/in/set/$mode`)).text;
  if (chMode !== "M") {
    throw new CorrectionUnavailable(`CH ${ch} é estéreo (${chMode}): ajuste o ganho do par direto na mesa.`);
  }
  const src = await wing.getChannelSource(ch);
  if (!src.gainAddress) {
    throw new CorrectionUnavailable(`CH ${ch} usa a fonte ${src.grp} ${src.in}, sem ganho ajustável pela mesa: ajuste o nível na origem.`);
  }
  const gDesc = await paramDesc(wing, src.gainAddress);
  const gainNow = num(await wing.getParam(src.gainAddress), src.gainAddress);
  const key = `${src.grp}/${src.in}`;
  const sources = await readSourceMap(wing, opts.sourceMaxAgeMs ?? 0);
  const users = [...sources].filter(([, s]) => s.inputs.includes(key));
  // A entrada também alimenta um canal estéreo: a compensação dele não seria igual nos dois lados.
  const st = users.find(([, s]) => s.stereo);
  if (st) throw new CorrectionUnavailable(`A entrada ${src.grp} ${src.in} também alimenta o CH ${st[0]} (estéreo): ajuste o ganho direto na mesa.`);
  const sharing = users.map(([c]) => c);
  if (!sharing.includes(ch)) sharing.push(ch);
  sharing.sort((a, b) => a - b);

  const tDesc = await paramDesc(wing, `/ch/${ch}/in/set/trim`);
  const tMin = tDesc.min ?? -18;
  const tMax = tDesc.max ?? 18;
  const trims = new Map<number, number>();
  for (const c of sharing) trims.set(c, num(await wing.getParam(`/ch/${c}/in/set/trim`), `/ch/${c}/in/set/trim`));

  // Diminui o passo até todos os trims caberem na faixa (a compensação tem que ser completa).
  const step = stepOf(gDesc);
  let target = snapGain(gainNow, delta, gDesc);
  const fits = (g: number) => [...trims.values()].every((t) => t - (g - gainNow) >= tMin - 1e-6 && t - (g - gainNow) <= tMax + 1e-6);
  // Ainda na direção pedida? (o ganho atual pode estar fora da grade)
  const ahead = (g: number) => (delta < 0 ? g < gainNow - 1e-6 : g > gainNow + 1e-6);
  while (ahead(target) && !fits(target)) target = r1(target + (delta < 0 ? step : -step));
  if (!ahead(target)) {
    target = gainNow;
    const why = (delta < 0 ? target <= (gDesc.min ?? -Infinity) : target >= (gDesc.max ?? Infinity))
      ? `o ganho já está no ${delta < 0 ? "mínimo" : "máximo"} (${gainNow} dB)`
      : `o trim não tem margem para compensar (faixa ${tMin} a ${tMax} dB)`;
    throw new CorrectionUnavailable(`Não dá para corrigir o CH ${ch} pela mesa: ${why}.${delta < 0 ? " Peça para baixarem a fonte." : ""}`);
  }
  const actual = r1(target - gainNow);
  const writes: PlannedWrite[] = [{
    kind: "gain", channel: ch, path: src.gainAddress, from: gainNow, to: target,
    label: `Ganho ${src.grp} ${src.in}: ${gainNow} → ${target} dB`,
  }];
  for (const c of sharing) {
    const from = trims.get(c)!;
    const to = r1(from - actual);
    writes.push({ kind: "trim", channel: c, path: `/ch/${c}/in/set/trim`, from, to, label: `Trim CH ${c}: ${from} → ${to} dB` });
  }
  return safeOrder(writes);
}

/** Plano da sugestão (só leituras). CorrectionUnavailable = não dá para corrigir pela mesa. */
export async function planSuggestion(wing: WingClient, s: Suggestion, opts: { sourceMaxAgeMs?: number } = {}): Promise<PlannedWrite[]> {
  if (s.kind === "unmute") {
    const now = num(await wing.getParam(`/ch/${s.channel}/mute`), "mute");
    if (now !== 1) throw new CorrectionUnavailable(`CH ${s.channel} já está desmutado.`);
    return [{ kind: "mute", channel: s.channel, path: `/ch/${s.channel}/mute`, from: 1, to: 0, label: `Desmutar CH ${s.channel}` }];
  }
  if (s.deltaDb === undefined) throw new Error("Sugestão sem valor de ganho");
  return planGain(wing, s.channel, s.deltaDb, opts);
}

/** Uma escrita pela mesa com leitura de volta; devolve o valor lido. */
async function writeOne(wing: WingClient, w: PlannedWrite, value: number): Promise<number> {
  if (w.kind === "mute") {
    const { readBack } = await wing.setChannelMute(w.channel, value === 1);
    if (readBack !== (value === 1)) throw new Error(`Leitura de volta não confere em ${w.path}`);
    return readBack ? 1 : 0;
  }
  if (w.kind === "gain") {
    // O patch não pode ter mudado desde o plano: a compensação foi calculada para esta fonte.
    if (gainAddress(await wing.getChannelSource(w.channel)) !== w.path) throw new Error(`A fonte do CH ${w.channel} mudou; nada foi enviado`);
    // setChannelGain confere a fonte (espelho $g), a faixa da mesa e lê de volta.
    const { readBack } = await wing.setChannelGain(w.channel, value);
    if (Math.abs(readBack - value) > 0.06) throw new Error(`Ganho lido de volta ${readBack} dB, pedido ${value} dB`);
    return readBack;
  }
  const { readBack } = await wing.setParam(w.path, r1(value));
  const back = num(readBack, w.path);
  if (Math.abs(back - value) > 0.06) throw new Error(`Trim lido de volta ${back} dB, pedido ${value} dB`);
  return back;
}

export type ExecResult = { ok: true; writes: PlannedWrite[]; commands: string[] } | { ok: false; error: string; unavailable?: boolean };

/** Executa as escritas na ordem dada; se uma falhar, desfaz as anteriores (do fim para o começo). */
export async function executeWrites(wing: WingClient, writes: PlannedWrite[]): Promise<ExecResult> {
  const done: PlannedWrite[] = [];
  for (const w of writes) {
    try {
      const back = await writeOne(wing, w, w.to);
      done.push({ ...w, to: back });
    } catch (e) {
      const rollback: string[] = [];
      for (const d of [...done].reverse()) {
        try {
          await writeOne(wing, d, d.from);
          rollback.push(`${d.path} voltou para ${d.from}`);
        } catch (re) {
          rollback.push(`FALHOU ao voltar ${d.path} para ${d.from}: ${(re as Error).message}`);
        }
      }
      const tail = rollback.length ? ` Desfeito: ${rollback.join("; ")}.` : "";
      return { ok: false, error: `${(e as Error).message}.${tail}` };
    }
  }
  return { ok: true, writes: done, commands: done.map(commandOf) };
}

/** Aplica a sugestão: refaz o plano com os valores atuais da mesa e executa. */
export async function applySuggestion(wing: WingClient, s: Suggestion): Promise<ExecResult> {
  let plan: PlannedWrite[];
  try {
    plan = await planSuggestion(wing, s);
  } catch (e) {
    return { ok: false, error: (e as Error).message, unavailable: e instanceof CorrectionUnavailable };
  }
  return executeWrites(wing, plan);
}

/**
 * Desfaz uma ação: só se a mesa ainda estiver com os valores que o assistente deixou (senão alguém
 * mexeu depois, e desfazer atropelaria o operador). Também na ordem segura.
 */
export async function undoWrites(wing: WingClient, writes: PlannedWrite[]): Promise<ExecResult> {
  for (const w of writes) {
    const now = num(await wing.getParam(w.path), w.path);
    if (Math.abs(now - w.to) > 0.06) {
      return { ok: false, error: `${w.path} mudou depois da correção (agora ${now}); desfaça pela mesa.` };
    }
  }
  const reverse = writes.map((w): PlannedWrite => ({ ...w, from: w.to, to: w.from, label: `Desfazer: ${w.label}` }));
  return executeWrites(wing, safeOrder(reverse));
}
