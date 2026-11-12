// Executor das correções do assistente contra a mesa falsa: comandos exatos, ordem segura
// (primeiro o que abaixa), compensação no trim de todos os canais da mesma fonte, desfazer e
// rollback quando uma escrita falha no meio. O plano só lê (fake.writes vazio).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WingClient, describeMessage } from "../src/wing.ts";
import { applySuggestion, planSuggestion, safeOrder, snapGain, undoWrites } from "../src/corrections.ts";
import type { PlannedWrite, Suggestion } from "../src/assistant.ts";
import { fakeWing } from "./fake-wing.ts";

// Descrições reais da WING: entrada AES50 (g de -2.0 a 45.5 dB em 20 passos de 2,5) e /ch/N/in/set
// (trim de -18 a +18 dB).
const IO_IN = readFileSync(new URL("./fixtures/io_in_A_1.txt", import.meta.url), "utf8");
const IN_SET = readFileSync(new URL("./fixtures/ch_1_in_set.txt", import.meta.url), "utf8");

/** CH 3 e CH 4 usam a mesma entrada LCL 3; CH 5 usa LCL 5; CH 6 vem da USB. */
function console40(over: Record<string, string | number> = {}): Record<string, string | number> {
  const v: Record<string, string | number> = {};
  for (let ch = 1; ch <= 40; ch++) {
    const b = `/ch/${ch}/in`;
    v[`${b}/set/altsrc`] = 0;
    v[`${b}/conn/grp`] = ch === 6 ? "USB" : "LCL";
    v[`${b}/conn/in`] = ch === 4 ? 3 : ch;
    v[`${b}/conn/altgrp`] = "OFF";
    v[`${b}/conn/altin`] = 1;
    v[`${b}/set/trim`] = 0;
    v[`${b}/set/$mode`] = ch === 7 ? "ST" : "M";
  }
  Object.assign(v, {
    "/io/in/LCL/3/g": 30.5, "/ch/3/in/set/$g": 30.5, "/ch/4/in/set/$g": 30.5, "/ch/4/in/set/trim": 2,
    "/io/in/LCL/5/g": 20.5, "/ch/5/in/set/$g": 20.5, "/ch/5/mute": 1,
  }, over);
  return v;
}
const DESC: Record<string, string> = { "/io/in/LCL/3": IO_IN, "/io/in/LCL/5": IO_IN };
for (const ch of [3, 4, 5]) DESC[`/ch/${ch}/in/set`] = IN_SET;

/** Como a WING: o ganho da fonte aparece no espelho $g dos canais que usam essa fonte. */
function mirror(msg: { address: string; args: { value: unknown }[] }, values: Map<string, string | number>) {
  const m = /^\/io\/in\/LCL\/(\d+)\/g$/.exec(msg.address);
  if (!m) return;
  for (let ch = 1; ch <= 40; ch++) {
    if (values.get(`/ch/${ch}/in/conn/grp`) === "LCL" && String(values.get(`/ch/${ch}/in/conn/in`)) === m[1]) {
      values.set(`/ch/${ch}/in/set/$g`, msg.args[0]!.value as number);
    }
  }
}

