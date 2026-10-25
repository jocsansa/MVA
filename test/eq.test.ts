import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EQ_BANDS,
  SECTION_PARAMS,
  descValue,
  eqParamPath,
  readChannelEq,
  sectionState,
  writeChannelEq,
} from "../src/eq.ts";
import { parseNodeDescription, readBackMatches, riskWarning, type ParamDesc } from "../src/schema.ts";
import { WingClient } from "../src/wing.ts";
import { bandDb, cutDb, logFreqs, quantize, responseDb } from "../public/eq-curve.js";
import { fakeWing } from "./fake-wing.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), "utf8");
const EQ_DESC = { "/ch/1/eq": fixture("ch_1_eq"), "/ch/1/flt": fixture("ch_1_flt") };
const param = (text: string, name: string) => parseNodeDescription(text).find((c) => c.name === name) as ParamDesc;

async function withClient(
  initial: Record<string, string | number>,
  fn: (c: WingClient, fake: Awaited<ReturnType<typeof fakeWing>>) => Promise<void>,
  allowWrites = true,
) {
  const fake = await fakeWing(initial, EQ_DESC);
  const client = new WingClient("127.0.0.1", { ports: fake.ports, allowWrites });
  client.on("status", () => {});
  const log = console.log;
  console.log = () => {};
  try {
    await client.start();
    await fn(client, fake);
  } finally {
    console.log = log;
    client.close();
    fake.close();
  }
}

test("6 bandas e parâmetros aceitos pelas rotas de EQ", () => {
  assert.deepEqual(EQ_BANDS.map((b) => b.id), ["l", "1", "2", "3", "4", "h"]);
  assert.equal(SECTION_PARAMS.eq.length, 1 + 6 * 3 + 2);
  assert.equal(eqParamPath(1, "eq", "1g"), "/ch/1/eq/1g");
  assert.equal(eqParamPath(40, "eq", "heq"), "/ch/40/eq/heq");
  assert.equal(eqParamPath(3, "flt", "lcf"), "/ch/3/flt/lcf");
  // Fora da lista: modelo, mix, tilt, nomes de outra seção, canal inválido.
  assert.equal(eqParamPath(1, "eq", "mdl"), null);
  assert.equal(eqParamPath(1, "eq", "mix"), null);
  assert.equal(eqParamPath(1, "flt", "tilt"), null);
  assert.equal(eqParamPath(1, "flt", "1g"), null);
  assert.equal(eqParamPath(41, "eq", "1g"), null);
  assert.equal(eqParamPath(0, "flt", "lc"), null);
});

test("estado da seção a partir da descrição real da mesa", () => {
  const eq = sectionState(1, "eq", parseNodeDescription(fixture("ch_1_eq")));
  assert.deepEqual(Object.keys(eq).sort(), [...SECTION_PARAMS.eq].sort());
  assert.deepEqual(eq["3f"], {
    name: "3f", type: "log", readOnly: false, min: 20, max: 20000, unit: "Hz", steps: 961,
    path: "/ch/1/eq/3f", value: 1080, risk: null,
  });
  assert.equal(eq["1g"]!.value, -6);
  assert.equal(eq["1q"]!.value, 3.19);
  assert.equal(eq.leq!.value, "SHV");
  assert.deepEqual(eq.leq!.options, ["PEQ", "SHV"]);
  assert.match(eq["1g"]!.risk!, /microfonia/);
  assert.match(eq.on!.risk!, /EQ inteiro/);
  const flt = sectionState(1, "flt", parseNodeDescription(fixture("ch_1_flt")));
  assert.deepEqual(Object.keys(flt), ["lc", "lcf", "lcs", "hc", "hcf", "hcs"]);
  assert.equal(flt.hcf!.value, 10020);
  assert.equal(flt.lcs!.value, "24");
  assert.match(flt.lcf!.risk!, /passa-alta/);
  assert.equal(flt.hcf!.risk, null);
  assert.equal(descValue(param(fixture("ch_1_eq"), "mdl")), "STD");
});

