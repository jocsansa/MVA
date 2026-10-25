import { test } from "node:test";
import assert from "node:assert/strict";
import {
  METER_CHANNEL,
  NativeDecoder,
  encodeChannelData,
  meterChannelsRequest,
  meterPortRequest,
  meterRenewRequest,
  parseChannelMeters,
} from "../src/native.ts";

const hex = (b: Buffer) => b.toString("hex");

test("sequência de medidores igual ao exemplo da documentação", () => {
  // →W dfd3d33737 ; →W dfd3d400000002dca001de ; →W dfd3d400000002
  assert.equal(hex(encodeChannelData(METER_CHANNEL, meterPortRequest(0x3737))), "dfd3d33737");
  assert.equal(hex(encodeChannelData(METER_CHANNEL, meterChannelsRequest(2, [2]))), "dfd3d400000002dca001de");
  assert.equal(hex(encodeChannelData(METER_CHANNEL, meterRenewRequest(2))), "dfd3d400000002");
});

test("escape de 0xdf seguido de 0xd0..0xde na transmissão", () => {
  // Doc: d702dfd10e02 -> ...d702dfded10e02
  const out = encodeChannelData(0, Buffer.from("d702dfd10e02", "hex"));
  assert.equal(hex(out), "dfd0d702dfded10e02");
  // 0xdf seguido de byte fora da faixa não muda
  assert.equal(hex(encodeChannelData(0, Buffer.from("d702dfaf0e02", "hex"))), "dfd0d702dfaf0e02");
});

test("decodificador desfaz o escape e troca de canal", () => {
  const got: [number, number][] = [];
  const d = new NativeDecoder((ch, b) => got.push([ch, b]));
  d.push(Buffer.from("dfd3d7dfded4abcf08", "hex"));
  assert.deepEqual(got.map(([, b]) => b.toString(16)), ["d7", "df", "d4", "ab", "cf", "8"]);
  assert.ok(got.every(([ch]) => ch === 3));
});

test("ida e volta codificador/decodificador", () => {
  const data = Buffer.from([0xdf, 0xd3, 0x01, 0xdf, 0xde, 0xdf]);
  const got: number[] = [];
  new NativeDecoder((_, b) => got.push(b)).push(encodeChannelData(3, data));
  assert.deepEqual(Buffer.from(got), data);
});

test("parse do pacote de medidores (1/256 dB, 8 valores por canal)", () => {
  const pkt = Buffer.alloc(4 + 2 * 8 * 2);
  pkt.writeUInt32BE(1, 0);
  pkt.writeInt16BE(-12 * 256, 4 + 4); // canal 1 outL = -12 dB
  pkt.writeInt16BE(-3 * 256 - 128, 4 + 16 + 6); // canal 2 outR = -3.5 dB
  const r = parseChannelMeters(pkt, 40);
  assert.ok(r);
  assert.equal(r.reportId, 1);
  assert.equal(r.meters.length, 2);
  assert.equal(r.meters[0]!.outL, -12);
  assert.equal(r.meters[1]!.outR, -3.5);
});

test("canal fora da faixa é rejeitado", () => {
  assert.throws(() => meterChannelsRequest(1, [41]));
});
