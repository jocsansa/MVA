import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeMessage, encodeMessage, parseWingValue } from "../src/osc.ts";

const hex = (s: string) => Buffer.from(s, "hex");

test("GET /ch/1/fdr gera GET com type tag vazia (forma compatível da documentação)", () => {
  // Doc: ->W, 12 B: /ch/1/fdr~~~  (aqui com ',' de type tag vazia, forma "mais compatível")
  const buf = encodeMessage({ address: "/ch/1/fdr", args: [] });
  assert.equal(buf.toString("latin1"), "/ch/1/fdr\0\0\0,\0\0\0");
});

test("decodifica resposta ,sff do fader (bytes da documentação)", () => {
  const msg = decodeMessage(hex("2f63682f312f6664720000002c736666000000002d6f6f0000000000c3100000"));
  assert.equal(msg.address, "/ch/1/fdr");
  assert.deepEqual(parseWingValue(msg.args), { kind: "float", text: "-oo", raw: 0, value: -144 });
});

test("decodifica resposta ,sfi do mute (bytes da documentação)", () => {
  const msg = decodeMessage(hex("2f63682f312f6d75746500002c73666900000000310000003f80000000000001"));
  assert.equal(msg.address, "/ch/1/mute");
  assert.deepEqual(parseWingValue(msg.args), { kind: "int", text: "1", raw: 1, value: 1 });
});

test("ida e volta com todos os tipos", () => {
  const original = {
    address: "/x/y",
    args: [
      { type: "i" as const, value: -5 },
      { type: "f" as const, value: 0.5 },
      { type: "s" as const, value: "Vocal 1" },
      { type: "b" as const, value: Buffer.from([1, 2, 3]) },
    ],
  };
  const decoded = decodeMessage(encodeMessage(original));
  assert.deepEqual(decoded, original);
});

test("mensagem sem type tag string é aceita", () => {
  assert.deepEqual(decodeMessage(Buffer.from("/?\0\0", "latin1")), { address: "/?", args: [] });
});

test("nome vazio vira string vazia", () => {
  const msg = decodeMessage(encodeMessage({ address: "/ch/3/name", args: [{ type: "s", value: "" }] }));
  assert.deepEqual(parseWingValue(msg.args), { kind: "string", text: "" });
});
