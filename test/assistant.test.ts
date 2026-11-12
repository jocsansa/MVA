// Assistente de ganho: regras, modos (desligado, sugestivo, automático) e limites do automático.
// Funções puras: nada aqui fala com a mesa.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSIST_LIMITS, Assistant, gainProposal, unmuteProposal, type AssistChannel, type AssistContext, type PlannedWrite } from "../src/assistant.ts";

const L = ASSIST_LIMITS;

function chan(over: Partial<AssistChannel> = {}): AssistChannel {
  return { index: 3, name: "Voz 1", mute: false, faderDb: -5, gainDb: 30, trimDb: 0, in: -20, ...over };
}
const ctx = (t: number, ch: Partial<AssistChannel> = {}, connected = true): AssistContext => ({ t, connected, channels: [chan(ch)] });

const gainWrite = (from: number, to: number): PlannedWrite =>
  ({ kind: "gain", channel: 3, path: "/io/in/LCL/3/g", from, to, label: "" });

test("clip: propõe baixar o ganho até o pico alvo, neutro no volume", () => {
  const p = gainProposal(chan(), 0, { hot: [], low: [], lowSpan: 0 });
  assert.ok(p);
  assert.equal(p.kind, "gain-down");
  assert.equal(p.deltaDb, L.targetPeakDb); // de 0 dBFS até o alvo
  assert.match(p.title, /CH 3 \(Voz 1\) clipando/);
  assert.match(p.detail, /trim/);
});

test("quente: só com picos repetidos na janela; passo mínimo respeitado", () => {
  const hot = [{ max: -3 }, { max: -20 }, { max: -4 }, { max: -2 }];
  const p = gainProposal(chan(), -15, { hot, low: [], lowSpan: 0 });
  assert.equal(p?.kind, "gain-down");
  assert.equal(p?.deltaDb, -(-2 - L.targetPeakDb));
  assert.equal(gainProposal(chan(), -15, { hot: hot.slice(0, 2), low: [], lowSpan: 0 }), null, "um pico só não basta");
  const barely = [{ max: -4.9 }, { max: -4.9 }, { max: -4.9 }];
  const d = gainProposal(chan(), -15, { hot: barely, low: [], lowSpan: 0 })?.deltaDb ?? 0;
  assert.ok(Math.abs(d - (-4.9 - L.targetPeakDb) * -1) < 1e-9, `delta ${d}`);
  const cool = [{ max: -5.1 }, { max: -5.1 }, { max: -5.1 }];
  assert.equal(gainProposal(chan(), -15, { hot: cool, low: [], lowSpan: 0 }), null, "abaixo do limite de quente");
});

test("fraco: precisa de janela cheia e sinal na maior parte do tempo; passo limitado", () => {
  const low = Array.from({ length: 60 }, () => ({ max: -40 }));
  const p = gainProposal(chan(), -40, { hot: [], low, lowSpan: 60 });
  assert.equal(p?.kind, "gain-up");
  assert.equal(p?.deltaDb, L.maxStepUpDb); // precisaria de 28 dB, o passo é limitado
  assert.equal(gainProposal(chan(), -40, { hot: [], low, lowSpan: 30 }), null, "janela incompleta");
  const quiet = Array.from({ length: 60 }, (_, i) => ({ max: i < 30 ? -40 : -70 }));
  assert.equal(gainProposal(chan(), -40, { hot: [], low: quiet, lowSpan: 60 }), null, "silêncio em metade do tempo");
});

test("sem ganho conhecido não propõe nada", () => {
  assert.equal(gainProposal(chan({ gainDb: null }), 0, { hot: [], low: [], lowSpan: 0 }), null);
});

test("desmutar: só mutado, fader aberto e sinal; nunca automático por padrão", () => {
  assert.equal(unmuteProposal(chan({ mute: true }))?.autoAllowed, false);
  assert.equal(unmuteProposal(chan({ mute: true, faderDb: -144 })), null);
  assert.equal(unmuteProposal(chan({ mute: true, in: -70 })), null);
  assert.equal(unmuteProposal(chan({ mute: false })), null);
});

