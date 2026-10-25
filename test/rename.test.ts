import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeMessage } from "../src/osc.ts";
import { fakeWing } from "./fake-wing.ts";
import { WingClient, describeMessage, renameMessage, validateChannelName } from "../src/wing.ts";

test("mensagem de renomear: /ch/N/name ,s", () => {
  const msg = renameMessage(36, "TESTE");
  assert.deepEqual(msg, { address: "/ch/36/name", args: [{ type: "s", value: "TESTE" }] });
  assert.equal(describeMessage(msg), '/ch/36/name ,s "TESTE"');
  assert.equal(encodeMessage(msg).toString("latin1"), "/ch/36/name\0,s\0\0TESTE\0\0\0");
});

test("validação do nome", () => {
  assert.equal(validateChannelName(1, "Kick"), null);
  assert.equal(validateChannelName(1, ""), null);
  assert.equal(validateChannelName(1, "1234567890123456"), null);
  assert.match(validateChannelName(1, "12345678901234567")!, /16/);
  assert.match(validateChannelName(0, "x")!, /Canal/);
  assert.match(validateChannelName(41, "x")!, /Canal/);
  assert.match(validateChannelName(1, "Voz Ação")!, /ASCII/);
});

test("com escrita desativada, renomear falha e nada é enviado", async () => {
  const fake = await fakeWing();
  const client = new WingClient("127.0.0.1", { ports: fake.ports });
  client.on("status", () => {});
  await client.start();
  await assert.rejects(client.setChannelName(36, "TESTE"), /Escrita desativada/);
  client.close();
  fake.close();
  assert.equal(fake.writes.length, 0);
});

test("renomear envia uma única escrita e confirma pela leitura", async () => {
  const fake = await fakeWing();
  const client = new WingClient("127.0.0.1", { ports: fake.ports, allowWrites: true });
  client.on("status", () => {});
  const log = console.log;
  console.log = () => {};
  try {
    await client.start();
    const { readBack } = await client.setChannelName(36, "TESTE");
    assert.equal(readBack, "TESTE");
    assert.deepEqual(fake.writes, [renameMessage(36, "TESTE")]);
    await assert.rejects(client.setChannelName(36, "nome comprido demais!"));
    assert.equal(fake.writes.length, 1);
  } finally {
    console.log = log;
    client.close();
    fake.close();
  }
});
