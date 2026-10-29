// Interface (public/index.html): funções puras do bloco <script id="mixer-lib"> e estrutura da página.
// O bloco é JavaScript puro sem DOM, então roda aqui igual roda no navegador.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const libSrc = /<script id="mixer-lib">([\s\S]*?)<\/script>/.exec(html)?.[1];
assert.ok(libSrc, "bloco mixer-lib não encontrado");
const lib = new Function(`${libSrc}; return MixerLib;`)();

test("medidor: -60..0 dBFS em 0..100%, zonas verde, âmbar e vermelha", () => {
  assert.equal(lib.meterPct(-60), 0);
  assert.equal(lib.meterPct(-128), 0);
  assert.equal(lib.meterPct(0), 100);
  assert.equal(lib.meterPct(6), 100);
  assert.equal(lib.meterPct(-30), 50);
  assert.equal(lib.meterPct(null), 0);
  assert.equal(lib.meterPct(undefined), 0);
  assert.equal(lib.meterZone(-30), "green");
  assert.equal(lib.meterZone(-18), "amber");
  assert.equal(lib.meterZone(-7), "amber");
  assert.equal(lib.meterZone(-6), "red");
  // O degradê do CSS muda de cor exatamente nas zonas (70% = -18 dB, 90% = -6 dB).
  assert.equal(lib.meterPct(lib.ZONES.amber), 70);
  assert.equal(lib.meterPct(lib.ZONES.red), 90);
  assert.match(html, /var\(--m-green\) 0 70%, var\(--m-amber\) 70% 90%, var\(--m-red\) 90%/);
});

test("pico retido: segura, depois cai, e um pico maior substitui", () => {
  let pk = lib.peakStep(null, -10, 0);
  assert.deepEqual(pk, { db: -10, t: 0 });
  pk = lib.peakStep(pk, -30, 1000); // sinal caiu: o pico fica
  assert.equal(lib.peakValue(pk, 1000), -10);
  assert.equal(lib.peakValue(pk, lib.PEAK_HOLD_MS), -10);
  // 1 s depois do fim da retenção: caiu PEAK_DECAY_DB_S dB.
  assert.equal(lib.peakValue(pk, lib.PEAK_HOLD_MS + 1000), -10 - lib.PEAK_DECAY_DB_S);
  pk = lib.peakStep(pk, -5, 1200); // pico maior
  assert.deepEqual(pk, { db: -5, t: 1200 });
  // Quando o pico em queda encontra o sinal, passa a acompanhar o sinal.
  const late = lib.peakStep({ db: -10, t: 0 }, -40, 4000);
  assert.deepEqual(late, { db: -40, t: 4000 });
  assert.equal(lib.peakValue(null, 0), -Infinity);
});

test("lei do fader: posição <-> dB, ida e volta e pontos conhecidos", () => {
  assert.equal(lib.dbToPos(-144), 0);
  assert.equal(lib.dbToPos(null), 0);
  assert.equal(lib.dbToPos(10), 1);
  assert.equal(lib.dbToPos(-10), 0.5);
  assert.equal(lib.posToDb(0), -144);
  assert.equal(lib.posToDb(1), 10);
  assert.equal(lib.posToDb(0.5), -10);
  for (const db of [-80, -60, -45, -30, -20, -10, -5, 0, 5, 10]) {
    assert.ok(Math.abs(lib.posToDb(lib.dbToPos(db)) - db) < 0.11, `ida e volta de ${db} dB`);
  }
  let last = -1;
  for (let db = -90; db <= 10; db += 0.5) {
    const p = lib.dbToPos(db);
    assert.ok(p > last, `posição cresce com o dB (${db})`);
    last = p;
  }
});

test("camadas: bancos de 8 strips por tipo", () => {
  const kinds = [
    { kind: "ch", count: 40 }, { kind: "aux", count: 8 }, { kind: "bus", count: 16 }, { kind: "main", count: 4 },
    { kind: "mtx", count: 8 }, { kind: "dca", count: 16 }, { kind: "mgrp", count: 8 },
  ];
  const b = lib.banks(kinds);
  assert.deepEqual(b.map((x: { label: string }) => x.label), [
    "CH 1–8", "CH 9–16", "CH 17–24", "CH 25–32", "CH 33–40", "AUX", "BUS 1–8", "BUS 9–16", "MAIN", "MTX", "DCA 1–8", "DCA 9–16", "MGRP",
  ]);
  assert.deepEqual(b[4], { id: "ch:33", kind: "ch", start: 33, end: 40, label: "CH 33–40" });
  assert.deepEqual(b[8], { id: "main:1", kind: "main", start: 1, end: 4, label: "MAIN" });
  assert.equal(new Set(b.map((x: { id: string }) => x.id)).size, b.length);
});

