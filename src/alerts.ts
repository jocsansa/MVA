// Alertas ao vivo durante o culto. Desenho do automix (server/src/alerts.ts) adaptado para a
// WING e o MVA: as regras olham os medidores e o estado dos canais e só AVISAM. Nunca escrevem
// na mesa. Cada alerta dispara uma vez por ocorrência (depois do tempo de espera), some quando a
// condição resolve e, se dispensado, só volta quando a condição sumir e aparecer de novo.

import { randomUUID } from "node:crypto";
import type { Strips } from "./strips.ts";

/**
 * Todos os limites dos alertas, num só lugar. Níveis em dBFS, tempos em ms.
 * CALIBRAÇÃO PENDENTE: valores herdados do automix, ainda não conferidos com a WING real
 * (nível de entrada típico dos microfones, ruído de canal parado, nível do main).
 */
export const ALERT_LIMITS = {
  /** Acima disso o canal "tem sinal". */
  signalDb: -45,
  /** Abaixo disso o canal ou o main está "em silêncio". */
  silentDb: -60,
  /** Entrada nesse nível ou acima está clipando. */
  clipDb: -0.5,
  /** Tempo de espera de cada regra antes de virar alerta. */
  mutedSignalHoldMs: 2000,
  deadChannelHoldMs: 30_000,
  mainSilentHoldMs: 5000,
  /** O clip fica na tela por esse tempo depois do último pico. */
  clipClearMs: 10_000,
  /** Fader acima disso = canal aberto (mute com fader aberto e canal morto). */
  openFaderDb: -50,
  /** Sem resposta OSC por esse tempo = mesa desconectada (o heartbeat é a cada 5 s). */
  oscTimeoutMs: 12_000,
  /** Sem pacote de medidores por esse tempo = medidores parados. */
  meterStaleMs: 3000,
  /** Janela de picos: as regras olham o maior valor dos últimos N ms, não o quadro instantâneo. */
  peakWindowMs: 500,
  /** Canais com microfone sem fio (muda os passos do canal morto). Nome com "sem fio"/"SF"/"RF" também conta. */
  wirelessChannels: [] as number[],
  /** Canais que nunca geram alerta de canal (ex.: canal reserva aberto de propósito). */
  ignoreChannels: [] as number[],
};
export type AlertLimits = typeof ALERT_LIMITS;

const WIRELESS_NAME = /sem ?fio|wireless|\bs\/?f\b|\brf\b/i;

export type AlertLevel = "critical" | "warning";

export interface Alert {
  id: string;
  key: string;
  level: AlertLevel;
  title: string;
  detail: string;
  steps: string[];
  /** Canal do alerta (alertas de canal). */
  channel?: number;
  raisedAt: number;
}

export interface AlertHistoryEntry {
  t: number;
  action: "raised" | "cleared" | "dismissed";
  id: string;
  key: string;
  level: AlertLevel;
  title: string;
}

/** Um canal visto pelas regras: estado e picos da janela (entrada antes do fader e do mute; saída depois). */
export interface ChannelView {
  index: number;
  name: string;
  mute: boolean | null;
  faderDb: number | null;
  in: number | null;
  out: number | null;
}

export interface AlertContext {
  t: number;
  /** A mesa respondeu por OSC dentro de oscTimeoutMs. */
  osc: boolean;
  /** Chegaram medidores dentro de meterStaleMs. */
  meters: boolean;
  channels: ChannelView[];
  main: { mute: boolean | null; out: number | null };
  /** Momento do culto marcado na gravação (null sem gravação). No pré-culto não há alerta de canal morto. */
  moment: string | null;
}

interface Candidate extends Omit<Alert, "id" | "raisedAt"> {
  holdMs: number;
  clearMs?: number;
}

const label = (ch: ChannelView) => `CH ${ch.index}${ch.name ? ` (${ch.name})` : ""}`;