test("modo sugestivo: cria uma sugestão, não aplica sozinho e não duplica", () => {
  const a = new Assistant({ mode: "suggest" });
  const u = a.update(ctx(1000, { in: 0 }));
  assert.equal(u.created.length, 1);
  assert.equal(u.toApply.length, 0);
  assert.equal(a.update(ctx(1250, { in: 0 })).created.length, 0);
  assert.equal(a.list()[0]!.status, "pending");
});

test("modo desligado: nada é proposto e pendentes saem", () => {
  const a = new Assistant({ mode: "suggest" });
  a.update(ctx(1000, { in: 0 }));
  a.setMode("off", 1100);
  assert.equal(a.list()[0]!.status, "expired");
  assert.equal(a.update(ctx(2000, { in: 0 })).created.length, 0);
});

test("modo automático: aplica o permitido; desmutar continua pedindo OK", () => {
  const a = new Assistant({ mode: "auto" });
  const u = a.update({ t: 1000, connected: true, channels: [chan({ in: 0 }), chan({ index: 5, mute: true })] });
  assert.equal(u.toApply.length, 1);
  assert.equal(u.toApply[0]!.kind, "gain-down");
  assert.equal(u.toApply[0]!.by, "auto");
  // O mutado só vira sugestão depois do tempo de espera, e fica pendente.
  const later = a.update({ t: 1000 + L.mutedSignalHoldMs, connected: true, channels: [chan({ index: 5, mute: true })] });
  assert.equal(later.created[0]?.kind, "unmute");
  assert.equal(later.toApply.length, 0);
});

test("automático: teto por canal e cooldown depois de aplicar", () => {
  const a = new Assistant({ mode: "auto", limits: { autoMaxTotalDb: 15 } });
  const s = a.update(ctx(1000, { in: 0 })).toApply[0]!;
  a.finishApply(s.id, { ok: true, writes: [gainWrite(30, 18)], commands: [] }, 1100);
  // Em cooldown: nada novo, mesmo clipando.
  assert.equal(a.update(ctx(2000, { in: 0, gainDb: 18 })).created.length, 0);
  // Depois do cooldown: propõe de novo, mas 12 + 12 passa do teto de 15 → fica pedindo OK.
  const u = a.update(ctx(1100 + L.cooldownMs, { in: 0, gainDb: 18 }));
  assert.equal(u.created.length, 1);
  assert.equal(u.toApply.length, 0);
  assert.equal(a.list().find((x) => x.status === "pending")?.kind, "gain-down");
});

test("automático: no máximo N ações por minuto", () => {
  const a = new Assistant({ mode: "auto", limits: { autoMaxPerMin: 2 } });
  const chs = [1, 2, 3].map((i) => chan({ index: i, in: 0 }));
  const u = a.update({ t: 1000, connected: true, channels: chs });
  assert.equal(u.toApply.length, 2);
  assert.equal(a.list().filter((s) => s.status === "pending").length, 1);
  assert.equal(a.update({ t: 61_001, connected: true, channels: [] }).toApply.length, 1, "um minuto depois sai a terceira");
});

test("ganho mudado na mesa resolve a sugestão pendente", () => {
  const a = new Assistant({ mode: "suggest" });
  a.update(ctx(1000, { in: 0 }));
  a.update(ctx(1250, { in: -20, gainDb: 27.5 }));
  assert.equal(a.history().at(-1)?.status, "resolved");
});

test("ignorar: não volta durante o tempo de dispensa", () => {
  const a = new Assistant({ mode: "suggest" });
  const s = a.update(ctx(1000, { in: 0 })).created[0]!;
  a.dismiss(s.id, 1100);
  assert.equal(a.update(ctx(2000, { in: 0 })).created.length, 0);
  assert.equal(a.update(ctx(1100 + L.dismissMs, { in: 0 })).created.length, 1);
});

