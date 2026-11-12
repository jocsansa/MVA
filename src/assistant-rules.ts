// Regras e tipos do assistente de ganho (o motor fica em src/assistant.ts). Funções puras.

/** Todos os limites do assistente, num só lugar. Níveis em dBFS, tempos em ms. CALIBRAÇÃO PENDENTE. */
export const ASSIST_LIMITS = {
  /** Entrada nesse nível ou acima está clipando (mesmo limite dos alertas). */
  clipDb: -0.5,
  /** Picos frequentes acima disso deixam pouca margem: "quente". */
  hotDb: -5,
  /** Janela e quantos segundos com pico acima de hotDb para virar sugestão. */
  hotWindowS: 20,
  hotHits: 3,
  /** Pico máximo alvo depois da correção. */
  targetPeakDb: -12,
  /** Acima disso o canal "tem sinal" (mesmo limite dos alertas). */
  signalDb: -45,
  /** Sinal fraco: pico máximo da janela abaixo disso, com sinal na maior parte do tempo. */
  lowPeakDb: -32,
  lowWindowS: 60,
  lowActiveS: 40,
  /** Menor e maior passo de uma correção de ganho. */
  minStepDb: 3,
  maxStepDownDb: 12,
  maxStepUpDb: 10,
  /** Mutado com sinal: fader acima disso e tempo de espera (mesmo desenho do alerta). */
  openFaderDb: -50,
  mutedSignalHoldMs: 2000,
  /** Depois de mexer num canal, espera os medidores assentarem antes de olhar de novo. */
  cooldownMs: 10_000,
  /** Automático: no máximo tantas ações por minuto (todas somadas). */
  autoMaxPerMin: 6,
  /** Automático: soma das mudanças de ganho por canal enquanto o servidor roda. Passou disso, pede OK. */
  autoMaxTotalDb: 18,
  /** Sugestão ignorada (ou sem correção pela mesa) não volta por esse tempo. */
  dismissMs: 10 * 60_000,
  /** Correção que falhou ao aplicar só é proposta de novo depois desse tempo. */
  failRetryMs: 2 * 60_000,
  /** Sugestão pendente some sozinha depois desse tempo. */
  expireMs: 10 * 60_000,
  /** Desmutar sozinho pode abrir um microfone que está mutado de propósito: por padrão sempre pede OK. */
  autoUnmute: false,
  /** Canal que teve ganho baixado não ganha aumento automático (evita sobe-e-desce). */
  noAutoUpAfterDown: true,
  /**
   * Os medidores de entrada (palavras 0 e 1) vêm depois do trim? Se sim, o nível no conversor é
   * entrada − trim. NÃO CONFERIDO NA WING REAL: testar no domingo (README, roteiro do teste).
   */
  inputMeterPostTrim: false,
};
export type AssistLimits = typeof ASSIST_LIMITS;

export type AssistMode = "off" | "suggest" | "auto";
export const ASSIST_MODES: readonly AssistMode[] = ["off", "suggest", "auto"];

export type SuggestionKind = "gain-down" | "gain-up" | "unmute";
export type SuggestionStatus =
  | "pending" // esperando OK (ou o automático)
  | "applying"
  | "applied"
  | "failed"
  | "dismissed"
  | "resolved" // o problema sumiu ou o operador resolveu na mesa
  | "expired"
  | "unavailable" // não dá para corrigir pela mesa (ex.: fonte sem ganho ajustável)
  | "undone";

/** Uma escrita feita (ou planejada) na mesa, com o valor anterior para desfazer. */
export interface PlannedWrite {
  kind: "gain" | "trim" | "mute";
  channel: number;
  path: string;
  from: number;
  to: number;
  label: string;
}

export interface Suggestion {
  id: string;
  key: string;
  kind: SuggestionKind;
  channel: number;
  title: string;
  detail: string;
  /** Mudança de ganho pedida (dB, com sinal). */
  deltaDb?: number;
  /** Pode ser aplicada sem OK no modo automático. */
  autoAllowed: boolean;
  status: SuggestionStatus;
  createdAt: number;
  updatedAt: number;
  /** Ganho do canal quando a sugestão nasceu: se mudar na mesa, a sugestão perde o sentido. */
  gainAtCreate: number | null;
  /** Comandos exatos (do plano de leitura, antes de aplicar; ou os enviados). */
  commands?: string[];
  writes?: PlannedWrite[];
  message?: string;
  by?: "auto" | "operator";
}

/** Canal visto pelo assistente: estado e pico da janela curta (entrada antes do fader e do mute). */
export interface AssistChannel {
  index: number;
  name: string;
  mute: boolean | null;
  faderDb: number | null;
  gainDb: number | null;
  trimDb: number | null;
  in: number | null;
}

export interface AssistContext {
  t: number;
  /** Mesa e medidores respondendo (sem isso nada é proposto nem aplicado). */
  connected: boolean;
  channels: AssistChannel[];
}

const label = (ch: { index: number; name: string }) => `CH ${ch.index}${ch.name ? ` (${ch.name})` : ""}`;
const fmtDb = (n: number) => `${n > 0 ? "+" : ""}${Math.round(n * 10) / 10} dB`;
export const ACTIVE: readonly SuggestionStatus[] = ["pending", "applying"];

