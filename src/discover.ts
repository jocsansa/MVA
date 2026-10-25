// Procura mesas WING na rede: envia o datagrama 'WING?' (UDP 2222) em broadcast
// e lista as respostas 'WING,<ip>,<nome>,<modelo>,<serial>,<firmware>'. Só leitura.

import dgram from "node:dgram";
import { NATIVE_PORT, parseDiscoveryReply } from "./wing.ts";

const target = process.argv[2] ?? "255.255.255.255";
const sock = dgram.createSocket("udp4");
const seen = new Set<string>();

sock.on("message", (buf, rinfo) => {
  const info = parseDiscoveryReply(buf.toString("latin1"));
  if (!info || seen.has(rinfo.address)) return;
  seen.add(rinfo.address);
  console.log(`WING encontrada em ${info.ip}: nome="${info.name}" modelo=${info.model} firmware=${info.firmware}`);
});

sock.bind(0, () => {
  sock.setBroadcast(true);
  sock.send("WING?", NATIVE_PORT, target);
  console.log(`Procurando WING (${target}:${NATIVE_PORT})...`);
  setTimeout(() => {
    if (seen.size === 0) console.log("Nenhuma WING respondeu.");
    sock.close();
  }, 2000);
});
