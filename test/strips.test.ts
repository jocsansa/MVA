import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeChannelData, METER_CHANNEL, meterRequest, meterRequestMulti } from "../src/native.ts";
import {
  STRIP_INFO,
  STRIP_KINDS,
  applyStripValue,
  createStrips,
  METER_REPORT_ID,
  meterGroups,
  splitMeterPacket,
  stripMeterFromWords,
  stripPaths,
} from "../src/strips.ts";
import { riskWarning } from "../src/schema.ts";
import { WingClient } from "../src/wing.ts";
import { fakeWing } from "./fake-wing.ts";

test("quantidades conferidas na mesa real", () => {
  assert.deepEqual(
    Object.fromEntries(STRIP_KINDS.map((k) => [k.kind, k.count])),
    { ch: 40, aux: 8, bus: 16, main: 4, mtx: 8, dca: 16, mgrp: 8 },
  );
});

test("caminhos lidos por tipo de strip", () => {
  assert.deepEqual(stripPaths("ch", 3), [
    "/ch/3/name", "/ch/3/col", "/ch/3/mute", "/ch/3/fdr", "/ch/3/pan", "/ch/3/$solo", "/ch/3/in/set/$g",
  ]);
  assert.deepEqual(stripPaths("bus", 16), ["/bus/16/name", "/bus/16/col", "/bus/16/mute", "/bus/16/fdr", "/bus/16/pan", "/bus/16/$solo"]);
  assert.ok(!stripPaths("dca", 1).includes("/dca/1/pan"), "DCA não tem pan");
  assert.deepEqual(stripPaths("mgrp", 2), ["/mgrp/2/name", "/mgrp/2/mute"]);
});

test("valores de bus, dca e mute group; parâmetros fora do tipo são ignorados", () => {
  const s = createStrips();
  applyStripValue(s, "/bus/1/name", { kind: "string", text: "IEM 1" });
  applyStripValue(s, "/dca/16/fdr", { kind: "float", text: "-1.8", raw: 0.7, value: -1.8 });
  applyStripValue(s, "/mgrp/8/mute", { kind: "int", text: "1", raw: 1, value: 1 });
  assert.equal(s.bus[0]!.name, "IEM 1");
  assert.equal(s.dca[15]!.faderDb, -1.8);
  assert.equal(s.mgrp[7]!.mute, true);
  assert.equal(applyStripValue(s, "/dca/1/pan", { kind: "float", text: "0", raw: 0.5, value: 0 }), null);
  assert.equal(applyStripValue(s, "/mgrp/1/fdr", { kind: "float", text: "0", raw: 0.5, value: 0 }), null);
  assert.equal(applyStripValue(s, "/bus/17/name", { kind: "string", text: "x" }), null);
});

test("pedido de medidores: token por tipo (Table 4) e uma coleção com vários tipos", () => {
  const bus = meterRequest(3, STRIP_INFO.bus.meter!.token, [1, 2]);
  assert.equal(encodeChannelData(METER_CHANNEL, bus).toString("hex"), "dfd3d400000003dca20001de");
  // Exemplo da doc: canais 1, 2, 9 e fx 5 numa coleção só.
  assert.equal(
    meterRequestMulti(2, [{ token: 0xa0, indices: [1, 2, 9] }, { token: 0xa6, indices: [5] }]).toString("hex"),
    "d400000002dca0000108a604de",
  );
  assert.throws(() => meterRequest(1, 0xa0, [0]));
  // Coleção única: ch, aux, bus, main, mtx, dca, nessa ordem.
  const all = meterRequestMulti(METER_REPORT_ID, meterGroups());
  const tokens = [...all].filter((b) => b >= 0xa0 && b <= 0xa5);
  assert.deepEqual(tokens, [0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5]);
  assert.equal(all.length, 5 + 1 + 6 + (40 + 8 + 16 + 4 + 8 + 16) + 1);
});

test("parse da coleção única: 8 valores por strip e 4 no DCA (saída nas posições 2 e 3)", () => {
  const before = (40 + 8 + 16 + 4 + 8) * 8; // palavras antes do primeiro DCA
  const pkt = Buffer.alloc(4 + (before + 16 * 4) * 2);
  pkt.writeUInt32BE(METER_REPORT_ID, 0);
  pkt.writeInt16BE(-3 * 256, 4 + 0 * 2); // ch 1 entrada L
  pkt.writeInt16BE(-8 * 256, 4 + 1 * 2); // ch 1 entrada R
  pkt.writeInt16BE(-12 * 256, 4 + 2 * 2); // ch 1 saída L
  pkt.writeInt16BE(-6 * 256, 4 + ((40 + 8) * 8 + 3) * 2); // bus 1 saída R
  pkt.writeInt16BE(-10 * 256, 4 + (before + 2) * 2); // dca 1 pós-fader L
  pkt.writeInt16BE(-11 * 256, 4 + (before + 3) * 2); // dca 1 pós-fader R
  const r = splitMeterPacket(pkt)!;
  assert.equal(r.length, 92);
  assert.equal(r[0]!.kind, "ch");
  assert.equal(r[0]!.meter!.l, -12);
  assert.equal(r[0]!.meter!.in, -3, "entrada do canal: maior de L/R, antes do fader e do mute");
  const bus1 = r.find((m) => m.kind === "bus" && m.index === 1)!;
  assert.equal(bus1.meter!.r, -6);
  const dca1 = r.find((m) => m.kind === "dca" && m.index === 1)!;
  assert.deepEqual(dca1.meter, { l: -10, r: -11 });
  // Outro report id é ignorado; pacote curto devolve só o que coube.
  const other = Buffer.from(pkt);
  other.writeUInt32BE(9, 0);
  assert.equal(splitMeterPacket(other), null);
  assert.equal(splitMeterPacket(pkt.subarray(0, 4 + 8 * 2 * 2))!.length, 2);
  assert.deepEqual(stripMeterFromWords([0, 0, -1, -2]), { l: -1, r: -2 });
});

test("avisos de risco de main, DCA e mute group", () => {
  assert.match(riskWarning("/main/1/mute")!, /PA/);
  assert.match(riskWarning("/main/1/fdr")!, /PA/);
  assert.match(riskWarning("/dca/3/fdr")!, /DCA/);
  assert.match(riskWarning("/mgrp/2/mute")!, /vários canais/);
  assert.equal(riskWarning("/bus/1/fdr"), null);
});

test("cliente lê todos os tipos de strip e pede medidores de cada tipo", async () => {
  const fake = await fakeWing({ "/bus/3/name": "IEM 3", "/dca/16/name": "Vozes", "/mgrp/1/name": "Banda" });
  const client = new WingClient("127.0.0.1", { ports: fake.ports });
  client.on("status", () => {});
  try {
    await client.start();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(client.strips.bus[2]!.name, "IEM 3");
    assert.equal(client.strips.dca[15]!.name, "Vozes");
    assert.equal(client.strips.mgrp[0]!.name, "Banda");
    assert.equal(client.channels, client.strips.ch);
  } finally {
    client.close();
    fake.close();
  }
  assert.equal(fake.writes.length, 0);
});
