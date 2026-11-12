// Liga o motor do assistente (src/assistant.ts) ao executor (src/corrections.ts) e ao servidor.
// Tudo que fala com a mesa passa por uma FILA: uma correção por vez, nunca duas escritas ao mesmo
// tempo. Toda proposta, ação, falha e desfazer vai para o registro da sessão (gravação) e para a página.

import { ASSIST_MODES, Assistant, type AssistLimits, type AssistMode, type Suggestion } from "./assistant.ts";
import { CorrectionUnavailable, applySuggestion, commandOf, planSuggestion, undoWrites, type ExecResult } from "./corrections.ts";
import type { WingClient } from "./wing.ts";
import type { Strips } from "./strips.ts";

export class AssistError extends Error {
  readonly code: number;
  constructor(message: string, code = 400) {
    super(message);
    this.code = code;
  }
}

export interface AssistServiceOptions {
  writesEnabled: boolean;
  mode?: AssistMode;
  limits?: Partial<AssistLimits>;
  /** Registro da sessão (só grava se houver gravação em andamento). */
  note: (entry: { type: string; [k: string]: unknown }) => void;
  /** Avisa a página que o estado mudou. */
  changed: () => void;
}

export class AssistantService {
  readonly engine: Assistant;
  private readonly wing: WingClient;
  private readonly opts: AssistServiceOptions;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly undoing = new Set<string>();

  constructor(wing: WingClient, opts: AssistServiceOptions) {
    this.wing = wing;
    this.opts = opts;
    this.engine = new Assistant({ mode: opts.mode ?? "suggest", limits: opts.limits });
  }

  /** Uma tarefa por vez na mesa. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private note(action: string, s: Suggestion, extra: Record<string, unknown> = {}): void {
    this.opts.note({
      type: "assist", action, kind: s.kind, channel: s.channel, title: s.title,
      ...(s.deltaDb !== undefined ? { deltaDb: s.deltaDb } : {}), ...(s.by ? { by: s.by } : {}), ...extra,
    });
  }

  state() {
    return {
      mode: this.engine.mode,
      writesEnabled: this.opts.writesEnabled,
      suggestions: this.engine.list(),
      history: this.engine.history().slice(-150),
      limits: this.engine.limits,
    };
  }

  /** Relógio (a cada 250 ms, junto com os alertas). `held` = picos de entrada da janela curta. */
  tick(t: number, strips: Strips, held: (number | null)[], connected: boolean): void {
    const u = this.engine.update({
      t,
      connected,
      channels: strips.ch.map((s, i) => ({
        index: s.index, name: s.name, mute: s.mute, faderDb: s.faderDb, gainDb: s.gainDb, trimDb: s.trimDb, in: held[i] ?? null,
      })),
    });
    for (const s of u.created) {
      this.note("proposed", s);
      console.log(`Assistente: ${s.title}`);
      // Comandos exatos para mostrar no cartão: plano só de leitura, FORA da fila (não atrasa um OK ou
      // o automático, que replanejam com leitura nova ao aplicar). O patch lido vale por 5 s.
      if (s.status === "pending") void this.preview(s);
    }
    for (const s of u.toApply) void this.enqueue(() => this.run(s));
    if (u.changed) this.opts.changed();
  }

  private async preview(s: Suggestion): Promise<void> {
    if (s.status !== "pending") return;
    try {
      const plan = await planSuggestion(this.wing, s, { sourceMaxAgeMs: 5000 });
      if (s.status !== "pending") return;
      this.engine.setPlan(s.id, plan.map(commandOf));
    } catch (e) {
      if (s.status !== "pending") return; // já foi aplicada ou ignorada enquanto lia
      if (e instanceof CorrectionUnavailable) {
        this.engine.markUnavailable(s.id, e.message);
        this.note("unavailable", s, { message: e.message });
      } else {
        this.engine.setPlan(s.id, []);
        s.message = `Não consegui ler a mesa para montar o comando: ${(e as Error).message}`;
      }
    }
    this.opts.changed();
  }

