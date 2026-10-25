import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySendValue,
  buildSendRows,
  destKey,
  modeParam,
  parseDest,
  parseSendPath,
  parseSendSource,
  sendBase,
  sendParamPath,
  sendPaths,
  writeSend,
  type SendRow,
} from "../src/sends.ts";
import { readFileSync } from "node:fs";
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

test("fonte e parâmetro aceitos na escrita de envio", () => {
  const bus3 = { kind: "bus" as const, index: 3 };
  const mx2 = { kind: "mtx" as const, index: 2 };
  assert.deepEqual(parseSendSource("ch/40", bus3), { kind: "ch", index: 40 });
  assert.deepEqual(parseSendSource("aux/8", bus3), { kind: "aux", index: 8 });
  assert.equal(parseSendSource("ch/41", bus3), null);
  assert.equal(parseSendSource("bus/1", bus3), null); // bus -> bus é somente leitura
  assert.equal(parseSendSource("main/1", bus3), null);
  assert.deepEqual(parseSendSource("main/4", mx2), { kind: "main", index: 4 });
  assert.equal(parseSendSource("main/5", mx2), null);
  assert.equal(parseSendSource("mtx/1", mx2), null);
  assert.equal(sendParamPath({ kind: "ch", index: 5 }, bus3, "lvl"), "/ch/5/send/3/lvl");
  assert.equal(sendParamPath({ kind: "ch", index: 5 }, mx2, "mode"), "/ch/5/send/MX2/mode");
  assert.equal(sendParamPath({ kind: "ch", index: 5 }, bus3, "pre"), null);
  assert.equal(sendParamPath({ kind: "bus", index: 1 }, mx2, "pre"), "/bus/1/send/MX2/pre");
  assert.equal(sendParamPath({ kind: "bus", index: 1 }, mx2, "mode"), null);
  assert.equal(sendParamPath({ kind: "ch", index: 5 }, bus3, "pan"), null);
});

// Descrição real de /ch/1/send/1 e, no mesmo formato, de bus -> matriz (pre no lugar de mode).
const SEND_DESC = readFileSync(new URL("./fixtures/ch_1_send_1.txt", import.meta.url), "utf8");
const BUS_MX_DESC = [
  "  on             0                   int [0 .. 1]",
  "  lvl            -oo                 fader [-oo .. 10.0 dB], 1024 steps",
  "  pre            0                   int [0 .. 1]",
  "",
].join("\n");

async function withSendClient(fn: (c: WingClient, fake: Awaited<ReturnType<typeof fakeWing>>) => Promise<void>, allowWrites = true) {
  const fake = await fakeWing({ "/ch/1/send/1/lvl": -20.8, "/ch/1/send/1/mode": "PRE" }, { "/ch/1/send/1": SEND_DESC, "/bus/2/send/MX1": BUS_MX_DESC });
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

test("writeSend dryRun: comando exato e risco, sem escrever", async () => {
  await withSendClient(async (client, fake) => {
    assert.deepEqual(await writeSend(client, "ch/1", "bus/1", "lvl", -12.5, true), {
      dryRun: true, path: "/ch/1/send/1/lvl", command: "/ch/1/send/1/lvl ,f -12.5", risk: riskWarning("/ch/1/send/1/lvl"),
    });
    assert.equal((await writeSend(client, "ch/1", "bus/1", "mode", "POST", true)).command, '/ch/1/send/1/mode ,s "POST"');
    assert.equal((await writeSend(client, "bus/2", "mtx/1", "pre", 1, true)).command, "/bus/2/send/MX1/pre ,i 1");
    assert.match((await writeSend(client, "bus/2", "mtx/1", "pre", 1, true)).risk!, /matriz/);
    assert.equal(fake.writes.length, 0);
  });
});

test("writeSend: escreve uma vez e lê de volta; recusa antes de escrever", async () => {
  await withSendClient(async (client, fake) => {
    const r = await writeSend(client, "ch/1", "bus/1", "lvl", -12.5);
    assert.ok(!r.dryRun && r.ok);
    assert.match(r.risk!, /retorno/);
    const m = await writeSend(client, "ch/1", "bus/1", "mode", "POST");
    assert.ok(!m.dryRun && m.ok && m.readBack.text === "POST");
    const off = await writeSend(client, "ch/1", "bus/1", "lvl", -144); // -∞
    assert.ok(!off.dryRun && off.ok);
    const pre = await writeSend(client, "bus/2", "mtx/1", "pre", 1);
    assert.ok(!pre.dryRun && pre.ok);
    assert.deepEqual(fake.writes.map((w) => [w.address, w.args[0]]), [
      ["/ch/1/send/1/lvl", { type: "f", value: -12.5 }],
      ["/ch/1/send/1/mode", { type: "s", value: "POST" }],
      ["/ch/1/send/1/lvl", { type: "f", value: -144 }],
      ["/bus/2/send/MX1/pre", { type: "i", value: 1 }],
    ]);
    // Recusados sem escrever nada:
    await assert.rejects(writeSend(client, "ch/1", "bus/1", "lvl", 11), /entre -144 e 10 dB/);
    await assert.rejects(writeSend(client, "ch/1", "bus/1", "mode", "PFL"), /PRE, POST, GRP/);
    await assert.rejects(writeSend(client, "ch/1", "bus/1", "on", 2), /entre 0 e 1/);
    await assert.rejects(writeSend(client, "ch/1", "bus/1", "pan", 0), /Parâmetro inválido/);
    await assert.rejects(writeSend(client, "ch/1", "bus/1", "pre", 1), /Parâmetro inválido/);
    await assert.rejects(writeSend(client, "bus/2", "mtx/1", "mode", "PRE"), /Parâmetro inválido/);
    await assert.rejects(writeSend(client, "bus/2", "bus/1", "lvl", 0), /Fonte inválida/);
    await assert.rejects(writeSend(client, "ch/1", "bus/17", "lvl", 0), /Destino inválido/);
    await assert.rejects(writeSend(client, "ch/1", "main/1", "lvl", 0), /Destino inválido/);
    await assert.rejects(writeSend(client, 5, "bus/1", "lvl", 0), /Fonte inválida/);
    assert.equal(fake.writes.length, 4);
  });
});

test("writeSend com escrita desativada não escreve", async () => {
  await withSendClient(async (client, fake) => {
    await assert.rejects(writeSend(client, "ch/1", "bus/1", "lvl", 0), /Escrita desativada/);
    assert.equal(fake.writes.length, 0);
  }, false);
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
