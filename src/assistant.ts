// Assistente de estrutura de ganho. Olha os medidores e o estado dos canais e PROPÕE correções.
// Este módulo não fala com a mesa: quem aplica é src/corrections.ts, chamado pelo servidor
// conforme o modo escolhido pelo operador:
//   off      - nada é proposto (os alertas continuam);
//   suggest  - propõe e só aplica quando o operador dá OK;
//   auto     - aplica sozinho o que for permitido em automático, com limites (cooldown, teto por
//              canal, ações por minuto); o resto fica esperando OK, como no sugestivo.
// Correções de ganho são NEUTRAS no volume: o ganho da fonte muda e o trim dos canais que usam a
// fonte compensa, então PA, retornos e envios continuam no mesmo nível; só a margem até o clip muda.

import { randomUUID } from "node:crypto";
import {
  ACTIVE,
  ASSIST_LIMITS,
  SecondPeaks,
  gainProposal,
  sameDb,
  unmuteProposal,
  type AssistChannel,
  type AssistContext,
  type AssistLimits,
  type AssistMode,
  type PlannedWrite,
  type Proposal,
  type Suggestion,
  type SuggestionStatus,
} from "./assistant-rules.ts";

export * from "./assistant-rules.ts";

export interface AssistUpdate {
  /** Sugestões novas (o servidor monta o plano de leitura para mostrar os comandos). */
  created: Suggestion[];
  /** Sugestões que o servidor deve aplicar agora (modo automático). */
  toApply: Suggestion[];
  changed: boolean;
}

export interface AssistHistoryEntry {
  t: number;
  id: string;
  key: string;
  status: SuggestionStatus;
  title: string;
  by?: "auto" | "operator";
  message?: string;
}

const HISTORY_MAX = 300;
/** Ações feitas continuam na tela por esse tempo, com o botão Desfazer. */
export const RECENT_MS = 3 * 60_000;

export class Assistant {
  readonly limits: AssistLimits;
  private modeValue: AssistMode;
  private readonly peaks = new SecondPeaks();
  private readonly items = new Map<string, Suggestion>();
  private readonly muteSeen = new Map<number, number>();
  private readonly lastGain = new Map<number, number | null>();
  private readonly cooldownUntil = new Map<number, number>();
  private readonly dismissedUntil = new Map<string, number>();
  private readonly autoTotal = new Map<number, number>();
  private readonly hadDown = new Set<number>();
  private autoTimes: number[] = [];
  private hist: AssistHistoryEntry[] = [];

  constructor(opts: { mode?: AssistMode; limits?: Partial<AssistLimits> } = {}) {
    this.limits = { ...ASSIST_LIMITS, ...opts.limits };
    this.modeValue = opts.mode ?? "suggest";
  }

  get mode(): AssistMode {
    return this.modeValue;
  }

  setMode(mode: AssistMode, t = Date.now()): void {
    if (mode === this.modeValue) return;
    this.modeValue = mode;
    // Desligado: o que estava esperando OK sai da tela.
    if (mode === "off") for (const s of this.items.values()) if (s.status === "pending") this.set(s, "expired", t, "assistente desligado");
  }

  private log(s: Suggestion, t: number): void {
    this.hist.push({ t, id: s.id, key: s.key, status: s.status, title: s.title, ...(s.by ? { by: s.by } : {}), ...(s.message ? { message: s.message } : {}) });
    if (this.hist.length > HISTORY_MAX) this.hist.splice(0, this.hist.length - HISTORY_MAX);
  }

  private set(s: Suggestion, status: SuggestionStatus, t: number, message?: string): void {
    s.status = status;
    s.updatedAt = t;
    if (message !== undefined) s.message = message;
    this.log(s, t);
  }

  private pendingFor(key: string): Suggestion | undefined {
    for (const s of this.items.values()) if (s.key === key && ACTIVE.includes(s.status)) return s;
    return undefined;
  }

  /** Nível no conversor: com medidor depois do trim, desconta o trim. */
  private converter(ch: AssistChannel): number | null {
    if (ch.in === null) return null;
    return this.limits.inputMeterPostTrim && ch.trimDb !== null ? ch.in - ch.trimDb : ch.in;
  }

