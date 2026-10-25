import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeChannelData, METER_CHANNEL, meterRequest, parseMeterWords } from "../src/native.ts";
import {
  STRIP_INFO,
  STRIP_KINDS,
  applyStripValue,
  createStrips,
  meterReportId,
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

test("pedido de medidores por tipo: report id e token (Table 4)", () => {
  assert.equal(meterReportId("ch"), 1);
  assert.equal(meterReportId("dca"), 6);
  const bus = meterRequest(meterReportId("bus"), STRIP_INFO.bus.meter!.token, [1, 2]);
  assert.equal(encodeChannelData(METER_CHANNEL, bus).toString("hex"), "dfd3d400000003dca20001de");
  assert.throws(() => meterRequest(1, 0xa0, [0]));
});

test("parse de medidores: 8 valores por strip e 4 no DCA (pós-fader nas posições 2 e 3)", () => {
  const pkt = Buffer.alloc(4 + 2 * 4 * 2);
  pkt.writeUInt32BE(6, 0);
  pkt.writeInt16BE(-10 * 256, 4 + 2 * 2); // dca 1 post L
  pkt.writeInt16BE(-11 * 256, 4 + 3 * 2); // dca 1 post R
  const r = parseMeterWords(pkt, 4)!;
  assert.equal(r.reportId, 6);
  assert.equal(r.strips.length, 2);
  assert.deepEqual(stripMeterFromWords(r.strips[0]!), { l: -10, r: -11 });
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
