import { test } from "node:test";
import assert from "node:assert/strict";
import { DYN_SECTIONS, dynParamPath, dynSectionState, readChannelDyn, writeChannelDyn } from "../src/dyn.ts";
import { parseNodeDescription, riskWarning } from "../src/schema.ts";
import { METER_REPORT_ID, METERED_KINDS, channelDynFromWords, splitMeterPacket } from "../src/strips.ts";
import { WingClient } from "../src/wing.ts";
import { fakeWing } from "./fake-wing.ts";

// Descrições no formato real da WING ("<nó> ,s #"). A lista de parâmetros de gate/dyn ainda não
// foi capturada da mesa: estas são as do simulador, com um parâmetro somente leitura a mais.
const GATE_DESC = [
  "  on             1                   int [0 .. 1]",
  "  mdl            GATE                list [GATE, DUCK]",
  "  thr            -40.0               lin [-80.0 .. 0.0 dB], 161 steps",
  "  range          40.0                lin [3.0 .. 60.0 dB], 58 steps",
  "  att            0.5                 lin [0.0 .. 120.0 ms], 121 steps",
  "  rel            150.0               log [4.0 .. 4k00 ms], 101 steps",
  "  ratio          GATE                list [1:1.5, 1:2, 1:3, 1:4, GATE]",
  "  $gr            0.0             r/o lin [-60.0 .. 0.0 dB], 121 steps",
  "",
].join("\n");
const DYN_DESC = [
  "  on             1                   int [0 .. 1]",
  "  mdl            COMP                list [COMP, EXP]",
  "  gain           3.0                 lin [-6.0 .. +12.0 dB], 37 steps",
  "  thr            -24.0               lin [-60.0 .. 0.0 dB], 121 steps",
  "  ratio          3.0                 list [1.1, 1.3, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 7.0, 10, 20, 50, 100]",
  "  knee           2                   lin [0 .. 5], 6 steps",
  "  det            RMS                 list [PEAK, RMS]",
  "  auto           0                   int [0 .. 1]",
  "",
].join("\n");
const DESCRIPTIONS = { "/ch/3/gate": GATE_DESC, "/ch/3/dyn": DYN_DESC };