  update(ctx: AssistContext): AssistUpdate {
    const { t } = ctx;
    const out: AssistUpdate = { created: [], toApply: [], changed: false };
    // Pendentes velhas expiram; aplicadas antigas saem da memória (ficam no histórico).
    for (const [id, s] of this.items) {
      if (s.status === "pending" && t - s.createdAt >= this.limits.expireMs) {
        this.set(s, "expired", t);
        out.changed = true;
      }
      if (!ACTIVE.includes(s.status) && t - s.updatedAt > RECENT_MS) {
        this.items.delete(id);
        out.changed = true;
      }
    }
    if (this.modeValue === "off" || !ctx.connected) return out;

    for (const ch of ctx.channels) {
      // Ganho mudou na mesa (pelo operador ou por nós): histórico de picos recomeça e a
      // sugestão de ganho pendente perde o sentido.
      const prevGain = this.lastGain.get(ch.index);
      this.lastGain.set(ch.index, ch.gainDb);
      if (prevGain !== undefined && !sameDb(prevGain, ch.gainDb)) {
        this.peaks.reset(ch.index);
        // A janela curta de picos ainda tem quadros de antes da mudança: espera assentar.
        this.cooldownUntil.set(ch.index, Math.max(this.cooldownUntil.get(ch.index) ?? 0, t + this.limits.cooldownMs));
        const p = this.pendingFor(`gain:${ch.index}`);
        if (p?.status === "pending") {
          this.set(p, "resolved", t, "o ganho mudou na mesa");
          out.changed = true;
        }
      }
      const level = this.converter(ch);
      if (level !== null) this.peaks.push(ch.index, t, level);
      // "Subir o ganho" pendente que ficou perigoso: o sinal cresceu e o aumento passaria do alvo.
      const up = this.pendingFor(`gain:${ch.index}`);
      if (up?.status === "pending" && up.kind === "gain-up" && level !== null &&
        level + (up.deltaDb ?? 0) > this.limits.targetPeakDb + 3) {
        this.set(up, "resolved", t, "o sinal subiu; aumentar agora poderia clipar");
        out.changed = true;
      }

      const cooling = t < (this.cooldownUntil.get(ch.index) ?? 0);
      const proposals: Proposal[] = [];
      if (!cooling) {
        const g = gainProposal(ch, level, {
          hot: this.peaks.window(ch.index, t, this.limits.hotWindowS),
          low: this.peaks.window(ch.index, t, this.limits.lowWindowS),
          lowSpan: this.peaks.span(ch.index, t),
        }, this.limits);
        if (g) proposals.push(g);
      }
      const u = unmuteProposal(ch, this.limits);
      if (u) {
        const since = this.muteSeen.get(ch.index) ?? t;
        this.muteSeen.set(ch.index, since);
        if (t - since >= this.limits.mutedSignalHoldMs) proposals.push(u);
      } else {
        this.muteSeen.delete(ch.index);
        // Desmutaram na mesa (ou o sinal sumiu): a sugestão de desmutar sai.
        const p = this.pendingFor(`unmute:${ch.index}`);
        if (p?.status === "pending" && ch.mute !== true) {
          this.set(p, "resolved", t, "o canal foi desmutado na mesa");
          out.changed = true;
        }
      }

      for (const p of proposals) {
        if (t < (this.dismissedUntil.get(p.key) ?? 0)) continue;
        let existing = this.pendingFor(p.key);
        // Mudou de direção (estava fraco, agora clipa): a sugestão antiga sai e vale a nova.
        if (existing?.status === "pending" && p.deltaDb !== undefined && existing.deltaDb !== undefined &&
          Math.sign(p.deltaDb) !== Math.sign(existing.deltaDb)) {
          this.set(existing, "resolved", t, "o nível mudou de direção");
          out.changed = true;
          existing = undefined;
        }
        if (existing) {
          // Clip depois de "quente": vale a correção maior.
          if (existing.status === "pending" && p.deltaDb !== undefined && existing.deltaDb !== undefined &&
            Math.abs(p.deltaDb) > Math.abs(existing.deltaDb) && Math.sign(p.deltaDb) === Math.sign(existing.deltaDb)) {
            Object.assign(existing, { title: p.title, detail: p.detail, deltaDb: p.deltaDb, updatedAt: t });
            delete existing.commands;
            out.created.push(existing);
            out.changed = true;
          }
          continue;
        }
        const s: Suggestion = {
          id: randomUUID(), ...p, status: "pending", createdAt: t, updatedAt: t, gainAtCreate: ch.gainDb,
        };
        if (s.kind === "gain-up" && this.limits.noAutoUpAfterDown && this.hadDown.has(ch.index)) {
          s.autoAllowed = false;
        }
        this.items.set(s.id, s);
        this.log(s, t);
        out.created.push(s);
        out.changed = true;
      }
    }

    if (this.modeValue === "auto") {
      for (const s of this.items.values()) {
        if (s.status !== "pending" || !this.canAuto(s, t)) continue;
        this.autoTimes.push(t);
        this.set(s, "applying", t);
        s.by = "auto";
        out.toApply.push(s);
        out.changed = true;
      }
    }
    return out;
  }

