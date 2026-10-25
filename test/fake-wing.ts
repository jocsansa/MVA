// Mesa falsa para testes: guarda valores escritos e responde GETs no formato da WING
// (',s' para strings/enums, ',sfi' para inteiros, ',sff' para floats). Não ecoa escritas.

import dgram from "node:dgram";
import net from "node:net";
import { once } from "node:events";
import { decodeMessage, encodeMessage, type OscArg, type OscMessage } from "../src/osc.ts";

const INT_PARAM = /\/(mute|altsrc|in|altin)$/;

/**
 * descriptions: texto de "<nó> ,s #" por caminho de nó (formato real da WING).
 * Consultas "#" são respondidas a partir daí e NÃO contam como escrita.
 */
export async function fakeWing(
  initial: Record<string, string | number> = {},
  descriptions: Record<string, string> = {},
) {
  const values = new Map<string, string | number>(Object.entries(initial));
  const writes: OscMessage[] = [];
  const queries: string[] = [];
  // Portas de cliente que a mesa falsa ignora (simula o socket "mudo" depois de reiniciar a mesa).
  const ignoredPorts = new Set<number>();
  const clientPorts = new Set<number>();
  const osc = dgram.createSocket("udp4");
  osc.on("message", (buf, rinfo) => {
    clientPorts.add(rinfo.port);
    if (ignoredPorts.has(rinfo.port)) return;
    const msg = decodeMessage(buf);
    const a = msg.args[0];
    if (a?.type === "s" && a.value === "#" && msg.args.length === 1) {
      queries.push(msg.address);
      const text = descriptions[msg.address];
      if (text !== undefined) {
        osc.send(encodeMessage({ address: msg.address, args: [{ type: "s", value: text }] }), rinfo.port, rinfo.address);
      }
      return;
    }
    if (a) {
      writes.push(msg);
      if (a.type !== "b") values.set(msg.address, a.value);
      return;
    }
    let v = values.get(msg.address);
    if (v === undefined && msg.address.endsWith("/name")) v = "";
    if (v === undefined && msg.address.endsWith("/mute")) v = 0;
    if (v === undefined) return;
    let args: OscArg[];
    if (typeof v === "string") args = [{ type: "s", value: v }];
    else if (/\/conn\/(in|altin)$/.test(msg.address)) {
      // Como a WING real: texto 1-based, inteiro 0-based.
      args = [{ type: "s", value: String(v) }, { type: "f", value: 0.06 }, { type: "i", value: v - 1 }];
    } else if (INT_PARAM.test(msg.address)) {
      args = [{ type: "s", value: String(v) }, { type: "f", value: v }, { type: "i", value: v }];
    } else args = [{ type: "s", value: v.toFixed(1) }, { type: "f", value: 0.5 }, { type: "f", value: v }];
    osc.send(encodeMessage({ address: msg.address, args }), rinfo.port, rinfo.address);
  });
  osc.bind(0, "127.0.0.1");
  await once(osc, "listening");
  const tcp = net.createServer((s) => s.on("error", () => {}));
  tcp.listen(0, "127.0.0.1");
  await once(tcp, "listening");
  const ports = { osc: osc.address().port, native: (tcp.address() as net.AddressInfo).port };
  return { ports, writes, queries, values, ignoredPorts, clientPorts, close: () => (osc.close(), tcp.close()) };
}