async function withClient(
  initial: Record<string, string | number>,
  fn: (c: WingClient, fake: Awaited<ReturnType<typeof fakeWing>>) => Promise<void>,
  desc = DESC,
) {
  const fake = await fakeWing(initial, desc, mirror);
  const client = new WingClient("127.0.0.1", { ports: fake.ports, allowWrites: true });
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

const sug = (over: Partial<Suggestion>): Suggestion => ({
  id: "x", key: "gain:3", kind: "gain-down", channel: 3, title: "", detail: "", deltaDb: -12, autoAllowed: true,
  status: "applying", createdAt: 0, updatedAt: 0, gainAtCreate: 30.5, ...over,
});
const cmds = (fake: { writes: Parameters<typeof describeMessage>[0][] }) => fake.writes.map(describeMessage);

test("grade do ganho: baixar arredonda para baixo, subir não passa do pedido, fica na faixa", () => {
  const d = { min: -2, max: 45.5, steps: 20 };
  assert.equal(snapGain(30.5, -12, d), 18);
  assert.equal(snapGain(30.5, 4, d), 33);
  assert.equal(snapGain(30.5, 5, d), 35.5);
  assert.equal(snapGain(0.5, -12, d), -2);
  assert.equal(snapGain(44, 10, d), 45.5);
  // Ganho atual fora da grade: nunca vai na direção contrária (revisão de 12/11).
  assert.equal(snapGain(20.3, 0.1, d), 20.3, "subir pouco não vira corte");
  assert.equal(snapGain(20.3, -3, d), 15.5);
  assert.equal(snapGain(-2, -3, d), -2, "já no mínimo");
});

test("ganho fora da grade e trims sem margem: termina e recusa, sem inverter a direção", async () => {
  await withClient(console40({ "/io/in/LCL/3/g": 20.3, "/ch/3/in/set/$g": 20.3, "/ch/4/in/set/$g": 20.3,
    "/ch/3/in/set/trim": 18, "/ch/4/in/set/trim": -18 }), async (client, fake) => {
    const r = await applySuggestion(client, sug({ deltaDb: -3 }));
    assert.ok(!r.ok && r.unavailable && /trim não tem margem/.test(r.error), !r.ok ? r.error : "");
    assert.equal(fake.writes.length, 0);
  });
});

test("entrada que também alimenta um canal estéreo: sem correção pela mesa", async () => {
  // CH 7 é estéreo em LCL 7 + LCL 8; o CH 8 (mono) usa LCL 8.
  await withClient(console40({ "/io/in/LCL/8/g": 30.5, "/ch/8/in/set/$g": 30.5 }), async (client, fake) => {
    const r = await applySuggestion(client, sug({ channel: 8 }));
    assert.ok(!r.ok && r.unavailable && /CH 7 \(estéreo\)/.test(r.error), !r.ok ? r.error : "");
    assert.equal(fake.writes.length, 0);
  }, { ...DESC, "/io/in/LCL/8": IO_IN, "/ch/8/in/set": IN_SET });
});

test("leitura do patch incompleta (UDP perdido): falha sem escrever nada", async () => {
  const v = console40();
  delete v["/ch/12/in/conn/in"];
  await withClient(v, async (client, fake) => {
    const r = await applySuggestion(client, sug({}));
    assert.ok(!r.ok && !r.unavailable && /patch incompleta/.test(r.error), !r.ok ? r.error : "");
    assert.equal(fake.writes.length, 0);
  });
});

test("ordem segura: o que abaixa o nível vai antes", () => {
  const w = (kind: PlannedWrite["kind"], from: number, to: number): PlannedWrite => ({ kind, channel: 1, path: kind, from, to, label: "" });
  assert.deepEqual(safeOrder([w("trim", 0, 6), w("gain", 30, 24)]).map((x) => x.kind), ["gain", "trim"]);
  assert.deepEqual(safeOrder([w("gain", 24, 30), w("trim", 6, 0)]).map((x) => x.kind), ["trim", "gain"]);
});

test("plano de baixar o ganho: só leitura, compensa o trim dos dois canais da mesma fonte", async () => {
  await withClient(console40(), async (client, fake) => {
    const plan = await planSuggestion(client, sug({}));
    assert.equal(fake.writes.length, 0, "o plano não escreve");
    assert.deepEqual(plan.map((w) => [w.path, w.from, w.to]), [
      ["/io/in/LCL/3/g", 30.5, 18],
      ["/ch/3/in/set/trim", 0, 12.5],
      ["/ch/4/in/set/trim", 2, 14.5],
    ]);
  });
});

test("aplicar: comandos exatos, ganho primeiro, leitura de volta; desfazer volta tudo na ordem segura", async () => {
  await withClient(console40(), async (client, fake) => {
    const r = await applySuggestion(client, sug({}));
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.deepEqual(cmds(fake), ["/io/in/LCL/3/g ,f 18", "/ch/3/in/set/trim ,f 12.5", "/ch/4/in/set/trim ,f 14.5"]);
    assert.deepEqual(r.commands, cmds(fake));
    fake.writes.length = 0;
    const u = await undoWrites(client, r.writes);
    assert.ok(u.ok, u.ok ? "" : u.error);
    assert.deepEqual(cmds(fake), ["/ch/3/in/set/trim ,f 0", "/ch/4/in/set/trim ,f 2", "/io/in/LCL/3/g ,f 30.5"]);
  });
});

test("trim sem margem: o passo diminui até a compensação caber", async () => {
  await withClient(console40({ "/ch/4/in/set/trim": 10 }), async (client) => {
    const plan = await planSuggestion(client, sug({}));
    assert.deepEqual(plan.map((w) => [w.path, w.to]), [
      ["/io/in/LCL/3/g", 23], ["/ch/3/in/set/trim", 7.5], ["/ch/4/in/set/trim", 17.5],
    ]);
  });
});

test("subir o ganho: trim desce antes e o ganho sobe por último", async () => {
  await withClient(console40(), async (client, fake) => {
    const r = await applySuggestion(client, sug({ kind: "gain-up", deltaDb: 4 }));
    assert.ok(r.ok);
    assert.deepEqual(cmds(fake), ["/ch/3/in/set/trim ,f -2.5", "/ch/4/in/set/trim ,f -0.5", "/io/in/LCL/3/g ,f 33"]);
  });
});

test("fonte sem ganho ajustável (USB): impossível pela mesa, nada escrito", async () => {
  await withClient(console40(), async (client, fake) => {
    const r = await applySuggestion(client, sug({ channel: 6 }));
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.unavailable);
    assert.ok(!r.ok && /USB/.test(r.error));
    assert.equal(fake.writes.length, 0);
  });
});

