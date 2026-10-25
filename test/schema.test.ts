import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  encodeParamValue,
  isSafePath,
  parseDescriptionLine,
  parseNodeDescription,
  parseWingNumber,
  riskWarning,
  splitPath,
  type ParamDesc,
} from "../src/schema.ts";
import { WingClient } from "../src/wing.ts";
import { fakeWing } from "./fake-wing.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), "utf8");
const param = (text: string, name: string) => {
  const c = parseNodeDescription(text).find((x) => x.name === name);
  assert.ok(c && c.kind === "param", `parâmetro ${name}`);
  return c as ParamDesc;
};

test("números da WING: notação k e -oo", () => {
  assert.equal(parseWingNumber("10k02"), 10020);
  assert.equal(parseWingNumber("1k08"), 1080);
  assert.equal(parseWingNumber("2k00"), 2000);
  assert.equal(parseWingNumber("20k00"), 20000);
  assert.equal(parseWingNumber("+5.3"), 5.3);
  assert.equal(parseWingNumber("-oo"), -Infinity);
  assert.throws(() => parseWingNumber("abc"));
});

test("todas as descrições reais capturadas da mesa são lidas sem erro", () => {
  const dir = new URL("./fixtures/", import.meta.url);
  for (const f of readdirSync(dir)) {
    const children = parseNodeDescription(readFileSync(new URL(f, dir), "utf8"));
    assert.ok(children.length > 0, f);
  }
});

test("descrição do canal: tipos, faixas, somente leitura, nós", () => {
  const ch = fixture("ch_1");
  assert.deepEqual(param(ch, "fdr"), {
    name: "fdr", kind: "param", type: "fader", readOnly: false, valueText: "-44.6",
    min: -144, max: 10, unit: "dB", steps: 1024,
  });
  assert.equal(param(ch, "$fdr").readOnly, true);
  assert.deepEqual(param(ch, "name"), {
    name: "name", kind: "param", type: "string", readOnly: false, valueText: "Vocal1", maxLength: 16,
  });
  assert.equal(param(ch, "tags").valueText, "");
  assert.deepEqual(param(ch, "mon").options, ["A", "B", "A+B"]);
  assert.deepEqual(param(ch, "pan").min, -100);
  assert.deepEqual(param(ch, "pan").max, 100);
  assert.deepEqual(parseNodeDescription(ch).find((c) => c.name === "eq"), { name: "eq", kind: "node" });
});

test("descrição de filtro e EQ: log em Hz com k", () => {
  const flt = fixture("ch_1_flt");
  assert.deepEqual(param(flt, "hcf"), {
    name: "hcf", kind: "param", type: "log", readOnly: false, valueText: "10k02",
    min: 50, max: 20000, unit: "Hz", steps: 833,
  });
  assert.deepEqual(param(flt, "lcs").options, ["6", "12", "18", "24"]);
  assert.equal(param(fixture("ch_1_eq"), "1q").max, 10);
});

test("faixa real do ganho AES50: -2.0 a 45.5 dB (a doc dizia -3)", () => {
  const g = param(fixture("io_in_A_1"), "g");
  assert.equal(g.min, -2);
  assert.equal(g.max, 45.5);
  assert.equal(g.steps, 20);
});

test("formato '?' (sem coluna de valor)", () => {
  assert.deepEqual(parseDescriptionLine("  fdr            fader [-oo .. 10.0 dB], 1024 steps", false), {
    name: "fdr", kind: "param", type: "fader", readOnly: false, valueText: null,
    min: -144, max: 10, unit: "dB", steps: 1024,
  });
});