test("operador dá OK: aplicando → aplicada; falha impossível não insiste", () => {
  const a = new Assistant({ mode: "suggest" });
  const s = a.update(ctx(1000, { in: 0 })).created[0]!;
  a.beginApply(s.id, 1100);
  assert.throws(() => a.beginApply(s.id, 1100), /não está pendente/);
  a.finishApply(s.id, { ok: false, error: "fonte USB", unavailable: true }, 1200);
  assert.equal(a.get(s.id)?.status, "unavailable");
  assert.equal(a.update(ctx(1200 + L.cooldownMs, { in: 0 })).created.length, 0);
});

test("sem conexão com a mesa nada é proposto", () => {
  const a = new Assistant({ mode: "auto" });
  assert.equal(a.update(ctx(1000, { in: 0 }, false)).created.length, 0);
});

test("medidor depois do trim: desconta o trim antes de julgar o clip", () => {
  const a = new Assistant({ mode: "suggest", limits: { inputMeterPostTrim: true } });
  // Medidor em 0 com trim +12: no conversor está em -12, sem clip.
  assert.equal(a.update(ctx(1000, { in: 0, trimDb: 12 })).created.length, 0);
});

test("mudou de direção: 'fraco' pendente sai quando o canal clipa", () => {
  const a = new Assistant({ mode: "suggest", limits: { lowWindowS: 3, lowActiveS: 2 } });
  let t = 1000;
  for (; t < 6000; t += 250) a.update(ctx(t, { in: -40 }));
  assert.equal(a.list().find((s) => s.status === "pending")?.kind, "gain-up");
  const u = a.update(ctx(t, { in: 0 }));
  assert.equal(u.created[0]?.kind, "gain-down");
  assert.equal(a.list().filter((s) => s.status === "pending").length, 1);
  assert.ok(a.history().some((h) => h.status === "resolved"));
});

test("'subir' pendente que ficou perigoso (sinal cresceu) sai", () => {
  const a = new Assistant({ mode: "suggest", limits: { lowWindowS: 3, lowActiveS: 2 } });
  let t = 1000;
  for (; t < 6000; t += 250) a.update(ctx(t, { in: -40 }));
  const up = a.list().find((s) => s.status === "pending")!;
  a.update(ctx(t, { in: -15 })); // -15 + 10 = -5 dBFS, acima do alvo + 3 (-9)
  assert.equal(a.get(up.id)?.status, "resolved");
});

test("falha ao aplicar: espera antes de propor de novo (o automático não fica repetindo)", () => {
  const a = new Assistant({ mode: "auto" });
  const s = a.update(ctx(1000, { in: 0 })).toApply[0]!;
  a.finishApply(s.id, { ok: false, error: "leitura de volta" }, 1100);
  assert.equal(a.update(ctx(1350, { in: 0 })).created.length, 0);
  assert.equal(a.update(ctx(1100 + L.cooldownMs + 1, { in: 0 })).created.length, 0, "ainda no failRetryMs");
  assert.equal(a.update(ctx(1100 + L.failRetryMs, { in: 0 })).toApply.length, 1);
});

test("operador mexeu no ganho: espera os medidores assentarem antes de propor", () => {
  const a = new Assistant({ mode: "auto" });
  a.update(ctx(1000, { in: -20, gainDb: 30 }));
  // Baixou 6 dB na mesa, mas a janela curta ainda mostra o pico de antes.
  const u = a.update(ctx(1250, { in: 0, gainDb: 24 }));
  assert.equal(u.created.length, 0);
  assert.equal(a.update(ctx(1250 + L.cooldownMs, { in: 0, gainDb: 24 })).created.length, 1);
});

test("baixou o ganho: aumento automático depois vira só sugestão", () => {
  const a = new Assistant({ mode: "auto", limits: { lowWindowS: 3, lowActiveS: 2 } });
  const s = a.update(ctx(1000, { in: 0 })).toApply[0]!;
  a.finishApply(s.id, { ok: true, writes: [gainWrite(30, 18)], commands: [] }, 1000);
  let t = 1000 + L.cooldownMs;
  let created;
  for (; t < 1000 + L.cooldownMs + 6000; t += 250) {
    const u = a.update(ctx(t, { in: -40, gainDb: 18 }));
    if (u.created.length) { created = u; break; }
  }
  assert.equal(created?.created[0]?.kind, "gain-up");
  assert.equal(created?.toApply.length, 0);
});
