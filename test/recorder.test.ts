// Gravação das sessões: início/fim, eventos, medidores a 1 Hz, lista e rotação.
// Usa uma pasta temporária e um relógio falso; não fala com mesa nenhuma.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionError, SessionRecorder, classifyPath, isSessionId } from "../src/recorder.ts";
import { parseNodeDescription } from "../src/schema.ts";
import { createStrips } from "../src/strips.ts";
import type { WingValue } from "../src/osc.ts";

const f = (value: number): WingValue => ({ kind: "float", text: String(value), raw: null, value });
const i = (value: number): WingValue => ({ kind: "int", text: String(value), raw: null, value });

function setup(opts: { keep?: number; maxBytes?: number; maxSessionMs?: number; describe?: (p: string) => Promise<ReturnType<typeof parseNodeDescription>> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mva-rec-"));
  const clock = { t: Date.UTC(2026, 9, 25, 22, 0, 0) };
  const strips = createStrips();
  strips.ch[0]!.name = "Pastor";
  strips.ch[0]!.faderDb = -5;
  strips.ch[0]!.mute = false;
  const con = { host: "127.0.0.1", info: "WING,127.0.0.1,SIMULADOR", connected: true };
  const rec = new SessionRecorder({
    dir, autoTick: false, now: () => clock.t, strips: () => strips, console: () => con, describeGapMs: 0, channels: 2, ...opts,
  });
  const lines = (id: string) => rec.read(id).trim().split("\n").map((l) => JSON.parse(l));
  return { dir, clock, strips, con, rec, lines, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("caminhos gravados por categoria (e os que ficam de fora)", () => {
  assert.equal(classifyPath("/ch/3/fdr"), "fader");
  assert.equal(classifyPath("/main/1/fdr"), "fader");
  assert.equal(classifyPath("/mgrp/2/mute"), "mute");
  assert.equal(classifyPath("/ch/3/$solo"), "solo");
  assert.equal(classifyPath("/ch/3/in/set/$g"), "gain");
  assert.equal(classifyPath("/io/in/A/7/g"), "gain");
  assert.equal(classifyPath("/ch/3/eq/2g"), "eq");
  assert.equal(classifyPath("/ch/3/flt/lcf"), "eq");
  assert.equal(classifyPath("/ch/3/gate/thr"), "dyn");
  assert.equal(classifyPath("/ch/3/dyn/ratio"), "dyn");
  assert.equal(classifyPath("/ch/3/col"), null);
  assert.equal(classifyPath("/ch/3/send/1/lvl"), null);
  assert.equal(classifyPath("/cfg/foo"), null);
});

test("início e fim: arquivo por culto com sessão, snapshot e fim", () => {
  const { rec, clock, lines, done } = setup();
  try {
    assert.equal(rec.current, null);
    const a = rec.start("  Jocsan  ", "louvor");
    assert.equal(a.operator, "Jocsan");
    assert.equal(a.moment, "louvor");
    assert.ok(isSessionId(a.id));
    assert.match(a.id, /^culto-\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d$/);
    assert.throws(() => rec.start("Outro", "pre"), (e) => e instanceof SessionError && e.code === 409);
    clock.t += 90_000;
    const s = rec.stop();
    assert.equal(s.durationMs, 90_000);
    assert.equal(s.ended, true);
    assert.equal(rec.current, null);
    assert.throws(() => rec.stop(), SessionError);

    const ev = lines(a.id);
    assert.equal(ev[0].type, "session");
    assert.equal(ev[0].operator, "Jocsan");
    assert.equal(ev[0].moment, "louvor");
    assert.equal(ev[0].console, "WING,127.0.0.1,SIMULADOR");
    assert.equal(ev[1].type, "snapshot");
    assert.deepEqual(ev[1].strips.ch[0], { n: 1, name: "Pastor", fdr: -5, mute: false });
    assert.equal(ev.at(-1).type, "session-end");
    assert.equal(ev.at(-1).durationMs, 90_000);
  } finally {
    done();
  }
});

test("início recusa operador vazio, nome longo e momento inválido", () => {
  const { rec, done } = setup();
  try {
    assert.throws(() => rec.start("   ", "pre"), /nome/);
    assert.throws(() => rec.start("x".repeat(41), "pre"), /40/);
    assert.throws(() => rec.start("Ana", "ensaio"), /Momento inválido/);
    assert.equal(rec.current, null);
  } finally {
    done();
  }
});

test("eventos: mudanças com valor anterior, sem repetir valor igual, e momento", () => {
  const { rec, clock, lines, done } = setup();
  try {
    // Antes de gravar: o gravador já acompanha os valores, mas não grava.
    rec.onOsc("/ch/1/fdr", f(-5));
    rec.onOsc("/ch/1/mute", i(0));
    const { id } = rec.start("Ana", "pre");
    clock.t += 1000;
    rec.onOsc("/ch/1/fdr", f(-3.456));
    rec.onOsc("/ch/1/fdr", f(-3.456)); // igual: não grava de novo
    rec.onOsc("/ch/1/mute", i(1));
    rec.onOsc("/ch/1/$solo", i(1));
    rec.onOsc("/ch/1/in/set/$g", f(22.5));
    rec.onOsc("/ch/1/eq/2g", f(3));
    rec.onOsc("/ch/1/dyn/ratio", { kind: "string", text: "4.0" });
    rec.onOsc("/ch/1/col", i(3)); // fora da lista
    rec.onOsc("/ch/1/eq", { kind: "string", text: "on 1 int\nmdl STD list" }); // descrição de nó
    rec.setMoment("pregacao");
    rec.setMoment("pregacao"); // mesmo momento: nada
    rec.note({ type: "alert", action: "raised", key: "muted-signal:1", level: "critical", title: "CH 1 está mutado" });
    assert.throws(() => rec.setMoment("show"), SessionError);
    rec.stop();

    const changes = lines(id).filter((e) => e.type === "change");
    assert.deepEqual(changes.map((e) => [e.cat, e.path, e.v, e.prev]), [
      ["fader", "/ch/1/fdr", -3.46, -5],
      ["mute", "/ch/1/mute", 1, 0],
      ["solo", "/ch/1/$solo", 1, undefined],
      ["gain", "/ch/1/in/set/$g", 22.5, undefined],
      ["eq", "/ch/1/eq/2g", 3, undefined],
      ["dyn", "/ch/1/dyn/ratio", "4.0", undefined],
    ]);
    assert.ok(changes.every((e) => e.t === clock.t));
    const moments = lines(id).filter((e) => e.type === "moment");
    assert.deepEqual(moments.map((e) => [e.moment, e.prev]), [["pregacao", "pre"]]);
    // Fora de gravação nada é escrito (nem mudanças, nem eventos de outras partes, como alertas).
    rec.onOsc("/ch/1/fdr", f(0));
    rec.note({ type: "alert", action: "raised", key: "clip:1" });
    assert.equal(lines(id).filter((e) => e.type === "change").length, 6);
    const alertLines = lines(id).filter((e) => e.type === "alert");
    assert.deepEqual(alertLines.map((e) => [e.action, e.key, e.t]), [["raised", "muted-signal:1", clock.t]]);
  } finally {
    done();
  }
});

test("medidores: pico de cada segundo, por tipo, e mudança de conexão", () => {
  const { rec, clock, strips, con, lines, done } = setup();
  try {
    const { id } = rec.start("Ana", "louvor");
    for (const [l, r] of [[-30, -32], [-12.34, -40], [-20, -18]] as const) {
      strips.ch[0]!.meter = { l, r };
      strips.main[0]!.meter = { l: l - 6, r: r - 6 };
      rec.onMeters(strips);
      clock.t += 300;
    }
    rec.tick();
    strips.ch[0]!.meter = { l: -50, r: -50 };
    rec.onMeters(strips);
    con.connected = false;
    rec.tick();
    rec.tick(); // sem quadros novos e sem mudança: nada
    rec.stop();
    const ev = lines(id);
    const meters = ev.filter((e) => e.type === "meters");
    assert.equal(meters.length, 2);
    assert.equal(meters[0].ch[0], -12.3);
    assert.equal(meters[0].main[0], -18.3);
    assert.equal(meters[0].ch[1], null, "strip sem medidor");
    assert.equal(meters[0].ch.length, 40);
    assert.deepEqual(Object.keys(meters[0]).filter((k) => k !== "type" && k !== "t"), ["ch", "aux", "bus", "main", "mtx", "dca"]);
    assert.equal(meters[1].ch[0], -50);
    assert.deepEqual(ev.filter((e) => e.type === "conn").map((e) => e.connected), [false]);
  } finally {
    done();
  }
});

test("processamento inicial: EQ, filtro, gate e compressor de cada canal (só descrição)", async () => {
  const asked: string[] = [];
  const describe = async (path: string) => {
    asked.push(path);
    return parseNodeDescription(`  on             1               int [0 .. 1]\n  thr            -20.0           lin [-60.0 .. 0.0 dB], 121 steps\n  mdl            STD             list [STD, SOUL]`);
  };
  const { rec, clock, lines, done } = setup({ describe });
  try {
    const { id } = rec.start("Ana", "pre");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(asked, ["/ch/1/eq", "/ch/1/flt", "/ch/1/gate", "/ch/1/dyn", "/ch/2/eq", "/ch/2/flt", "/ch/2/gate", "/ch/2/dyn"]);
    // O valor lido vira a base: um GET com o mesmo valor não é mudança; outro valor é.
    clock.t += 500;
    rec.onOsc("/ch/1/gate/thr", f(-20));
    rec.onOsc("/ch/1/dyn/thr", f(-25));
    rec.stop();
    const ev = lines(id);
    const proc = ev.filter((e) => e.type === "proc");
    assert.equal(proc.length, 2);
    assert.deepEqual(proc[0].gate, { on: "1", thr: "-20.0", mdl: "STD" });
    assert.deepEqual(ev.filter((e) => e.type === "change").map((e) => [e.path, e.v, e.prev]), [["/ch/1/dyn/thr", -25, -20]]);
  } finally {
    done();
  }
});

test("lista: data, operador e duração; sessão interrompida sem fim usa o último evento", () => {
  const { rec, clock, dir, done } = setup();
  try {
    const a = rec.start("Ana", "pre");
    assert.equal(rec.list()[0]!.active, true);
    clock.t += 60_000;
    rec.stop();
    clock.t += 3600_000;
    const b = rec.start("Bruno", "louvor");
    clock.t += 30_000;
    rec.stop();
    // Arquivo de um servidor que caiu: sem session-end e com a última linha pela metade.
    const t0 = Date.UTC(2026, 9, 18, 22, 0, 0);
    writeFileSync(join(dir, "culto-2026-10-18_19-00-00.jsonl"),
      `${JSON.stringify({ type: "session", t: t0, date: new Date(t0).toISOString(), operator: "Caio", moment: "pre" })}\n` +
      `${JSON.stringify({ type: "meters", t: t0 + 45_000, ch: [] })}\n{"type":"met`);
    const list = rec.list();
    assert.deepEqual(list.map((s) => s.id), [b.id, a.id, "culto-2026-10-18_19-00-00"]);
    assert.deepEqual(list.map((s) => s.operator), ["Bruno", "Ana", "Caio"]);
    assert.deepEqual(list.map((s) => s.durationMs), [30_000, 60_000, 45_000]);
    assert.deepEqual(list.map((s) => s.ended), [true, true, false]);
    assert.ok(list.every((s) => !s.active && s.bytes > 0));
    assert.equal(list[0]!.date, new Date(clock.t - 30_000).toISOString());
  } finally {
    done();
  }
});

test("leitura: só ids de sessão válidos, sem sair da pasta", () => {
  const { rec, done } = setup();
  try {
    assert.throws(() => rec.read("../package"), (e) => e instanceof SessionError && e.code === 400);
    assert.throws(() => rec.read("culto-2026-01-01_00-00-00"), (e) => e instanceof SessionError && e.code === 404);
  } finally {
    done();
  }
});

test("rotação: guarda as últimas N sessões e respeita o tamanho máximo", () => {
  const { rec, clock, dir, done } = setup({ keep: 3 });
  try {
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) {
      ids.push(rec.start(`Op ${n}`, "pre").id);
      clock.t += 60_000;
      rec.stop();
    }
    assert.deepEqual(readdirSync(dir).sort(), ids.slice(2).map((id) => `${id}.jsonl`));
    // Outros arquivos da pasta não são tocados.
    writeFileSync(join(dir, "notas.txt"), "x");
    assert.deepEqual(rec.rotate(), []);
    assert.ok(readdirSync(dir).includes("notas.txt"));
  } finally {
    done();
  }
  const small = setup({ maxBytes: 1 });
  try {
    const first = small.rec.start("A", "pre").id;
    small.clock.t += 60_000;
    small.rec.stop();
    const second = small.rec.start("B", "pre").id;
    // A sessão em andamento nunca é apagada, mesmo passando do limite.
    assert.deepEqual(readdirSync(small.dir), [`${second}.jsonl`]);
    assert.notEqual(first, second);
    small.rec.stop();
  } finally {
    small.done();
  }
});

test("duas sessões no mesmo segundo ganham arquivos diferentes; limite de duração encerra sozinho", () => {
  const { rec, clock, lines, done } = setup({ maxSessionMs: 5000 });
  try {
    const a = rec.start("A", "pre").id;
    rec.stop();
    const b = rec.start("B", "pre").id;
    assert.equal(b, `${a}-2`);
    assert.ok(isSessionId(b));
    clock.t += 5000;
    rec.tick();
    assert.equal(rec.current, null);
    assert.equal(lines(b).at(-1).reason, "limite de duração");
  } finally {
    done();
  }
});