test("avisos de risco de EQ e filtro", () => {
  assert.match(riskWarning("/ch/1/flt/lc")!, /passa-alta/);
  assert.match(riskWarning("/ch/1/flt/lcs")!, /passa-alta/);
  assert.match(riskWarning("/ch/1/eq/on")!, /EQ inteiro/);
  assert.match(riskWarning("/ch/1/eq/hg")!, /microfonia/);
  assert.equal(riskWarning("/ch/1/eq/2f"), null);
  assert.equal(riskWarning("/ch/1/eq/2q"), null);
  assert.equal(riskWarning("/ch/1/flt/hc"), null);
});

test("leitura de volta: passo relativo em log, exato em int, texto em list", () => {
  const eq = fixture("ch_1_eq");
  const f = param(eq, "1f");
  const rb = (value: number) => ({ kind: "float" as const, text: "", raw: null, value });
  // 961 passos em 3 décadas: ~0,72% por passo.
  assert.ok(readBackMatches(f, 100, rb(100.5)));
  assert.ok(!readBackMatches(f, 100, rb(102)));
  assert.ok(readBackMatches(f, 10000, rb(10060)));
  assert.ok(readBackMatches(param(eq, "1g"), -6, rb(-6.04)));
  assert.ok(!readBackMatches(param(eq, "1g"), -6, rb(-6.2)));
  assert.ok(readBackMatches(param(eq, "on"), 1, { kind: "int", text: "1", raw: 1, value: 1 }));
  assert.ok(!readBackMatches(param(eq, "on"), 1, { kind: "int", text: "0", raw: 0, value: 0 }));
  assert.ok(readBackMatches(param(eq, "leq"), "PEQ", { kind: "string", text: "PEQ" }));
  assert.ok(!readBackMatches(param(eq, "leq"), "PEQ", { kind: "string", text: "SHV" }));
});

test("readChannelEq: duas consultas de descrição, nenhuma escrita", async () => {
  await withClient({}, async (client, fake) => {
    const r = await readChannelEq(client, 1);
    assert.equal(r.model, "STD");
    assert.equal(r.editable, true);
    assert.equal(r.eq["4f"]!.value, 3820);
    assert.equal(r.flt.lc!.value, 1);
    assert.deepEqual(fake.queries, ["/ch/1/eq", "/ch/1/flt"]);
    assert.equal(fake.writes.length, 0);
    await assert.rejects(readChannelEq(client, 41), /Canal inválido/);
  });
});

test("dryRun: valida na descrição e devolve o comando exato sem escrever", async () => {
  await withClient({}, async (client, fake) => {
    assert.deepEqual(await writeChannelEq(client, 1, "eq", "1g", -3, true), {
      dryRun: true, path: "/ch/1/eq/1g", command: "/ch/1/eq/1g ,f -3", risk: riskWarning("/ch/1/eq/1g"),
    });
    const lcs = await writeChannelEq(client, 1, "flt", "lcs", "12", true);
    assert.equal(lcs.command, '/ch/1/flt/lcs ,s "12"');
    const on = await writeChannelEq(client, 1, "eq", "on", 0, true);
    assert.equal(on.command, "/ch/1/eq/on ,i 0");
    await assert.rejects(writeChannelEq(client, 1, "eq", "1g", 20, true), /entre -15 e 15 dB/);
    assert.equal(fake.writes.length, 0);
  });
});

