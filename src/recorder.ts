// Gravação das sessões (captura das mixagens). Mesmo desenho da caixa-preta do automix:
// um arquivo JSONL por culto, uma linha JSON por evento, medidores a 1 Hz (pico de cada segundo).
// Só leitura: o gravador escuta o que a mesa já manda (assinatura /*s, GETs e medidores) e,
// ao iniciar, lê EQ, filtro, gate e compressor dos canais pela descrição dos nós. Nunca escreve.
//
// Eventos (t = epoch em ms):
//   session      início: data, operador, momento, mesa
//   snapshot     estado dos strips no início (nome, fader, mute, solo, pan, ganho)
//   proc         EQ, filtro, gate e compressor de um canal no início (valores em texto, como a mesa mostra)
//   change       parâmetro mudou: cat (fader|mute|solo|pan|gain|eq|dyn|name), path, v, prev
//   moment       operador marcou o momento do culto
//   meters       pico de cada strip no segundo (dBFS, max de L/R), por tipo
//   conn         mesa conectada ou desconectada
//   alert        alerta ao vivo: action (raised|cleared|dismissed|active), key, level, title
//   session-end  fim: duração e motivo

import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { WingValue } from "./osc.ts";
import { parseWingNumber, type NodeChild } from "./schema.ts";
import type { StripKind, Strips } from "./strips.ts";

export const MOMENTS = [
  { id: "pre", label: "Pré-culto" },
  { id: "louvor", label: "Louvor" },
  { id: "ministracao", label: "Ministração" },
  { id: "pregacao", label: "Pregação" },
  { id: "ofertorio", label: "Ofertório" },
  { id: "avisos", label: "Avisos" },
  { id: "final", label: "Final" },
] as const;
export type MomentId = (typeof MOMENTS)[number]["id"];

export function isMoment(m: unknown): m is MomentId {
  return MOMENTS.some((x) => x.id === m);
}

export const OPERATOR_MAX_LENGTH = 40;
export const METER_INTERVAL_MS = 1000;
/** Strips com medidor gravados a cada segundo. */
export const METER_KINDS: readonly StripKind[] = ["ch", "aux", "bus", "main", "mtx", "dca"];
/** Seções lidas de cada canal no início da sessão. */
export const PROC_SECTIONS = ["eq", "flt", "gate", "dyn"] as const;

export type ChangeCat = "fader" | "mute" | "solo" | "pan" | "gain" | "eq" | "dyn" | "name";

const TRACKED: [RegExp, ChangeCat][] = [
  [/^\/(ch|aux|bus|main|mtx|dca)\/\d+\/fdr$/, "fader"],
  [/^\/(ch|aux|bus|main|mtx|dca|mgrp)\/\d+\/mute$/, "mute"],
  [/^\/(ch|aux|bus|main|mtx|dca)\/\d+\/\$solo$/, "solo"],
  [/^\/(ch|aux|bus|main|mtx)\/\d+\/pan$/, "pan"],
  // Espelho do ganho no canal e o ganho na fonte (é onde a mesa guarda o valor).
  [/^\/ch\/\d+\/in\/set\/\$g$/, "gain"],
  [/^\/io\/in\/[A-Z]+\/\d+\/g$/, "gain"],
  [/^\/(ch|aux|bus|main|mtx)\/\d+\/(eq|flt)\/\w+$/, "eq"],
  [/^\/(ch|aux|bus|main|mtx)\/\d+\/(gate|dyn)\/\w+$/, "dyn"],
  [/^\/(ch|aux|bus|main|mtx|dca|mgrp)\/\d+\/name$/, "name"],
];

/** Categoria gravada para um caminho da mesa, ou null se o caminho não é gravado. */
export function classifyPath(path: string): ChangeCat | null {
  for (const [re, cat] of TRACKED) if (re.test(path)) return cat;
  return null;
}

type Value = number | string;

const round = (n: number, step: number) => Math.round(n / step) * step;
const r2 = (n: number) => Number(round(n, 0.01).toFixed(2));
const r1 = (n: number) => Number(round(n, 0.1).toFixed(1));

function normValue(v: WingValue): Value {
  return v.kind === "string" ? v.text : r2(v.value);
}

/** Valor em texto da descrição (",s #") no mesmo formato de normValue, ou undefined. */
function descValue(c: NodeChild): Value | undefined {
  if (c.kind !== "param" || c.valueText === null) return undefined;
  if (c.type === "list" || c.type === "string") return c.valueText;
  try {
    const n = parseWingNumber(c.valueText);
    return Number.isFinite(n) ? r2(n) : undefined;
  } catch {
    return undefined;
  }
}