test("OVERVIEW: entradas agrupadas pela cor, na ordem da primeira aparição, sem cor no fim", () => {
  const st = (index: number, col: number | null) => ({ kind: "ch", index, col });
  const groups = lib.colorGroups([st(1, 3), st(2, null), st(3, 5), st(4, 3), st(5, 5), st(6, 2)]);
  assert.deepEqual(groups.map((g: { col: number }) => g.col), [3, 5, 2, 0]);
  assert.deepEqual(groups[0].items.map((s: { index: number }) => s.index), [1, 4]);
  assert.deepEqual(groups[1].items.map((s: { index: number }) => s.index), [3, 5]);
  assert.deepEqual(groups[3].items.map((s: { index: number }) => s.index), [2]);
});

test("valores digitados: dB e pan", () => {
  assert.equal(lib.parseDb("-5"), -5);
  assert.equal(lib.parseDb("+3,25 dB"), 3.3);
  assert.equal(lib.parseDb("-inf"), -144);
  assert.equal(lib.parseDb("-∞"), -144);
  assert.ok(Number.isNaN(lib.parseDb("alto")));
  assert.equal(lib.parsePan("L30"), -30);
  assert.equal(lib.parsePan("r 20"), 20);
  assert.equal(lib.parsePan("C"), 0);
  assert.equal(lib.parsePan("-15"), -15);
  assert.ok(Number.isNaN(lib.parsePan("meio")));
  assert.equal(lib.fmtPan(-30.2), "L30");
  assert.equal(lib.fmtPan(0.3), "C");
  assert.equal(lib.fmtNum(-144), "-∞");
  assert.equal(lib.fmtNum(null), "—");
  assert.equal(lib.fmtDb(3), "+3.0 dB");
});

test("página: as abas, Rápido/Completo e ids usados pelo script existem", () => {
  const tabs = [...html.matchAll(/<button type="button" role="tab" data-tab="(\w+)">([^<]+)<\/button>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(tabs, [
    ["faders", "FADERS"], ["gain", "GAIN"], ["eq", "EQ"], ["dyn", "GATE/COMP"], ["sends", "SENDS"], ["overview", "OVERVIEW"], ["rec", "SESSÕES"],
  ]);
  assert.match(html, /id="ui-quick"/);
  assert.match(html, /id="ui-full"/);
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...html.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]));
  for (const id of used) assert.ok(ids.has(id), `elemento #${id} não existe`);
});

