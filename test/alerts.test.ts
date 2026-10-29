// Alertas ao vivo: limites, tempos de espera, disparo único, limpeza ao resolver e dispensa.
// Mesmo desenho dos testes do automix, com o contexto do MVA (canais da WING, entrada e saída).

import { test } from "node:test";
import assert from "node:assert/strict";
import { ALERT_LIMITS, AlertEngine, MeterWindow, alertContext, evaluate, type AlertContext, type ChannelView } from "../src/alerts.ts";
import { createStrips } from "../src/strips.ts";

const L = ALERT_LIMITS;

/** CH 1 voz aberta com sinal; CH 2 com fader no -∞ e mutado (fora de uso). */
function ctx(t: number, over: { ch1?: Partial<ChannelView>; ch2?: Partial<ChannelView>; main?: Partial<AlertContext["main"]> } & Partial<Omit<AlertContext, "main">> = {}): AlertContext {
  const { ch1, ch2, main, ...rest } = over;
  return {
    t,
    osc: true,
    meters: true,
    moment: null,
    channels: [
      { index: 1, name: "Pastor", mute: false, faderDb: -5, in: -20, out: -22, ...ch1 },
      { index: 2, name: "", mute: true, faderDb: -144, in: -90, out: -128, ...ch2 },
    ],
    main: { mute: false, out: -15, ...main },
    ...rest,
  };
}
const keys = (u: { raised: { key: string }[] }) => u.raised.map((a) => a.key);

test("tudo normal: nenhum alerta", () => {
  assert.deepEqual(evaluate(ctx(0)), []);
});

test("canal mutado com sinal: só depois de 2 s, crítico, uma vez só", () => {
  const e = new AlertEngine();
  const muted = { ch1: { mute: true, out: -128 } };
  assert.deepEqual(keys(e.update(ctx(0, muted))), []);
  assert.deepEqual(keys(e.update(ctx(L.mutedSignalHoldMs - 1, muted))), []);
  const u = e.update(ctx(L.mutedSignalHoldMs, muted));
  assert.deepEqual(keys(u), ["muted-signal:1"]);
  assert.equal(u.raised[0]!.level, "critical");
  assert.match(u.raised[0]!.title, /CH 1 \(Pastor\)/);
  assert.equal(u.raised[0]!.channel, 1);
  // Continua mutado: não dispara de novo a cada ciclo.
  for (let t = 2250; t < 10_000; t += 250) assert.deepEqual(keys(e.update(ctx(t, muted))), []);
  assert.equal(e.list().length, 1);
});

test("mute com sinal: limite de sinal e fader fechado não alertam", () => {
  const e = new AlertEngine();
  // Sinal no limite (não acima) não conta.
  const atLimit = { ch1: { mute: true, in: L.signalDb } };
  e.update(ctx(0, atLimit));
  assert.deepEqual(keys(e.update(ctx(5000, atLimit))), []);
  // Fader fechado: mutado de propósito.
  const closed = { ch1: { mute: true, faderDb: -144 } };
  e.update(ctx(6000, closed));
  assert.deepEqual(keys(e.update(ctx(12_000, closed))), []);
});

test("sinal que some antes do tempo de espera zera a contagem", () => {
  const e = new AlertEngine();
  const muted = { ch1: { mute: true } };
  e.update(ctx(0, muted));
  e.update(ctx(1500, muted));
  e.update(ctx(1750, { ch1: { mute: true, in: -70 } })); // condição sumiu
  assert.deepEqual(keys(e.update(ctx(2500, muted))), [], "a contagem recomeçou em 2500");
  assert.deepEqual(keys(e.update(ctx(2500 + L.mutedSignalHoldMs - 1, muted))), []);
  assert.deepEqual(keys(e.update(ctx(2500 + L.mutedSignalHoldMs, muted))), ["muted-signal:1"]);
});

test("alerta some quando a condição resolve", () => {
  const e = new AlertEngine();
  const muted = { ch1: { mute: true } };
  e.update(ctx(0, muted));
  e.update(ctx(2000, muted));
  const u = e.update(ctx(2250));
  assert.deepEqual(u.cleared.map((a) => a.key), ["muted-signal:1"]);
  assert.equal(e.list().length, 0);
  assert.deepEqual(e.history().map((h) => h.action), ["raised", "cleared"]);
});