async function withClient(
  initial: Record<string, string | number>,
  fn: (c: WingClient, fake: Awaited<ReturnType<typeof fakeWing>>) => Promise<void>,
  allowWrites = true,
) {
  const fake = await fakeWing(initial, DESCRIPTIONS);
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

test("caminhos aceitos pela rota de dinâmica", () => {
  assert.deepEqual(DYN_SECTIONS, ["gate", "dyn"]);
  assert.equal(dynParamPath(3, "gate", "thr"), "/ch/3/gate/thr");
  assert.equal(dynParamPath(40, "dyn", "ratio"), "/ch/40/dyn/ratio");
  assert.equal(dynParamPath(1, "dyn", "$solo"), "/ch/1/dyn/$solo");
  // Só um nome simples logo abaixo do nó: nada de subnós, curingas ou canal inválido.
  assert.equal(dynParamPath(1, "dyn", "sc/f"), null);
  assert.equal(dynParamPath(1, "gate", "*"), null);
  assert.equal(dynParamPath(1, "gate", ""), null);
  assert.equal(dynParamPath(41, "gate", "thr"), null);
  assert.equal(dynParamPath(0, "dyn", "thr"), null);
});

test("estado da seção: todos os parâmetros da descrição, na ordem da mesa", () => {
  const gate = dynSectionState(3, "gate", parseNodeDescription(GATE_DESC));
  assert.equal(gate.path, "/ch/3/gate");
  assert.equal(gate.model, "GATE");
  assert.equal(gate.on, 1);
  assert.deepEqual(gate.params.map((p) => p.name), ["on", "mdl", "thr", "range", "att", "rel", "ratio", "$gr"]);
  assert.deepEqual(gate.params.find((p) => p.name === "rel"), {
    name: "rel", type: "log", readOnly: false, min: 4, max: 4000, unit: "ms", steps: 101,
    path: "/ch/3/gate/rel", value: 150, risk: null,
  });
  const gr = gate.params.find((p) => p.name === "$gr")!;
  assert.equal(gr.readOnly, true);
  assert.equal(gr.risk, null); // somente leitura não tem risco: a mesa não deixa escrever
  assert.match(gate.params.find((p) => p.name === "thr")!.risk!, /corta o sinal/);
  const dyn = dynSectionState(3, "dyn", parseNodeDescription(DYN_DESC));
  assert.equal(dyn.model, "COMP");
  assert.equal(dyn.params.find((p) => p.name === "ratio")!.value, "3.0");
  assert.equal(dyn.params.find((p) => p.name === "gain")!.max, 12);
  assert.match(dyn.params.find((p) => p.name === "gain")!.risk!, /microfonia/);
  assert.equal(dyn.params.find((p) => p.name === "thr")!.risk, null);
});

test("avisos de risco da dinâmica", () => {
  assert.match(riskWarning("/ch/1/gate/on")!, /Gate/);
  assert.match(riskWarning("/ch/1/gate/range")!, /Gate/);
  assert.match(riskWarning("/ch/1/dyn/on")!, /compressor/);
  assert.match(riskWarning("/ch/1/dyn/mdl")!, /compressor/);
  assert.match(riskWarning("/ch/1/dyn/gain")!, /microfonia/);
  assert.equal(riskWarning("/ch/1/gate/att"), null);
  assert.equal(riskWarning("/ch/1/dyn/rel"), null);
});

test("readChannelDyn: duas consultas de descrição, nenhuma escrita", async () => {
  await withClient({}, async (client, fake) => {
    const r = await readChannelDyn(client, 3);
    assert.equal(r.ch, 3);
    assert.equal(r.gate.model, "GATE");
    assert.equal(r.dyn.params.length, 8);
    assert.deepEqual(fake.queries, ["/ch/3/gate", "/ch/3/dyn"]);
    assert.equal(fake.writes.length, 0);
    await assert.rejects(readChannelDyn(client, 41), /Canal inválido/);
  });
});

test("dryRun da dinâmica: comando exato sem escrever", async () => {
  await withClient({}, async (client, fake) => {
    assert.deepEqual(await writeChannelDyn(client, 3, "dyn", "thr", -30, true), {
      dryRun: true, path: "/ch/3/dyn/thr", command: "/ch/3/dyn/thr ,f -30", risk: null,
    });
    assert.equal((await writeChannelDyn(client, 3, "dyn", "ratio", "4.0", true)).command, '/ch/3/dyn/ratio ,s "4.0"');
    const on = await writeChannelDyn(client, 3, "gate", "on", 0, true);
    assert.equal(on.command, "/ch/3/gate/on ,i 0");
    assert.match(on.risk!, /Gate/);
    assert.equal(fake.writes.length, 0);
  });
});

test("escrita da dinâmica: uma mensagem, leitura de volta; recusa antes de escrever", async () => {
  await withClient({ "/ch/3/dyn/thr": -24, "/ch/3/gate/ratio": "GATE" }, async (client, fake) => {
    const r = await writeChannelDyn(client, 3, "dyn", "thr", -30);
    assert.ok(!r.dryRun && r.ok);
    const g = await writeChannelDyn(client, 3, "gate", "ratio", "1:3");
    assert.ok(!g.dryRun && g.ok && g.readBack.text === "1:3");
    assert.deepEqual(fake.writes.map((w) => [w.address, w.args[0]]), [
      ["/ch/3/dyn/thr", { type: "f", value: -30 }],
      ["/ch/3/gate/ratio", { type: "s", value: "1:3" }],
    ]);
    // Recusados sem escrever nada:
    await assert.rejects(writeChannelDyn(client, 3, "dyn", "thr", 5), /entre -60 e 0 dB/);
    await assert.rejects(writeChannelDyn(client, 3, "dyn", "gain", 13), /entre -6 e 12 dB/);
    await assert.rejects(writeChannelDyn(client, 3, "dyn", "ratio", "8:1"), /opções válidas/);
    await assert.rejects(writeChannelDyn(client, 3, "gate", "range", 1), /entre 3 e 60 dB/);
    await assert.rejects(writeChannelDyn(client, 3, "gate", "$gr", 0), /somente leitura/);
    await assert.rejects(writeChannelDyn(client, 3, "gate", "naoexiste", 1), /não existe/);
    await assert.rejects(writeChannelDyn(client, 3, "dyn", "sc/f", 100), /Parâmetro inválido/);
    await assert.rejects(writeChannelDyn(client, 3, "eq", "thr", 0), /Seção inválida/);
    await assert.rejects(writeChannelDyn(client, 41, "dyn", "thr", 0), /Canal inválido/);
    assert.equal(fake.writes.length, 2);
  });
});

test("escrita da dinâmica com escrita desativada não escreve", async () => {
  await withClient({}, async (client, fake) => {
    await assert.rejects(writeChannelDyn(client, 3, "dyn", "thr", -30), /Escrita desativada/);
    assert.equal(fake.writes.length, 0);
  }, false);
});

test("medidor do canal: ganho do gate (palavra 5) e do compressor (palavra 7)", () => {
  assert.deepEqual(channelDynFromWords([-20, -20, -22, -22, -30, -12.5, -25, -4]), { gate: -12.5, dyn: -4 });
  assert.equal(channelDynFromWords([0, 0, -1, -2]), null);
  const words = METERED_KINDS.reduce((n, k) => n + k.count * k.meter!.words, 0);
  const pkt = Buffer.alloc(4 + words * 2);
  pkt.writeUInt32BE(METER_REPORT_ID, 0);
  // CH 1: saída -10/-11, gate -6, compressor -3; o resto zerado. AUX 1 vem logo depois dos 40 canais.
  for (const [w, db] of [[2, -10], [3, -11], [5, -6], [7, -3]] as const) pkt.writeInt16BE(db * 256, 4 + w * 2);
  const out = splitMeterPacket(pkt)!;
  assert.deepEqual(out[0], { kind: "ch", index: 1, meter: { l: -10, r: -11, gate: -6, dyn: -3 } });
  assert.deepEqual(out[40], { kind: "aux", index: 1, meter: { l: 0, r: 0 } });
});