  private async run(s: Suggestion): Promise<ExecResult> {
    this.opts.changed();
    let r: ExecResult;
    try {
      r = this.opts.writesEnabled
        ? await applySuggestion(this.wing, s)
        : { ok: false, error: "Escrita desativada (inicie com WING_ALLOW_WRITES=1)" };
    } catch (e) {
      r = { ok: false, error: (e as Error).message };
    }
    this.engine.finishApply(s.id, r);
    if (r.ok) {
      this.note("applied", s, { commands: r.commands, writes: r.writes });
      console.log(`Assistente aplicou (${s.by === "auto" ? "automático" : "OK do operador"}): ${s.title} → ${r.commands.join(" | ")}`);
    } else {
      this.note(r.unavailable ? "unavailable" : "failed", s, { message: r.error });
      console.log(`Assistente NÃO aplicou: ${s.title}: ${r.error}`);
    }
    this.opts.changed();
    return r;
  }

  setMode(mode: unknown): AssistMode {
    if (typeof mode !== "string" || !ASSIST_MODES.includes(mode as AssistMode)) {
      throw new AssistError("Modo inválido (use off, suggest ou auto)");
    }
    const m = mode as AssistMode;
    if (m === "auto" && !this.opts.writesEnabled) {
      throw new AssistError("Automático precisa de escrita liberada (inicie com WING_ALLOW_WRITES=1)", 403);
    }
    this.engine.setMode(m);
    this.opts.note({ type: "assist", action: "mode", mode: m });
    console.log(`Assistente: modo ${m}`);
    this.opts.changed();
    return m;
  }

  /** OK do operador numa sugestão pendente. */
  async apply(id: unknown): Promise<ExecResult> {
    if (!this.opts.writesEnabled) throw new AssistError("Escrita desativada (inicie com WING_ALLOW_WRITES=1)", 403);
    if (typeof id !== "string") throw new AssistError("id inválido");
    let s: Suggestion;
    try {
      s = this.engine.beginApply(id);
    } catch (e) {
      throw new AssistError((e as Error).message, 409);
    }
    return this.enqueue(() => this.run(s));
  }

  dismiss(id: unknown): void {
    if (typeof id !== "string") throw new AssistError("id inválido");
    try {
      const s = this.engine.dismiss(id);
      if (s.status === "dismissed") this.note("dismissed", s);
    } catch (e) {
      throw new AssistError((e as Error).message, 409);
    }
    this.opts.changed();
  }

  /** Desfaz uma ação aplicada (se a mesa ainda estiver como o assistente deixou). */
  async undo(id: unknown): Promise<ExecResult> {
    if (!this.opts.writesEnabled) throw new AssistError("Escrita desativada (inicie com WING_ALLOW_WRITES=1)", 403);
    const s = typeof id === "string" ? this.engine.get(id) : undefined;
    if (!s || s.status !== "applied" || !s.writes?.length) throw new AssistError("Só dá para desfazer uma ação aplicada", 409);
    // Dois aparelhos (ou dois toques) pedindo ao mesmo tempo: só o primeiro desfaz.
    if (this.undoing.has(s.id)) throw new AssistError("Já está desfazendo", 409);
    this.undoing.add(s.id);
    const writes = s.writes;
    return this.enqueue(async () => {
      const r = await undoWrites(this.wing, writes).catch((e: unknown): ExecResult => ({ ok: false, error: (e as Error).message }));
      this.undoing.delete(s.id);
      if (r.ok) {
        this.engine.markUndone(s.id);
        this.note("undone", s, { commands: r.commands });
        console.log(`Assistente desfez: ${s.title} → ${r.commands.join(" | ")}`);
      } else {
        s.message = `Não desfez: ${r.error}`;
        this.note("undo-failed", s, { message: r.error });
      }
      this.opts.changed();
      return r;
    });
  }
}