test("dispensado: sai da tela e só volta se a condição sumir e voltar", () => {
  const e = new AlertEngine();
  const muted = { ch1: { mute: true } };
  e.update(ctx(0, muted));
  const [a] = e.update(ctx(2000, muted)).raised;
  assert.equal(e.dismiss(a!.id, 2100)?.key, "muted-signal:1");
  assert.equal(e.dismiss(a!.id), undefined);
  assert.equal(e.list().length, 0);
  assert.deepEqual(keys(e.update(ctx(9000, muted))), []);
  e.update(ctx(9500)); // resolveu
  e.update(ctx(10_000, muted)); // voltou
  assert.deepEqual(keys(e.update(ctx(12_000, muted))), ["muted-signal:1"]);
  assert.deepEqual(e.history().map((h) => h.action), ["raised", "dismissed", "raised"]);
});

test("clip: imediato no limite, aviso, e fica 10 s depois do último pico", () => {
  const e = new AlertEngine();
  assert.deepEqual(keys(e.update(ctx(0, { ch1: { in: L.clipDb - 0.1 } }))), []);
  const u = e.update(ctx(250, { ch1: { in: L.clipDb } }));
  assert.deepEqual(keys(u), ["clip:1"]);
  assert.equal(u.raised[0]!.level, "warning");
  // Novo pico mantém o mesmo alerta (sem repetir) e reinicia a contagem de limpeza.
  assert.deepEqual(keys(e.update(ctx(3000, { ch1: { in: 0 } }))), []);
  assert.equal(e.update(ctx(3000 + L.clipClearMs - 1)).cleared.length, 0);
  assert.deepEqual(e.update(ctx(3000 + L.clipClearMs)).cleared.map((a) => a.key), ["clip:1"]);
});

test("clip conta mesmo com o canal mutado (é a entrada que clipa)", () => {
  assert.deepEqual(evaluate(ctx(0, { ch2: { in: 0 } })).map((c) => c.key), ["clip:2"]);
});

test("canal morto: aberto e sem sinal por 30 s; passos de sem fio e com fio", () => {
  const e = new AlertEngine();
  const dead = { ch1: { in: -80, out: -128 } };
  e.update(ctx(0, dead));
  assert.deepEqual(keys(e.update(ctx(L.deadChannelHoldMs - 1, dead))), []);
  const [a] = e.update(ctx(L.deadChannelHoldMs, dead)).raised;
  assert.equal(a!.key, "dead:1");
  assert.equal(a!.level, "warning");
  assert.match(a!.steps.join(" "), /cabo/);
  // Sem fio pelo nome ou pela configuração.
  const byName = evaluate(ctx(0, { ch1: { in: -80, name: "Pastor sem fio" } }))[0]!;
  assert.match(byName.steps.join(" "), /bateria/);
  const e2 = new AlertEngine({ wirelessChannels: [1] });
  e2.update(ctx(0, dead));
  assert.match(e2.update(ctx(30_000, dead)).raised[0]!.steps.join(" "), /bateria/);
});

test("canal morto: limite de silêncio, canal fechado, pré-culto e canais ignorados", () => {
  const at = (c: Partial<ChannelView>, extra: Partial<AlertContext> = {}) => evaluate(ctx(0, { ch1: c, ...extra })).map((x) => x.key);
  assert.deepEqual(at({ in: L.silentDb }), [], "no limite ainda tem sinal");
  assert.deepEqual(at({ in: -80 }), ["dead:1"]);
  assert.deepEqual(at({ in: -80, mute: true }), [], "mutado");
  assert.deepEqual(at({ in: -80, faderDb: L.openFaderDb }), [], "fader fechado");
  assert.deepEqual(at({ in: -80 }, { moment: "pre" }), [], "pré-culto");
  assert.deepEqual(at({ in: -80 }, { moment: "louvor" }), ["dead:1"]);
  assert.deepEqual(evaluate(ctx(0, { ch1: { in: -80 } }), { ...ALERT_LIMITS, ignoreChannels: [1] }), []);
});

