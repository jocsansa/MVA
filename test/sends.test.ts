import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySendValue,
  buildSendRows,
  destKey,
  modeParam,
  parseDest,
  parseSendPath,
  sendBase,
  sendPaths,
  type SendRow,
} from "../src/sends.ts";
import { riskWarning } from "../src/schema.ts";
import type { WingValue } from "../src/osc.ts";
import { WingClient } from "../src/wing.ts";
import { fakeWing } from "./fake-wing.ts";

test("destinos: buses 1..16 e matrizes 1..8", () => {
  assert.deepEqual(parseDest("bus/3"), { kind: "bus", index: 3 });
  assert.deepEqual(parseDest("mtx/8"), { kind: "mtx", index: 8 });
  assert.equal(parseDest("bus/17"), null);
  assert.equal(parseDest("mtx/9"), null);
  assert.equal(parseDest("main/1"), null);
  assert.equal(destKey({ kind: "bus", index: 3 }), "3");
  assert.equal(destKey({ kind: "mtx", index: 2 }), "MX2");
});

test("caminhos dos envios (estrutura conferida na mesa)", () => {
  assert.equal(sendBase("ch", 5, { kind: "bus", index: 3 }), "/ch/5/send/3");
  assert.equal(sendBase("bus", 1, { kind: "mtx", index: 2 }), "/bus/1/send/MX2");
  const bus = sendPaths({ kind: "bus", index: 3 });
  assert.equal(bus.length, (40 + 8) * 3); // canais e aux; bus -> bus é somente leitura
  assert.deepEqual(bus.slice(0, 3), ["/ch/1/send/3/on", "/ch/1/send/3/lvl", "/ch/1/send/3/mode"]);
  assert.ok(!bus.some((p) => p.startsWith("/bus/")));
  const mtx = sendPaths({ kind: "mtx", index: 1 });
  assert.equal(mtx.length, (40 + 8 + 16 + 4) * 3);
  assert.ok(mtx.includes("/main/4/send/MX1/pre"));
});

test("bus e main para matriz usam pre (0 = pós, 1 = pré) em vez de mode", () => {
  assert.equal(modeParam("ch"), "mode");
  assert.equal(modeParam("aux"), "mode");
  assert.equal(modeParam("bus"), "pre");
  assert.equal(modeParam("main"), "pre");
  const mtx = sendPaths({ kind: "mtx", index: 1 });
  assert.ok(mtx.includes("/bus/1/send/MX1/pre"));
  assert.ok(mtx.includes("/main/1/send/MX1/pre"));
  assert.ok(!mtx.includes("/bus/1/send/MX1/mode"));
  // Como na mesa real: /main/1/send/MX1 -> on=1, lvl=0.0, pre=0
  const values = new Map<string, WingValue | null>([
    ["/main/1/send/MX1/on", { kind: "int", text: "1", raw: 1, value: 1 }],
    ["/main/1/send/MX1/lvl", { kind: "float", text: "0.0", raw: 0.75, value: 0 }],
    ["/main/1/send/MX1/pre", { kind: "int", text: "0", raw: 0, value: 0 }],
  ]);
  const main1 = buildSendRows({ kind: "mtx", index: 1 }, values).find((r) => r.kind === "main" && r.index === 1);
  assert.deepEqual(main1, { kind: "main", index: 1, on: true, lvl: 0, mode: "POST" });
  assert.deepEqual(parseSendPath("/bus/3/send/MX2/pre"), { kind: "bus", index: 3, destKey: "MX2", param: "pre" });
  assert.match(riskWarning("/bus/3/send/MX2/pre")!, /matriz/);
});

test("parse de caminho de envio", () => {
  assert.deepEqual(parseSendPath("/ch/12/send/3/lvl"), { kind: "ch", index: 12, destKey: "3", param: "lvl" });
  assert.deepEqual(parseSendPath("/main/1/send/MX2/on"), { kind: "main", index: 1, destKey: "MX2", param: "on" });
  assert.equal(parseSendPath("/ch/1/send/3/pan"), null);
  assert.equal(parseSendPath("/ch/1/fdr"), null);
});

test("valores de envio", () => {
  const row: SendRow = { kind: "ch", index: 1, on: null, lvl: null, mode: null };
  applySendValue(row, "on", { kind: "int", text: "1", raw: 1, value: 1 });
  applySendValue(row, "lvl", { kind: "float", text: "-20.8", raw: 0.4, value: -20.8 });
  applySendValue(row, "mode", { kind: "string", text: "PRE" });
  applySendValue(row, "lvl", null);
  assert.deepEqual(row, { kind: "ch", index: 1, on: true, lvl: -20.8, mode: "PRE" });
});

test("avisos de risco dos envios", () => {
  assert.match(riskWarning("/ch/1/send/3/lvl")!, /retorno/);
  assert.match(riskWarning("/aux/2/send/16/on")!, /retorno/);
  assert.match(riskWarning("/bus/1/send/MX2/lvl")!, /matriz/);
});

test("readMany lê os envios de um bus; sem resposta vira null", async () => {
  const dest = { kind: "bus" as const, index: 3 };
  const initial: Record<string, string | number> = {};
  for (const p of sendPaths(dest)) {
    if (p.endsWith("/on")) initial[p] = 0;
    else if (p.endsWith("/lvl")) initial[p] = -144;
    else initial[p] = "PRE";
  }
  initial["/ch/2/send/3/on"] = 1;
  initial["/ch/2/send/3/lvl"] = -12.5;
  initial["/aux/8/send/3/mode"] = "POST";
  delete initial["/ch/40/send/3/lvl"]; // a mesa falsa não responde esse
  const fake = await fakeWing(initial);
  const client = new WingClient("127.0.0.1", { ports: fake.ports });
  client.on("status", () => {});
  try {
    await client.start();
    const values = await client.readMany(sendPaths(dest));
    const rows = buildSendRows(dest, values);
    assert.equal(rows.length, 48);
    assert.deepEqual(rows[1], { kind: "ch", index: 2, on: true, lvl: -12.5, mode: "PRE" });
    assert.equal(rows[39]!.lvl, null);
    assert.deepEqual(rows[47], { kind: "aux", index: 8, on: false, lvl: -144, mode: "POST" });
  } finally {
    client.close();
    fake.close();
  }
  assert.equal(fake.writes.length, 0);
});