test("escrita de EQ: uma mensagem, leitura de volta; recusa antes de escrever", async () => {
  await withClient({ "/ch/1/eq/2f": 387.7, "/ch/1/flt/lcs": "24" }, async (client, fake) => {
    const r = await writeChannelEq(client, 1, "eq", "2f", 400);
    assert.equal(r.dryRun, false);
    assert.ok(!r.dryRun && r.ok);
    assert.equal(r.command, "/ch/1/eq/2f ,f 400");
    assert.deepEqual(fake.writes, [{ address: "/ch/1/eq/2f", args: [{ type: "f", value: 400 }] }]);
    const s = await writeChannelEq(client, 1, "flt", "lcs", "12");
    assert.ok(!s.dryRun && s.ok && s.readBack.text === "12");
    assert.match(s.risk!, /passa-alta/);
    // Recusados sem escrever nada:
    await assert.rejects(writeChannelEq(client, 1, "eq", "2f", 30000), /entre 20 e 20000 Hz/);
    await assert.rejects(writeChannelEq(client, 1, "eq", "2q", 0.1), /entre 0.44 e 10/);
    await assert.rejects(writeChannelEq(client, 1, "eq", "leq", "LOW"), /PEQ, SHV/);
    await assert.rejects(writeChannelEq(client, 1, "flt", "lcs", "30"), /6, 12, 18, 24/);
    await assert.rejects(writeChannelEq(client, 1, "flt", "lc", 0.5), /inteiro/);
    await assert.rejects(writeChannelEq(client, 1, "eq", "mdl", "SOUL"), /Parâmetro inválido/);
    await assert.rejects(writeChannelEq(client, 1, "eq", "mix", 50), /Parâmetro inválido/);
    await assert.rejects(writeChannelEq(client, 1, "dyn", "thr", 0), /Seção inválida/);
    await assert.rejects(writeChannelEq(client, 99, "eq", "1g", 0), /Canal inválido/);
    await assert.rejects(writeChannelEq(client, 1, "eq", 7, 0), /Parâmetro inválido/);
    assert.equal(fake.writes.length, 2);
  });
});

test("escrita de EQ com escrita desativada não escreve", async () => {
  await withClient({}, async (client, fake) => {
    await assert.rejects(writeChannelEq(client, 1, "eq", "1g", 0), /Escrita desativada/);
    assert.equal(fake.writes.length, 0);
  }, false);
});

test("curva: PEQ, shelves e filtros de corte", () => {
  const near = (a: number, b: number, tol = 0.05) => assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b}`);
  near(bandDb({ shape: "peq", f: 1000, g: 6, q: 1 }, 1000), 6);
  near(bandDb({ shape: "peq", f: 1000, g: -9, q: 4 }, 1000), -9);
  near(bandDb({ shape: "peq", f: 1000, g: 6, q: 4 }, 20), 0);
  near(bandDb({ shape: "low", f: 200, g: 6, q: 0.7 }, 20), 6, 0.3);
  near(bandDb({ shape: "low", f: 200, g: 6, q: 0.7 }, 10000), 0);
  near(bandDb({ shape: "high", f: 5000, g: -4, q: 0.7 }, 20000), -4, 0.4);
  near(bandDb({ shape: "high", f: 5000, g: -4, q: 0.7 }, 50), 0);
  assert.equal(bandDb({ shape: "peq", f: 1000, g: 0, q: 1 }, 1000), 0);
  near(cutDb("hp", 100, 100, 24), -3.01);
  near(cutDb("hp", 50, 100, 24), -24.1);
  near(cutDb("lp", 20000, 10000, 12), -12.3);
  const model = {
    eqOn: true, bands: [{ shape: "peq" as const, f: 1000, g: 6, q: 1 }],
    lc: { on: true, f: 100, slope: 24 }, hc: { on: false, f: 10000, slope: 12 },
  };
  near(responseDb(model, 1000), 6, 0.1);
  near(responseDb({ ...model, eqOn: false }, 1000), 0);
  assert.ok(responseDb(model, 30) < -30);
  const fs = logFreqs(5);
  near(fs[0]!, 20, 1e-9);
  near(fs[4]!, 20000, 1e-6);
  near(fs[2]!, Math.sqrt(20 * 20000), 1e-6);
});

test("quantize: passo da faixa descrita pela mesa", () => {
  const f = { type: "log", min: 20, max: 20000, steps: 961 };
  // Passos de 1/320 de década (~0,72%): fica a menos de meio passo, e arredondar de novo não muda.
  const q = quantize(1000, f);
  assert.ok(Math.abs(q / 1000 - 1) < 0.0037, String(q));
  assert.ok(Math.abs(quantize(q, f) - q) < 1e-9);
  assert.equal(quantize(50000, f), 20000);
  assert.equal(quantize(1, f), 20);
  assert.ok(Math.abs(quantize(-6.04, { type: "lin", min: -15, max: 15, steps: 301 }) - -6) < 1e-9);
  assert.equal(quantize(3.3, { type: "lin", min: -15, max: 15 }), 3.3);
});
