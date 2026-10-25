import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeMessage } from "../src/osc.ts";
import {
  WingClient,
  describeMessage,
  faderMessage,
  gainAddress,
  gainMessage,
  parseConnIndex,
  validateFader,
  validateGain,
} from "../src/wing.ts";
import { fakeWing } from "./fake-wing.ts";

test("mensagem de fader: /ch/N/fdr ,f <dB> (exemplo da doc: ,f -3.0)", () => {
  assert.deepEqual(faderMessage(2, -3), { address: "/ch/2/fdr", args: [{ type: "f", value: -3 }] });
  assert.equal(describeMessage(faderMessage(2, -3)), "/ch/2/fdr ,f -3");
  // Bytes: "/ch/2/fdr" + ",f" + float -3.0 big-endian (c0400000)
  assert.equal(encodeMessage(faderMessage(2, -3)).toString("hex"), "2f63682f322f666472000000" + "2c660000" + "c0400000");
  assert.equal(faderMessage(1, -2.345).args[0]!.value, -2.3);
});

test("validação de fader", () => {
  assert.equal(validateFader(1, -144), null);
  assert.equal(validateFader(1, 10), null);
  assert.match(validateFader(1, 10.1)!, /\+10/);
  assert.match(validateFader(1, -145)!, /-144/);
  assert.match(validateFader(1, NaN)!, /inválido/);
  assert.match(validateFader(0, 0)!, /Canal/);
});

test("endereço de ganho só para grupos com headamp (doc: LCL, A, B, C, SC)", () => {
  assert.equal(gainAddress({ grp: "LCL", in: 5 }), "/io/in/LCL/5/g");
  assert.equal(gainAddress({ grp: "A", in: 48 }), "/io/in/A/48/g");
  assert.equal(gainAddress({ grp: "SC", in: 32 }), "/io/in/SC/32/g");
  assert.equal(gainAddress({ grp: "SC", in: 33 }), null);
  assert.equal(gainAddress({ grp: "USB", in: 1 }), null);
  assert.equal(gainAddress({ grp: "OFF", in: 1 }), null);
  assert.deepEqual(gainMessage({ grp: "LCL", in: 5 }, 30), { address: "/io/in/LCL/5/g", args: [{ type: "f", value: 30 }] });
  assert.throws(() => gainMessage({ grp: "USB", in: 1 }, 30));
});

test("validação de ganho", () => {
  assert.equal(validateGain(-3), null);
  assert.equal(validateGain(45.5), null);
  assert.match(validateGain(46)!, /45.5/);
  assert.match(validateGain(-4)!, /-3/);
});

// Descrição real de uma entrada AES50 (fixture capturada da mesa): g vai de -2.0 a 45.5 dB.
const IO_IN_DESC = readFileSync(new URL("./fixtures/io_in_A_1.txt", import.meta.url), "utf8");
const IO_DESCRIPTIONS = { "/io/in/LCL/5": IO_IN_DESC, "/io/in/A/12": IO_IN_DESC, "/io/in/A/5": IO_IN_DESC };

async function withClient(initial: Record<string, string | number>, fn: (c: WingClient, fake: Awaited<ReturnType<typeof fakeWing>>) => Promise<void>) {
  const fake = await fakeWing(initial, IO_DESCRIPTIONS);
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

test("fader: uma escrita e confirmação pela leitura", async () => {
  await withClient({ "/ch/36/fdr": -144 }, async (client, fake) => {
    assert.deepEqual(await client.setChannelFader(36, -20), { readBack: -20 });
    assert.deepEqual(fake.writes, [faderMessage(36, -20)]);
    await assert.rejects(client.setChannelFader(36, 11));
    assert.equal(fake.writes.length, 1);
  });
});

test("ganho: lê a fonte do canal e escreve só no headamp dela", async () => {
  await withClient(
    {
      "/ch/5/in/set/altsrc": 0,
      "/ch/5/in/conn/grp": "LCL",
      "/ch/5/in/conn/in": 5,
      "/io/in/LCL/5/g": 28,
      "/ch/5/in/set/$g": 28,
    },
    async (client, fake) => {
      const r = await client.setChannelGain(5, 30);
      assert.deepEqual(r, { readBack: 30, source: { grp: "LCL", in: 5 } });
      assert.deepEqual(fake.writes, [gainMessage({ grp: "LCL", in: 5 }, 30)]);
    },
  );
});

test("ganho: usa a entrada alternativa quando altsrc = 1", async () => {
  await withClient(
    {
      "/ch/7/in/set/altsrc": 1,
      "/ch/7/in/conn/grp": "LCL",
      "/ch/7/in/conn/in": 7,
      "/ch/7/in/conn/altgrp": "A",
      "/ch/7/in/conn/altin": 12,
      "/io/in/A/12/g": 10,
      "/ch/7/in/set/$g": 10,
    },
    async (client, fake) => {
      const src = await client.getChannelSource(7);
      assert.deepEqual(src, { grp: "A", in: 12, alt: true, gainAddress: "/io/in/A/12/g" });
      await client.setChannelGain(7, 12);
      assert.deepEqual(fake.writes.map((w) => w.address), ["/io/in/A/12/g"]);
    },
  );
});

test("ganho: fonte sem headamp (USB) é recusada sem escrever nada", async () => {
  await withClient(
    { "/ch/21/in/set/altsrc": 0, "/ch/21/in/conn/grp": "USB", "/ch/21/in/conn/in": 1 },
    async (client, fake) => {
      await assert.rejects(client.setChannelGain(21, 10), /sem ganho ajustável/);
      assert.equal(fake.writes.length, 0);
    },
  );
});

test("com escrita desativada, fader e ganho não enviam nada", async () => {
  const fake = await fakeWing({ "/ch/5/in/set/altsrc": 0, "/ch/5/in/conn/grp": "LCL", "/ch/5/in/conn/in": 5 });
  const client = new WingClient("127.0.0.1", { ports: fake.ports });
  client.on("status", () => {});
  try {
    await client.start();
    await assert.rejects(client.setChannelFader(5, -10), /Escrita desativada/);
    await assert.rejects(client.setChannelGain(5, 20), /Escrita desativada/);
  } finally {
    client.close();
    fake.close();
  }
  assert.equal(fake.writes.length, 0);
});

test("número da entrada vem do texto 1-based (resposta real da WING: \"5\", 4)", () => {
  // Resposta real de /ch/2/in/conn/in: ["5", 0.0634..., 4] — a fonte é A 5, não A 4.
  assert.equal(parseConnIndex({ kind: "int", text: "5", raw: 0.0634920671582222, value: 4 }), 5);
  assert.equal(parseConnIndex({ kind: "int", text: "1", raw: 0, value: 0 }), 1);
  assert.throws(() => parseConnIndex({ kind: "string", text: "x" }));
});

test("ganho: se a fonte não confere com o $g do canal, nada é escrito", async () => {
  await withClient(
    {
      "/ch/2/in/set/altsrc": 0,
      "/ch/2/in/conn/grp": "A",
      "/ch/2/in/conn/in": 5,
      "/io/in/A/5/g": 18,
      "/ch/2/in/set/$g": 15.5,
    },
    async (client, fake) => {
      await assert.rejects(client.setChannelGain(2, 17.5), /Fonte não confere/);
      assert.equal(fake.writes.length, 0);
    },
  );
});