test("canal estéreo: sem correção pela mesa, nada escrito", async () => {
  await withClient(console40(), async (client, fake) => {
    const r = await applySuggestion(client, sug({ channel: 7 }));
    assert.ok(!r.ok && r.unavailable && /estéreo/.test(r.error), !r.ok ? r.error : "");
    assert.equal(fake.writes.length, 0);
  });
});

test("falha no meio: o ganho já baixado volta ao valor anterior", async () => {
  const desc = { ...DESC };
  delete desc["/ch/4/in/set"]; // a validação do trim do CH 4 não tem resposta
  await withClient(console40(), async (client, fake) => {
    const r = await applySuggestion(client, sug({}));
    assert.equal(r.ok, false);
    assert.ok(!r.ok && /Desfeito/.test(r.error), !r.ok ? r.error : "");
    assert.deepEqual(cmds(fake), [
      "/io/in/LCL/3/g ,f 18", "/ch/3/in/set/trim ,f 12.5", // feitos
      "/ch/3/in/set/trim ,f 0", "/io/in/LCL/3/g ,f 30.5", // desfeitos, do fim para o começo
    ]);
  }, desc);
});

test("desfazer recusa se alguém mexeu depois", async () => {
  await withClient(console40(), async (client, fake) => {
    const r = await applySuggestion(client, sug({}));
    assert.ok(r.ok);
    fake.values.set("/ch/3/in/set/trim", 3);
    fake.writes.length = 0;
    const u = await undoWrites(client, r.writes);
    assert.equal(u.ok, false);
    assert.equal(fake.writes.length, 0);
  });
});

test("desmutar: um comando com leitura de volta", async () => {
  await withClient(console40(), async (client, fake) => {
    const r = await applySuggestion(client, sug({ kind: "unmute", channel: 5, deltaDb: undefined }));
    assert.ok(r.ok);
    assert.deepEqual(cmds(fake), ["/ch/5/mute ,i 0"]);
  });
});

test("sem WING_ALLOW_WRITES nada sai, nem no automático", async () => {
  const fake = await fakeWing(console40(), DESC, mirror);
  const client = new WingClient("127.0.0.1", { ports: fake.ports, allowWrites: false });
  client.on("status", () => {});
  try {
    await client.start();
    const r = await applySuggestion(client, sug({}));
    assert.equal(r.ok, false);
    assert.equal(fake.writes.length, 0);
  } finally {
    client.close();
    fake.close();
  }
});