/** Condições presentes agora (antes dos tempos de espera). */
export function evaluate(ctx: AlertContext, limits: AlertLimits = ALERT_LIMITS): Candidate[] {
  if (!ctx.osc || !ctx.meters) {
    return [{
      key: "disconnected",
      level: "critical",
      title: "Mesa desconectada",
      detail: ctx.osc
        ? "Os medidores da WING pararam de chegar. O app parou de acompanhar os níveis."
        : "A WING não responde. O app parou de acompanhar a mesa.",
      steps: [
        "Opere direto na mesa: o culto segue normal na WING.",
        "Confira o cabo de rede da mesa e do computador.",
        "Avise o técnico líder.",
      ],
      holdMs: 0,
    }];
  }
  const out: Candidate[] = [];
  const open = (ch: ChannelView) => ch.faderDb !== null && ch.faderDb > limits.openFaderDb;

  for (const ch of ctx.channels) {
    if (ch.in === null || limits.ignoreChannels.includes(ch.index)) continue;
    const name = label(ch);

    // Mute ligado com fader aberto e sinal entrando: quase sempre esqueceram de desmutar.
    if (ch.mute === true && open(ch) && ch.in > limits.signalDb) {
      out.push({
        key: `muted-signal:${ch.index}`,
        level: "critical",
        title: `${name} está mutado`,
        detail: `Tem sinal entrando no ${name}, o fader está aberto, mas o canal está mutado.`,
        steps: [`Na mesa, ache o canal ${ch.index}${ch.name ? ` (${ch.name})` : ""}.`, "Aperte MUTE para apagar a luz.", "Confira se o som voltou no PA."],
        channel: ch.index,
        holdMs: limits.mutedSignalHoldMs,
      });
    }

    if (ch.in >= limits.clipDb) {
      out.push({
        key: `clip:${ch.index}`,
        level: "warning",
        title: `${name} está clipando`,
        detail: `O sinal de entrada do ${name} está batendo no limite do conversor.`,
        steps: [
          `Na mesa, abra o canal ${ch.index} e baixe o ganho (GAIN) aos poucos.`,
          "Se continuar clipando, peça para baixarem a fonte (instrumento ou amplificador).",
          "Se não resolver, chame o técnico líder.",
        ],
        channel: ch.index,
        holdMs: 0,
        clearMs: limits.clipClearMs,
      });
    }

    // Canal aberto (sem mute, fader levantado) e sem nada entrando.
    if (ch.mute === false && open(ch) && ctx.moment !== "pre" && ch.in < limits.silentDb) {
      const wireless = limits.wirelessChannels.includes(ch.index) || WIRELESS_NAME.test(ch.name);
      out.push({
        key: `dead:${ch.index}`,
        level: "warning",
        title: `${name} sem sinal`,
        detail: `O ${name} está aberto, mas não entra sinal há mais de ${Math.round(limits.deadChannelHoldMs / 1000)} s.`,
        steps: wireless
          ? ["Confira a bateria do microfone sem fio.", "Confira se o microfone está ligado e fora do mute do próprio transmissor.", "Confira o receptor (luz de RF e de áudio)."]
          : ["Confira o cabo do microfone ou instrumento até o palco.", `Se for microfone condensador, confira o phantom (48V) do canal ${ch.index}.`, "Peça para o músico tocar ou falar e olhe o medidor."],
        channel: ch.index,
        holdMs: limits.deadChannelHoldMs,
      });
    }
  }

  const anyOpenWithSignal = ctx.channels.some((ch) => ch.mute === false && ch.out !== null && ch.out > limits.signalDb);
  if (anyOpenWithSignal && ctx.main.out !== null && ctx.main.out < limits.silentDb) {
    out.push({
      key: "main-silent",
      level: "critical",
      title: "MAIN LR sem sinal",
      detail: "Há canais abertos com sinal, mas nada sai no MAIN LR.",
      steps: [
        `Confira o mute do MAIN na mesa${ctx.main.mute ? ": ele está MUTADO agora" : ""}.`,
        "Confira se algum DCA ou mute group está mutado ou abaixado.",
        "Confira o fader do MAIN e se a amplificação está ligada.",
      ],
      holdMs: limits.mainSilentHoldMs,
    });
  }
  return out;
}

export interface AlertUpdate {
  raised: Alert[];
  cleared: Alert[];
}

const HISTORY_MAX = 300;

export class AlertEngine {
  private readonly limits: AlertLimits;
  private firstSeen = new Map<string, number>();
  private lastSeen = new Map<string, number>();
  private active = new Map<string, Alert>();
  private dismissed = new Set<string>();
  private clearMs = new Map<string, number>();
  private hist: AlertHistoryEntry[] = [];

  constructor(limits: Partial<AlertLimits> = {}) {
    this.limits = { ...ALERT_LIMITS, ...limits };
  }

  private log(t: number, action: AlertHistoryEntry["action"], a: Alert): void {
    this.hist.push({ t, action, id: a.id, key: a.key, level: a.level, title: a.title });
    if (this.hist.length > HISTORY_MAX) this.hist.splice(0, this.hist.length - HISTORY_MAX);
  }