const FILE_RE = /^culto-(\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d)(?:-(\d+))?\.jsonl$/;

export function isSessionId(id: string): boolean {
  return FILE_RE.test(`${id}.jsonl`);
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export class SessionError extends Error {
  readonly code: number;
  constructor(message: string, code = 400) {
    super(message);
    this.code = code;
  }
}

export interface ActiveSession {
  id: string;
  operator: string;
  moment: MomentId;
  startedAt: number;
}

export interface SessionSummary {
  id: string;
  /** Início em ISO 8601. */
  date: string | null;
  operator: string | null;
  durationMs: number | null;
  /** false: sem linha de fim (servidor caiu) ou gravação em andamento. */
  ended: boolean;
  active: boolean;
  bytes: number;
}

export interface RecorderOptions {
  dir: string;
  /** Quantos arquivos guardar; os mais antigos são apagados ao iniciar uma sessão. */
  keep?: number;
  /** Tamanho máximo somado dos arquivos guardados. */
  maxBytes?: number;
  /** Uma sessão esquecida aberta é encerrada sozinha depois disso. */
  maxSessionMs?: number;
  now?: () => number;
  /** Relógio de 1 Hz automático (os testes chamam tick() direto). */
  autoTick?: boolean;
  strips: () => Strips;
  console: () => { host: string; info: string | null; connected: boolean };
  /** Leitura da descrição de um nó com valores (só leitura). Sem ela, não grava "proc". */
  describe?: (path: string) => Promise<NodeChild[]>;
  channels?: number;
  /** Pausa entre leituras de descrição, para não encher a mesa de pedidos. */
  describeGapMs?: number;
  onChange?: (active: ActiveSession | null) => void;
}

interface Active extends ActiveSession {
  fd: number;
  file: string;
  /** Pico do segundo corrente por tipo; null = sem medidor. */
  peak: Record<string, (number | null)[]> | null;
  peakStart: number;
  connected: boolean;
  counts: Record<string, number>;
}

export class SessionRecorder {
  readonly dir: string;
  private readonly keep: number;
  private readonly maxBytes: number;
  private readonly maxSessionMs: number;
  private readonly now: () => number;
  private readonly opts: RecorderOptions;
  /** Último valor conhecido de cada caminho gravado (atualizado sempre, gravando ou não). */
  private readonly known = new Map<string, Value>();
  private active: Active | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: RecorderOptions) {
    this.opts = opts;
    this.dir = opts.dir;
    this.keep = opts.keep ?? 60;
    this.maxBytes = opts.maxBytes ?? 500 * 1024 * 1024;
    this.maxSessionMs = opts.maxSessionMs ?? 6 * 3600 * 1000;
    this.now = opts.now ?? Date.now;
  }

  get current(): ActiveSession | null {
    if (!this.active) return null;
    const { id, operator, moment, startedAt } = this.active;
    return { id, operator, moment, startedAt };
  }

  private write(entry: { type: string; t?: number; [k: string]: unknown }): void {
    const a = this.active;
    if (!a) return;
    writeSync(a.fd, JSON.stringify({ ...entry, t: entry.t ?? this.now() }) + "\n");
    a.counts[entry.type] = (a.counts[entry.type] ?? 0) + 1;
  }

  start(operatorIn: unknown, momentIn: unknown): ActiveSession {
    if (this.active) throw new SessionError("Já existe uma gravação em andamento", 409);
    const operator = typeof operatorIn === "string" ? operatorIn.trim().replace(/\s+/g, " ") : "";
    if (!operator) throw new SessionError("Informe o nome de quem está na mesa");
    if (operator.length > OPERATOR_MAX_LENGTH) throw new SessionError(`Nome com no máximo ${OPERATOR_MAX_LENGTH} caracteres`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(operator)) throw new SessionError("Nome com caracteres inválidos");
    const moment = momentIn ?? "pre";
    if (!isMoment(moment)) throw new SessionError(`Momento inválido: ${String(moment)}`);

    mkdirSync(this.dir, { recursive: true });
    const t = this.now();
    const base = `culto-${stamp(new Date(t))}`;
    let id = base;
    let fd = -1;
    for (let n = 2; fd < 0; n++) {
      try {
        fd = openSync(join(this.dir, `${id}.jsonl`), "wx");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST" || n > 99) throw e;
        id = `${base}-${n}`;
      }
    }
    const con = this.opts.console();
    this.active = {
      id, operator, moment, startedAt: t, fd, file: join(this.dir, `${id}.jsonl`),
      peak: null, peakStart: t, connected: con.connected, counts: {},
    };
    this.write({ type: "session", t, date: new Date(t).toISOString(), operator, moment, host: con.host, console: con.info, connected: con.connected });
    this.write({ type: "snapshot", t, strips: this.stripSnapshot() });
    try {
      this.rotate();
    } catch (e) {
      this.write({ type: "rotate-error", error: (e as Error).message });
    }
    if (this.opts.autoTick !== false) this.timer = setInterval(() => this.tick(), METER_INTERVAL_MS);
    void this.captureProc(id);
    this.opts.onChange?.(this.current);
    return this.current!;
  }

  setMoment(momentIn: unknown): ActiveSession {
    const a = this.active;
    if (!a) throw new SessionError("Nenhuma gravação em andamento", 409);
    if (!isMoment(momentIn)) throw new SessionError(`Momento inválido: ${String(momentIn)}`);
    if (momentIn !== a.moment) {
      this.write({ type: "moment", moment: momentIn, prev: a.moment });
      a.moment = momentIn;
      this.opts.onChange?.(this.current);
    }
    return this.current!;
  }

  stop(reason = "operador"): SessionSummary {
    const a = this.active;
    if (!a) throw new SessionError("Nenhuma gravação em andamento", 409);
    this.flushMeters();
    const t = this.now();
    this.write({ type: "session-end", t, durationMs: t - a.startedAt, reason, counts: { ...a.counts } });
    closeSync(a.fd);
    this.active = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.opts.onChange?.(null);
    return this.summary(`${a.id}.jsonl`)!;
  }

  /** Valor vindo da mesa (GET ou evento da assinatura). Grava só quando muda. */
  onOsc(path: string, value: WingValue): void {
    if (value.kind === "string" && value.text.includes("\n")) return; // descrição de nó
    const cat = classifyPath(path);
    if (!cat) return;
    const v = normValue(value);
    const prev = this.known.get(path);
    this.known.set(path, v);
    if (prev === v) return;
    this.write(prev === undefined ? { type: "change", cat, path, v } : { type: "change", cat, path, v, prev });
  }

  /** Quadro de medidores (chega a ~20 Hz): guarda o pico do segundo. */
  onMeters(strips: Strips): void {
    const a = this.active;
    if (!a) return;
    if (!a.peak) {
      a.peak = {};
      a.peakStart = this.now();
    }
    for (const kind of METER_KINDS) {
      const row = (a.peak[kind] ??= strips[kind].map(() => null));
      strips[kind].forEach((st, i) => {
        if (!st.meter) return;
        const lvl = Math.max(st.meter.l, st.meter.r);
        const old = row[i];
        row[i] = old === null || old === undefined ? lvl : Math.max(old, lvl);
      });
    }
  }

  private flushMeters(): void {
    const a = this.active;
    if (!a?.peak) return;
    const out: Record<string, (number | null)[]> = {};
    for (const [kind, row] of Object.entries(a.peak)) out[kind] = row.map((v) => (v === null ? null : r1(v)));
    this.write({ type: "meters", t: a.peakStart, ...out });
    a.peak = null;
  }

  /** Relógio de 1 Hz: grava os picos do segundo, mudanças de conexão e o limite de duração. */
  tick(): void {
    const a = this.active;
    if (!a) return;
    this.flushMeters();
    const { connected } = this.opts.console();
    if (connected !== a.connected) {
      a.connected = connected;
      this.write({ type: "conn", connected });
    }
    if (this.now() - a.startedAt >= this.maxSessionMs) this.stop("limite de duração");
  }

  private stripSnapshot() {
    const strips = this.opts.strips();
    const out: Record<string, unknown[]> = {};
    for (const [kind, list] of Object.entries(strips)) {
      out[kind] = list.map((s) => {
        const o: Record<string, unknown> = { n: s.index };
        if (s.name) o.name = s.name;
        if (s.faderDb !== null) o.fdr = r2(s.faderDb);
        if (s.mute !== null) o.mute = s.mute;
        if (s.solo !== null) o.solo = s.solo;
        if (s.pan !== null) o.pan = r2(s.pan);
        if (s.gainDb !== null) o.gain = r2(s.gainDb);
        return o;
      });
    }
    return out;
  }

  /** Estado inicial do processamento dos canais, lido pela descrição dos nós (só leitura). */
  private async captureProc(id: string): Promise<void> {
    const describe = this.opts.describe;
    if (!describe) return;
    const gap = this.opts.describeGapMs ?? 10;
    let failures = 0;
    for (let ch = 1; ch <= (this.opts.channels ?? 40); ch++) {
      const entry: Record<string, unknown> = { type: "proc", ch };
      for (const sec of PROC_SECTIONS) {
        if (this.active?.id !== id) return;
        try {
          const children = await describe(`/ch/${ch}/${sec}`);
          const vals: Record<string, string> = {};
          for (const c of children) {
            if (c.kind !== "param" || c.valueText === null) continue;
            vals[c.name] = c.valueText;
            const v = descValue(c);
            const path = `/ch/${ch}/${sec}/${c.name}`;
            if (v !== undefined && !this.known.has(path)) this.known.set(path, v);
          }
          entry[sec] = vals;
          failures = 0;
        } catch (e) {
          entry[sec] = null;
          entry.error = (e as Error).message;
          failures++;
        }
        if (gap) await new Promise((r) => setTimeout(r, gap));
      }
      if (this.active?.id !== id) return;
      this.write(entry as { type: string });
      if (failures >= 3) {
        this.write({ type: "proc-stop", reason: "mesa sem resposta às descrições" });
        return;
      }
    }
  }

  private files(): { name: string; bytes: number; mtime: number }[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => FILE_RE.test(n))
      .map((name) => {
        const st = statSync(join(this.dir, name));
        return { name, bytes: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Rotação simples: guarda no máximo `keep` arquivos e `maxBytes` somados; apaga os mais antigos. */
  rotate(): string[] {
    const files = this.files();
    const activeName = this.active ? `${this.active.id}.jsonl` : null;
    let count = files.length;
    let total = files.reduce((s, f) => s + f.bytes, 0);
    const removed: string[] = [];
    for (const f of files) {
      if (count <= this.keep && total <= this.maxBytes) break;
      if (f.name === activeName) continue;
      unlinkSync(join(this.dir, f.name));
      removed.push(f.name.replace(/\.jsonl$/, ""));
      count--;
      total -= f.bytes;
    }
    return removed;
  }

  private summary(name: string): SessionSummary | null {
    const path = join(this.dir, name);
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return null;
    }
    try {
      const bytes = statSync(path).size;
      const headBuf = Buffer.alloc(Math.min(bytes, 4096));
      readSync(fd, headBuf, 0, headBuf.length, 0);
      const tailLen = Math.min(bytes, 8192);
      const tailBuf = Buffer.alloc(tailLen);
      readSync(fd, tailBuf, 0, tailLen, bytes - tailLen);
      const first = parseLine(headBuf.toString("utf8").split("\n")[0]);
      const tailLines = tailBuf.toString("utf8").split("\n").filter(Boolean);
      // A última linha pode estar pela metade (servidor caiu no meio da escrita).
      let last: Record<string, unknown> | null = null;
      for (let i = tailLines.length - 1; i >= 0 && !last; i--) last = parseLine(tailLines[i]);
      const id = name.replace(/\.jsonl$/, "");
      const active = this.active?.id === id;
      const startT = typeof first?.t === "number" ? first.t : null;
      const ended = last?.type === "session-end";
      let durationMs: number | null = null;
      if (ended && typeof last!.durationMs === "number") durationMs = last!.durationMs;
      else if (active && startT !== null) durationMs = this.now() - startT;
      else if (startT !== null && typeof last?.t === "number") durationMs = Math.max(0, last.t - startT);
      return {
        id,
        date: typeof first?.date === "string" ? first.date : null,
        operator: typeof first?.operator === "string" ? first.operator : null,
        durationMs,
        ended,
        active,
        bytes,
      };
    } finally {
      closeSync(fd);
    }
  }

  /** Sessões gravadas, da mais nova para a mais antiga. */
  list(): SessionSummary[] {
    return this.files()
      .reverse()
      .map((f) => this.summary(f.name))
      .filter((s): s is SessionSummary => s !== null);
  }

  /** Conteúdo bruto (JSONL) de uma sessão. */
  read(id: string): string {
    if (!isSessionId(id)) throw new SessionError("Sessão inválida");
    try {
      return readFileSync(join(this.dir, `${id}.jsonl`), "utf8");
    } catch {
      throw new SessionError("Sessão não encontrada", 404);
    }
  }

  /** Evento de outra parte do app (ex.: alertas). Só grava se houver sessão em andamento. */
  note(entry: { type: string; [k: string]: unknown }): void {
    this.write(entry);
  }

  close(reason = "servidor encerrado"): void {
    if (this.active) this.stop(reason);
  }
}

function parseLine(line: string | undefined): Record<string, unknown> | null {
  if (!line) return null;
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}
