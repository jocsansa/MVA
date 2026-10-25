import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import net from "node:net";
import { once } from "node:events";
import { decodeMessage, encodeMessage, type OscMessage } from "../src/osc.ts";
import { NativeDecoder } from "../src/native.ts";
import { WingClient, applyChannelValue, parseDiscoveryReply, type ChannelState } from "../src/wing.ts";

test("parse da resposta de descoberta", () => {
  assert.deepEqual(parseDiscoveryReply("WING,192.168.1.62,PGM,ngc-full,S123,3.0.6"), {
    ip: "192.168.1.62",
    name: "PGM",
    model: "ngc-full",
    serial: "S123",
    firmware: "3.0.6",
  });
  assert.equal(parseDiscoveryReply("X32,1.2.3.4"), null);
});

test("applyChannelValue atualiza nome, mute, fader e ganho", () => {
  const chans: ChannelState[] = [{ index: 1, name: "", mute: null, faderDb: null, gainDb: null, meter: null }];
  const noop = () => {};
  applyChannelValue(chans, "/ch/1/name", { kind: "string", text: "Kick" }, noop);
  applyChannelValue(chans, "/ch/1/mute", { kind: "int", text: "1", raw: 1, value: 1 }, noop);
  applyChannelValue(chans, "/ch/1/fdr", { kind: "float", text: "-2.0", raw: 0.7, value: -2 }, noop);
  applyChannelValue(chans, "/ch/1/in/set/$g", { kind: "float", text: "20", raw: 0.4, value: 20 }, noop);
  applyChannelValue(chans, "/ch/1/$fdr", { kind: "float", text: "0", raw: 0, value: 0 }, noop); // ignorado
  assert.deepEqual(chans[0], { index: 1, name: "Kick", mute: true, faderDb: -2, gainDb: 20, meter: null });
});

// Mesa falsa local: responde aos GETs e registra tudo que o cliente envia.
test("cliente só envia leituras (GET sem argumentos) e lê os canais", async () => {
  const received: OscMessage[] = [];
  const fakeOsc = dgram.createSocket("udp4");
  fakeOsc.on("message", (buf, rinfo) => {
    const msg = decodeMessage(buf);
    received.push(msg);
    let reply: OscMessage | null = null;
    if (msg.address === "/ch/1/name") reply = { address: msg.address, args: [{ type: "s", value: "Vox" }] };
    if (msg.address === "/ch/1/mute")
      reply = { address: msg.address, args: [{ type: "s", value: "0" }, { type: "f", value: 0 }, { type: "i", value: 0 }] };
    if (reply) fakeOsc.send(encodeMessage(reply), rinfo.port, rinfo.address);
  });
  fakeOsc.bind(0, "127.0.0.1");
  await once(fakeOsc, "listening");

  const nativeBytes: number[] = [];
  const fakeNative = net.createServer((s) => {
    const dec = new NativeDecoder((ch, b) => nativeBytes.push(ch === 3 ? b : -1));
    s.on("data", (d) => dec.push(d));
    s.on("error", () => {});
  });
  fakeNative.listen(0, "127.0.0.1");
  await once(fakeNative, "listening");

  const client = new WingClient("127.0.0.1", {
    ports: { osc: fakeOsc.address().port, native: (fakeNative.address() as net.AddressInfo).port },
  });
  client.on("status", () => {});
  await client.start();
  await new Promise((r) => setTimeout(r, 200));
  client.close();
  fakeOsc.close();
  fakeNative.close();

  assert.ok(received.length >= 160, `esperava >=160 GETs, recebi ${received.length}`);
  for (const m of received) {
    assert.equal(m.args.length, 0, `mensagem com argumentos (escrita!) enviada: ${m.address}`);
  }
  assert.equal(client.channels[0]!.name, "Vox");
  assert.equal(client.channels[0]!.mute, false);
  // Pelo TCP só passou dado no canal 3 (medidores), nunca no canal 1 (parâmetros).
  assert.ok(nativeBytes.length > 0);
  assert.ok(nativeBytes.every((b) => b !== -1), "dados enviados fora do canal de medidores");
});

test("socket OSC mudo (mesa reiniciou): o cliente abre um socket novo e volta a ler", async () => {
  const { fakeWing } = await import("./fake-wing.ts");
  const fake = await fakeWing({ "/ch/1/name": "Vox" });
  const client = new WingClient("127.0.0.1", {
    ports: fake.ports,
    timing: { heartbeatMs: 100, silenceMs: 400 },
  });
  client.on("status", () => {});
  try {
    await client.start();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(fake.clientPorts.size, 1);
    // A mesa passa a ignorar o socket atual.
    const [first] = [...fake.clientPorts];
    fake.ignoredPorts.add(first!);
    fake.values.set("/ch/1/name", "Vox 2");
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(fake.clientPorts.size >= 2, "deveria ter aberto um socket novo");
    assert.equal(client.channels[0]!.name, "Vox 2");
    assert.ok(Date.now() - client.status.lastOscAt! < 1000);
  } finally {
    client.close();
    fake.close();
  }
});