  update(ctx: AlertContext): AlertUpdate {
    const raised: Alert[] = [];
    const cleared: Alert[] = [];
    const candidates = evaluate(ctx, this.limits);
    const present = new Set(candidates.map((c) => c.key));

    for (const c of candidates) {
      if (!this.firstSeen.has(c.key)) this.firstSeen.set(c.key, ctx.t);
      this.lastSeen.set(c.key, ctx.t);
      this.clearMs.set(c.key, c.clearMs ?? 0);
      const held = ctx.t - this.firstSeen.get(c.key)! >= c.holdMs;
      if (held && !this.active.has(c.key) && !this.dismissed.has(c.key)) {
        const { holdMs: _h, clearMs: _c, ...rest } = c;
        const alert: Alert = { id: randomUUID(), ...rest, raisedAt: ctx.t };
        this.active.set(c.key, alert);
        raised.push(alert);
        this.log(ctx.t, "raised", alert);
      }
    }

    const connected = ctx.osc && ctx.meters;
    for (const key of [...this.firstSeen.keys()]) {
      if (present.has(key)) continue;
      // Sem conexão os medidores estão parados: congela os outros alertas.
      if (!connected) continue;
      if (ctx.t - this.lastSeen.get(key)! < (this.clearMs.get(key) ?? 0)) continue;
      this.firstSeen.delete(key);
      this.lastSeen.delete(key);
      this.dismissed.delete(key);
      const alert = this.active.get(key);
      if (alert) {
        this.active.delete(key);
        cleared.push(alert);
        this.log(ctx.t, "cleared", alert);
      }
    }
    return { raised, cleared };
  }

  /** O alerta sai da tela e só volta se a condição sumir e aparecer de novo. */
  dismiss(id: string, t = Date.now()): Alert | undefined {
    for (const [key, alert] of this.active) {
      if (alert.id !== id) continue;
      this.active.delete(key);
      this.dismissed.add(key);
      this.log(t, "dismissed", alert);
      return alert;
    }
    return undefined;
  }

  /** Alertas na tela: críticos primeiro, depois os mais antigos. */
  list(): Alert[] {
    return [...this.active.values()].sort((a, b) =>
      a.level === b.level ? a.raisedAt - b.raisedAt : a.level === "critical" ? -1 : 1);
  }

  history(): AlertHistoryEntry[] {
    return [...this.hist];
  }

  /** Começa um histórico novo (ao iniciar uma gravação). */
  resetHistory(): void {
    this.hist = [];
  }
}

/** Picos dos últimos N ms por canal (entrada e saída) e do MAIN 1, a partir dos quadros de medidores. */
export class MeterWindow {
  private frames: { t: number; in: (number | null)[]; out: (number | null)[]; main: number | null }[] = [];
  private readonly windowMs: number;

  constructor(windowMs = ALERT_LIMITS.peakWindowMs) {
    this.windowMs = windowMs;
  }

  push(t: number, strips: Strips): void {
    const m = strips.main[0]?.meter;
    this.frames.push({
      t,
      in: strips.ch.map((s) => s.meter?.in ?? null),
      out: strips.ch.map((s) => (s.meter ? Math.max(s.meter.l, s.meter.r) : null)),
      main: m ? Math.max(m.l, m.r) : null,
    });
    this.drop(t);
  }

  private drop(t: number): void {
    const cutoff = t - this.windowMs;
    while (this.frames.length && this.frames[0]!.t < cutoff) this.frames.shift();
  }

  /** Picos da janela, ou null se não chegou quadro nela (medidores parados). */
  held(t: number): { in: (number | null)[]; out: (number | null)[]; main: number | null } | null {
    this.drop(t);
    if (!this.frames.length) return null;
    const peak = (pick: (f: (typeof this.frames)[number]) => (number | null)[]) =>
      pick(this.frames.at(-1)!).map((_, i) => {
        let best: number | null = null;
        for (const f of this.frames) {
          const v = pick(f)[i];
          if (v !== null && v !== undefined && (best === null || v > best)) best = v;
        }
        return best;
      });
    const mains = this.frames.map((f) => f.main).filter((v): v is number => v !== null);
    return { in: peak((f) => f.in), out: peak((f) => f.out), main: mains.length ? Math.max(...mains) : null };
  }
}

/** Monta o contexto das regras a partir do estado do cliente da WING. */
export function alertContext(
  t: number,
  strips: Strips,
  window: MeterWindow,
  status: { lastOscAt: number | null; lastMeterAt: number | null },
  startedAt: number,
  moment: string | null,
  limits: AlertLimits = ALERT_LIMITS,
): AlertContext {
  // Logo depois de subir o servidor ainda não houve resposta: conta a partir do início.
  const osc = t - (status.lastOscAt ?? startedAt) < limits.oscTimeoutMs;
  const held = window.held(t);
  const fresh = status.lastMeterAt !== null && t - status.lastMeterAt < limits.meterStaleMs && held !== null;
  const waiting = status.lastMeterAt === null && t - startedAt < limits.oscTimeoutMs;
  return {
    t,
    osc,
    meters: fresh || waiting,
    moment,
    channels: strips.ch.map((s, i) => ({
      index: s.index, name: s.name, mute: s.mute, faderDb: s.faderDb, in: held?.in[i] ?? null, out: held?.out[i] ?? null,
    })),
    main: { mute: strips.main[0]?.mute ?? null, out: held?.main ?? null },
  };
}