/** Máximo de cada segundo por canal (nível no conversor), para as regras de janela longa. */
export class SecondPeaks {
  private rows = new Map<number, { sec: number; max: number }[]>();

  push(ch: number, t: number, level: number): void {
    const sec = Math.floor(t / 1000);
    const row = this.rows.get(ch) ?? [];
    const last = row.at(-1);
    if (last && last.sec === sec) last.max = Math.max(last.max, level);
    else row.push({ sec, max: level });
    while (row.length && row[0]!.sec <= sec - 120) row.shift();
    this.rows.set(ch, row);
  }

  /** Segundos completos dos últimos N (sem o segundo atual, que ainda está enchendo). */
  window(ch: number, t: number, seconds: number): { max: number }[] {
    const now = Math.floor(t / 1000);
    return (this.rows.get(ch) ?? []).filter((r) => r.sec < now && r.sec >= now - seconds);
  }

  /** Há quantos segundos o canal tem histórico contínuo (desde o último reset). */
  span(ch: number, t: number): number {
    const first = this.rows.get(ch)?.[0];
    return first ? Math.floor(t / 1000) - first.sec : 0;
  }

  reset(ch: number): void {
    this.rows.delete(ch);
  }
}

export interface Proposal {
  key: string;
  kind: SuggestionKind;
  channel: number;
  title: string;
  detail: string;
  deltaDb?: number;
  autoAllowed: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const sameDb = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 0.05);

/** Regras de ganho de um canal (precisa do histórico de picos por segundo). */
export function gainProposal(
  ch: AssistChannel,
  now: number | null,
  win: { hot: { max: number }[]; low: { max: number }[]; lowSpan: number },
  limits: AssistLimits = ASSIST_LIMITS,
): Proposal | null {
  if (ch.gainDb === null) return null;
  const name = label(ch);
  const step = (need: number, max: number) => clamp(need, limits.minStepDb, max);
  const neutral = "O trim compensa: o volume no PA e nos retornos não muda, só a margem até o clip.";

  if (now !== null && now >= limits.clipDb) {
    const d = -step(now - limits.targetPeakDb, limits.maxStepDownDb);
    return {
      key: `gain:${ch.index}`, kind: "gain-down", channel: ch.index, deltaDb: d, autoAllowed: true,
      title: `${name} clipando: baixar o ganho ${fmtDb(-d).slice(1)}`,
      detail: `A entrada bateu no limite do conversor. Baixar o ganho da fonte ${fmtDb(d)} e subir o trim ${fmtDb(-d)}. ${neutral}`,
    };
  }
  const hotHits = win.hot.filter((s) => s.max >= limits.hotDb).length;
  if (hotHits >= limits.hotHits) {
    const peak = Math.max(...win.hot.map((s) => s.max));
    const d = -step(peak - limits.targetPeakDb, limits.maxStepDownDb);
    return {
      key: `gain:${ch.index}`, kind: "gain-down", channel: ch.index, deltaDb: d, autoAllowed: true,
      title: `${name} quente: baixar o ganho ${fmtDb(-d).slice(1)}`,
      detail: `Picos acima de ${limits.hotDb} dBFS ${hotHits} vezes em ${limits.hotWindowS} s (máximo ${fmtDb(peak).replace(" dB", " dBFS")}). ` +
        `Baixar o ganho ${fmtDb(d)} e subir o trim ${fmtDb(-d)}. ${neutral}`,
    };
  }
  if (win.lowSpan >= limits.lowWindowS) {
    const active = win.low.filter((s) => s.max > limits.signalDb).length;
    const peak = Math.max(...win.low.map((s) => s.max));
    if (active >= limits.lowActiveS && peak < limits.lowPeakDb) {
      const d = step(limits.targetPeakDb - peak, limits.maxStepUpDb);
      return {
        key: `gain:${ch.index}`, kind: "gain-up", channel: ch.index, deltaDb: d, autoAllowed: true,
        title: `${name} fraco: subir o ganho ${fmtDb(d).slice(1)}`,
        detail: `Com sinal há ${limits.lowWindowS} s, o pico máximo foi ${fmtDb(peak).replace(" dB", " dBFS")}: sobra ruído. ` +
          `Subir o ganho ${fmtDb(d)} e baixar o trim ${fmtDb(-d)}. ${neutral}`,
      };
    }
  }
  return null;
}

/** Mutado com fader aberto e sinal entrando (o tempo de espera é contado pelo motor). */
export function unmuteProposal(ch: AssistChannel, limits: AssistLimits = ASSIST_LIMITS): Proposal | null {
  if (ch.mute !== true || ch.faderDb === null || ch.faderDb <= limits.openFaderDb) return null;
  if (ch.in === null || ch.in <= limits.signalDb) return null;
  const name = label(ch);
  return {
    key: `unmute:${ch.index}`, kind: "unmute", channel: ch.index, autoAllowed: limits.autoUnmute,
    title: `${name} mutado com sinal: desmutar?`,
    detail: `Tem sinal entrando e o fader está aberto, mas o canal está mutado. Confirme que é para abrir ` +
      `(pode ser um microfone mutado de propósito).`,
  };
}