test("validação de valores contra a descrição", () => {
  const ch = fixture("ch_1");
  assert.deepEqual(encodeParamValue(param(ch, "pan"), -30), { arg: { type: "f", value: -30 } });
  assert.match((encodeParamValue(param(ch, "pan"), 101) as { error: string }).error, /entre -100 e 100/);
  assert.deepEqual(encodeParamValue(param(ch, "mute"), 1), { arg: { type: "i", value: 1 } });
  assert.ok("error" in encodeParamValue(param(ch, "mute"), 0.5));
  assert.deepEqual(encodeParamValue(param(ch, "mon"), "B"), { arg: { type: "s", value: "B" } });
  assert.ok("error" in encodeParamValue(param(ch, "mon"), "C"));
  assert.match((encodeParamValue(param(ch, "$fdr"), 0) as { error: string }).error, /somente leitura/);
  assert.ok("error" in encodeParamValue(param(ch, "name"), "nome comprido demais!"));
  assert.ok("error" in encodeParamValue(param(ch, "name"), "Ação"));
});

test("caminhos aceitos e avisos de risco", () => {
  assert.ok(isSafePath("/ch/1/eq/1g"));
  assert.ok(isSafePath("/ch/1/$fdr"));
  assert.ok(!isSafePath("/ch/*/mute"));
  assert.ok(!isSafePath("/%2000/ch/1/mute"));
  assert.ok(!isSafePath("/*s"));
  assert.ok(!isSafePath("ch/1"));
  assert.deepEqual(splitPath("/ch/1/eq/1g"), { parent: "/ch/1/eq", name: "1g" });
  assert.match(riskWarning("/io/in/A/1/vph")!, /Phantom/);
  assert.match(riskWarning("/ch/1/in/set/$vph")!, /Phantom/);
  assert.match(riskWarning("/ch/1/in/conn/grp")!, /Patch/);
  assert.match(riskWarning("/io/in/A/1/rmt")!, /Patch/);
  assert.match(riskWarning("/io/in/A/1/g")!, /todos os canais/);
  assert.match(riskWarning("/io/out/LCL/1/grp")!, /Patch/);
  assert.match(riskWarning("/$ctl/scn/load")!, /mesa inteira/);
  assert.equal(riskWarning("/ch/1/pan"), null);
  assert.equal(riskWarning("/io/in/A/1/name"), null);
  assert.equal(riskWarning("/io/in/A/1/col"), null);
});

test("setParam: consulta a descrição, escreve uma vez e lê de volta", async () => {
  const fake = await fakeWing({ "/ch/1/pan": 0, "/ch/1/mon": "A" }, { "/ch/1": fixture("ch_1") });
  const client = new WingClient("127.0.0.1", { ports: fake.ports, allowWrites: true });
  client.on("status", () => {});
  const log = console.log;
  console.log = () => {};
  try {
    await client.start();
    const r = await client.setParam("/ch/1/pan", -30);
    assert.equal(r.readBack.kind, "float");
    assert.equal(r.desc.type, "lin");
    assert.deepEqual(fake.writes, [{ address: "/ch/1/pan", args: [{ type: "f", value: -30 }] }]);
    assert.deepEqual(fake.queries, ["/ch/1"]);
    // Recusados antes de escrever:
    await assert.rejects(client.setParam("/ch/1/pan", 200), /entre -100 e 100/);
    await assert.rejects(client.setParam("/ch/1/$fdr", 0), /somente leitura/);
    await assert.rejects(client.setParam("/ch/1/naoexiste", 1), /não existe/);
    await assert.rejects(client.setParam("/ch/1/eq", 1), /é um nó/);
    await assert.rejects(client.setParam("/ch/*/mute", 1), /Caminho inválido/);
    assert.equal(fake.writes.length, 1);
  } finally {
    console.log = log;
    client.close();
    fake.close();
  }
});

test("setParam com escrita desativada não consulta nem escreve", async () => {
  const fake = await fakeWing({}, { "/ch/1": fixture("ch_1") });
  const client = new WingClient("127.0.0.1", { ports: fake.ports });
  client.on("status", () => {});
  try {
    await client.start();
    await assert.rejects(client.setParam("/ch/1/pan", 0), /Escrita desativada/);
  } finally {
    client.close();
    fake.close();
  }
  assert.equal(fake.writes.length, 0);
  assert.equal(fake.queries.length, 0);
});