test("main sem sinal com canais abertos: crítico depois de 5 s; sem medidor do main não dispara", () => {
  const e = new AlertEngine();
  const silent = { main: { out: -128, mute: true } };
  e.update(ctx(0, silent));
  assert.deepEqual(keys(e.update(ctx(L.mainSilentHoldMs - 1, silent))), []);
  const [a] = e.update(ctx(L.mainSilentHoldMs, silent)).raised;
  assert.equal(a!.key, "main-silent");
  assert.equal(a!.level, "critical");
  assert.match(a!.steps[0]!, /MUTADO/);
  // Sem canal aberto com sinal na saída, main em silêncio é normal.
  assert.deepEqual(evaluate(ctx(0, { main: { out: -128 }, ch1: { out: -128 } })), []);
  assert.deepEqual(evaluate(ctx(0, { main: { out: null } })), []);
});

test("mesa desconectada: imediato, congela os outros e limpa ao voltar", () => {
  const e = new AlertEngine();
  const muted = { ch1: { mute: true } };
  e.update(ctx(0, muted));
  e.update(ctx(2000, muted));
  const u = e.update(ctx(2250, { osc: false }));
  assert.deepEqual(keys(u), ["disconnected"]);
  assert.equal(u.raised[0]!.level, "critical");
  assert.equal(u.cleared.length, 0, "o alerta do canal fica congelado");
  assert.equal(e.list().length, 2);
  assert.equal(e.list()[0]!.level, "critical");
  assert.deepEqual(keys(e.update(ctx(5000, { meters: false }))), [], "sem repetir");
  assert.match(evaluate(ctx(0, { meters: false }))[0]!.detail, /medidores/);
  // Voltou: some o desconectado; o canal (ainda mutado) continua.
  const back = e.update(ctx(6000, muted));
  assert.deepEqual(back.cleared.map((a) => a.key), ["disconnected"]);
  assert.deepEqual(e.list().map((a) => a.key), ["muted-signal:1"]);
});

test("histórico: limpa ao iniciar outra sessão", () => {
  const e = new AlertEngine();
  e.update(ctx(0, { ch1: { in: 0 } }));
  assert.equal(e.history().length, 1);
  e.resetHistory();
  assert.deepEqual(e.history(), []);
  assert.equal(e.list().length, 1, "o alerta ativo continua");
});

test("janela de picos e contexto a partir dos strips da WING", () => {
  const strips = createStrips();
  const w = new MeterWindow(500);
  strips.ch[0]!.meter = { l: -30, r: -31, in: -10 };
  strips.ch[0]!.mute = true;
  strips.ch[0]!.faderDb = -3;
  strips.main[0]!.meter = { l: -20, r: -25 };
  w.push(1000, strips);
  strips.ch[0]!.meter = { l: -40, r: -40, in: -35 };
  w.push(1300, strips);
  let c = alertContext(1400, strips, w, { lastOscAt: 1300, lastMeterAt: 1300 }, 0, "louvor");
  assert.equal(c.osc && c.meters, true);
  assert.deepEqual(c.channels[0], { index: 1, name: "", mute: true, faderDb: -3, in: -10, out: -30 });
  assert.equal(c.channels[1]!.in, null, "canal sem medidor");
  assert.equal(c.main.out, -20);
  assert.equal(c.moment, "louvor");
  // O pico de 1000 saiu da janela.
  c = alertContext(1600, strips, w, { lastOscAt: 1300, lastMeterAt: 1300 }, 0, null);
  assert.equal(c.channels[0]!.in, -35);
  // Medidores parados e OSC mudo.
  c = alertContext(1300 + L.meterStaleMs, strips, w, { lastOscAt: 1300, lastMeterAt: 1300 }, 0, null);
  assert.equal(c.meters, false);
  c = alertContext(1300 + L.oscTimeoutMs, strips, w, { lastOscAt: 1300, lastMeterAt: null }, 0, null);
  assert.equal(c.osc, false);
  // Logo depois de subir o servidor (sem resposta ainda) não acusa desconexão.
  c = alertContext(2000, strips, new MeterWindow(), { lastOscAt: null, lastMeterAt: null }, 1000, null);
  assert.equal(c.osc && c.meters, true);
});