  /** Pode aplicar sozinho agora? (permitida, dentro do teto do canal e das ações por minuto) */
  canAuto(s: Suggestion, t: number): boolean {
    if (!s.autoAllowed) return false;
    this.autoTimes = this.autoTimes.filter((x) => t - x < 60_000);
    if (this.autoTimes.length >= this.limits.autoMaxPerMin) return false;
    if (s.deltaDb !== undefined && (this.autoTotal.get(s.channel) ?? 0) + Math.abs(s.deltaDb) > this.limits.autoMaxTotalDb) {
      return false;
    }
    return true;
  }

  get(id: string): Suggestion | undefined {
    return this.items.get(id);
  }

  /** Comandos do plano de leitura, para mostrar na sugestão. */
  setPlan(id: string, commands: string[]): void {
    const s = this.items.get(id);
    if (s) s.commands = commands;
  }

  /** O operador deu OK: marca como aplicando (o servidor chama o executor). */
  beginApply(id: string, t = Date.now()): Suggestion {
    const s = this.items.get(id);
    if (!s || s.status !== "pending") throw new Error("Sugestão não está pendente");
    s.by = "operator";
    this.set(s, "applying", t);
    return s;
  }

  finishApply(id: string, result: { ok: true; writes: PlannedWrite[]; commands: string[] } | { ok: false; error: string; unavailable?: boolean }, t = Date.now()): void {
    const s = this.items.get(id);
    if (!s) return;
    if (!result.ok) {
      this.set(s, result.unavailable ? "unavailable" : "failed", t, result.error);
      // Não fica insistindo: o que não dá para corrigir pela mesa espera o tempo de dispensa; uma
      // falha (leitura perdida, leitura de volta diferente) espera failRetryMs antes de tentar de novo.
      this.dismissedUntil.set(s.key, t + (result.unavailable ? this.limits.dismissMs : this.limits.failRetryMs));
      this.cooldownUntil.set(s.channel, t + this.limits.cooldownMs);
      return;
    }
    s.writes = result.writes;
    s.commands = result.commands;
    this.cooldownUntil.set(s.channel, t + this.limits.cooldownMs);
    this.peaks.reset(s.channel);
    const gain = result.writes.find((w) => w.kind === "gain");
    if (gain) {
      this.lastGain.set(s.channel, gain.to);
      if (gain.to < gain.from) this.hadDown.add(s.channel);
      if (s.by === "auto") this.autoTotal.set(s.channel, (this.autoTotal.get(s.channel) ?? 0) + Math.abs(gain.to - gain.from));
    }
    this.set(s, "applied", t);
  }

  /** Marca a sugestão como impossível de corrigir (plano de leitura recusado). */
  markUnavailable(id: string, error: string, t = Date.now()): void {
    this.finishApply(id, { ok: false, error, unavailable: true }, t);
  }

  dismiss(id: string, t = Date.now()): Suggestion {
    const s = this.items.get(id);
    if (!s) throw new Error("Sugestão não encontrada");
    if (s.status === "pending") {
      this.dismissedUntil.set(s.key, t + this.limits.dismissMs);
      this.set(s, "dismissed", t);
    } else if (!ACTIVE.includes(s.status)) {
      this.items.delete(id); // tirar da tela uma ação já feita ou que falhou
    } else {
      throw new Error("Sugestão sendo aplicada");
    }
    return s;
  }

  markUndone(id: string, t = Date.now()): void {
    const s = this.items.get(id);
    if (!s) return;
    this.cooldownUntil.set(s.channel, t + this.limits.cooldownMs);
    this.peaks.reset(s.channel);
    this.dismissedUntil.set(s.key, t + this.limits.dismissMs);
    const gain = s.writes?.find((w) => w.kind === "gain");
    if (gain) this.lastGain.set(s.channel, gain.from);
    this.set(s, "undone", t);
  }

  /** Na tela: pendentes primeiro, depois as ações recentes. */
  list(): Suggestion[] {
    const order = (s: Suggestion) => (s.status === "pending" ? 0 : s.status === "applying" ? 1 : 2);
    return [...this.items.values()].sort((a, b) => order(a) - order(b) || a.createdAt - b.createdAt);
  }

  history(): AssistHistoryEntry[] {
    return [...this.hist];
  }
}