test("página: só usa rotas que o servidor já tem", async () => {
  const server = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
  // Começo literal de cada URL pedida pela página (fetch, postJson, EventSource, import).
  const urls = [...html.matchAll(/(?:fetch|postJson|EventSource|import)\(\s*[`"]([^`"$?]+)/g)].map((m) => m[1]!);
  assert.ok(urls.length >= 8);
  const known = ["/api/risk", "/api/param", "/api/sends", "/api/state", "/api/events", "/api/channels/", "/api/sessions", "/api/sessions/", "/api/alerts", "/api/alerts/dismiss", "/eq-curve.js"];
  for (const u of urls) {
    assert.ok(known.some((k) => u === k || (k.endsWith("/") && u.startsWith(k))), `rota desconhecida: ${u}`);
  }
  // Rotas com número entram no servidor como regex (/^\/api\/channels\/...).
  for (const k of known) {
    const base = k.replace(/\/$/, "");
    assert.ok(server.includes(base) || server.includes(base.replaceAll("/", "\\/")), `servidor não tem ${k}`);
  }
});

test("página: modo Rápido esconde só parâmetros secundários (tudo continua no Completo)", () => {
  assert.match(html, /body\.quick \.full-only/);
  // LPF, Q, tipo de banda, inclinação, modelo da dinâmica, pan, cor e pré/pós ficam no Completo.
  assert.match(html, /class="eq-card full-only" id="eq-lpf"/);
  assert.match(html, /rows\[2\]\.el\.classList\.add\("full-only"\)/);
  assert.match(html, /shapeSeg\.el\.classList\.add\("full-only"\)/);
  assert.match(html, /slope\.el\.classList\.add\("full-only"\)/);
  assert.match(html, /m\.el\.classList\.add\("full-only"\)/);
  assert.match(html, /class="knob full-only"><span class="k-l">PAN/);
  assert.match(html, /class="s-col full-only"/);
  assert.match(html, /class="tbtn sc-mode full-only"/);
});

test("sessão gravada: registro legível a partir do JSONL", () => {
  const t0 = Date.UTC(2026, 9, 25, 22, 0, 0);
  const lines = [
    { type: "session", t: t0, operator: "Ana", moment: "pre", console: "WING,SIM" },
    { type: "snapshot", t: t0, strips: { ch: [{ n: 1, name: "Pastor", fdr: -5, mute: true }, { n: 2 }], main: [{ n: 1, fdr: 0 }] } },
    { type: "proc", t: t0, ch: 1, eq: { on: "1" }, gate: { thr: "-40.0" } },
    { type: "meters", t: t0 + 1000, ch: [-12.3, null, -120] },
    { type: "change", t: t0 + 65_000, cat: "fader", path: "/ch/1/fdr", v: -3.5, prev: -5 },
    { type: "change", t: t0 + 66_000, cat: "mute", path: "/ch/1/mute", v: 0, prev: 1 },
    { type: "change", t: t0 + 67_000, cat: "eq", path: "/ch/1/eq/2g", v: 3 },
    { type: "change", t: t0 + 68_000, cat: "gain", path: "/io/in/A/7/g", v: 22.5, prev: 20 },
    { type: "moment", t: t0 + 70_000, moment: "louvor", prev: "pre" },
    { type: "conn", t: t0 + 71_000, connected: false },
    { type: "alert", t: t0 + 71_000, action: "raised", key: "disconnected", level: "critical", title: "Mesa desconectada" },
    { type: "alert", t: t0 + 80_000, action: "cleared", key: "disconnected", level: "critical", title: "Mesa desconectada" },
    { type: "alert", t: t0 + 81_000, action: "dismissed", key: "clip:2", level: "warning", title: "CH 2 está clipando" },
    { type: "session-end", t: t0 + 3_725_000, durationMs: 3_725_000, reason: "operador" },
  ].map((e) => JSON.stringify(e)).join("\n") + '\n{"type":"cha';
  const moments = { pre: "Pré-culto", louvor: "Louvor" };
  const out: string[] = lib.sessionLog(lines, { moments });
  const body = (l: string) => l.slice(20).trimEnd();
  assert.deepEqual(out.map(body), [
    "INÍCIO     operador: Ana · momento: Pré-culto · mesa: WING,SIM",
    "ESTADO     2 strips lidos da mesa no início:",
    "           CH 1 Pastor           -5.0 dB · MUTE",
    "PROC       CH 1 Pastor · eq: on=1 | gate: thr=-40.0",
    "FADER      CH 1 Pastor  -5.0 dB → -3.5 dB",
    "MUTE       CH 1 Pastor  ligado → desligado",
    "EQ         CH 1 Pastor eq/2g  3",
    "GANHO      ENTRADA A 7  +20.0 dB → +22.5 dB",
    "MOMENTO    Pré-culto → Louvor",
    "MESA       desconectada (sem resposta OSC)",
    "ALERTA     CRÍTICO · Mesa desconectada · disparou",
    "ALERTA     CRÍTICO · Mesa desconectada · resolvido",
    "ALERTA     AVISO · CH 2 está clipando · dispensado",
    "FIM        duração 1:02:05 · motivo: operador",
    '(linha incompleta) {"type":"cha',
  ]);
  assert.match(out[4]!, /^\d\d:\d\d:\d\d \+0:01:05/);
  const withMeters: string[] = lib.sessionLog(lines, { moments, meters: true });
  assert.ok(withMeters.some((l) => body(l) === "MEDIDORES  CH1 -12"));
  assert.equal(lib.fmtDur(null), "—");
  assert.equal(lib.fmtDur(59_600), "0:01:00");
});
