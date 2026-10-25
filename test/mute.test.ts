import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeMessage } from "../src/osc.ts";
import { WingClient, describeMessage, muteMessage } from "../src/wing.ts";
import { fakeWing } from "./fake-wing.ts";

test("mensagem de mute: /ch/N/mute ,i 0|1 (nunca toggle -1)", () => {
  assert.deepEqual(muteMessage(36, true), { address: "/ch/36/mute", args: [{ type: "i", value: 1 }] });
  assert.deepEqual(muteMessage(36, false), { address: "/ch/36/mute", args: [{ type: "i", value: 0 }] });
  assert.equal(describeMessage(muteMessage(36, false)), "/ch/36/mute ,i 0");
  assert.equal(encodeMessage(muteMessage(36, false)).toString("hex"), "2f63682f33362f6d75746500" + "2c690000" + "00000000");
});

test("com escrita desativada, mute falha e nada é enviado", async () => {
  const fake = await fakeWing({ "/ch/36/mute": 1 });
  const client = new WingClient("127.0.0.1", { ports: fake.ports });
  client.on("status", () => {});
  await client.start();
  await assert.rejects(client.setChannelMute(36, false), /Escrita desativada/);
  client.close();
  fake.close();
  assert.equal(fake.writes.length, 0);
});

test("desmutar e mutar enviam uma escrita cada e confirmam pela leitura", async () => {
  const fake = await fakeWing({ "/ch/36/mute": 1 });
  const client = new WingClient("127.0.0.1", { ports: fake.ports, allowWrites: true });
  client.on("status", () => {});
  const log = console.log;
  console.log = () => {};
  try {
    await client.start();
    assert.deepEqual(await client.setChannelMute(36, false), { readBack: false });
    assert.deepEqual(await client.setChannelMute(36, true), { readBack: true });
    assert.deepEqual(fake.writes, [muteMessage(36, false), muteMessage(36, true)]);
    await assert.rejects(client.setChannelMute(41, true), /Canal inválido/);
    assert.equal(fake.writes.length, 2);
  } finally {
    console.log = log;
    client.close();
    fake.close();
  }
});
