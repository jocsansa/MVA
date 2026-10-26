// Mesa WING simulada, para desenvolver e testar sem a mesa real.
//   npm run simulate           -> escuta em 127.0.0.1 (UDP 2223 OSC, UDP/TCP 2222)
//   CONSOLE_HOST=127.0.0.1 WING_ALLOW_WRITES=1 npm start
// Reproduz o que foi visto na WING real (firmware 3.1):
//   - GET responde ,s / ,sff / ,sfi; em ,sfi o inteiro é a posição na faixa (valor - mínimo)
//   - "/?" responde no endereço "/*"
//   - "<nó> ,s #" responde a descrição do nó no formato real
//   - "/*s" assina eventos (renovar a cada < 10 s)
//   - medidores pelo canal nativo 3 (TCP 2222), um pedido por conexão, dados por UDP
// Escritas só mudam o estado em memória deste processo.

import dgram from "node:dgram";
import net from "node:net";
import { decodeMessage, encodeMessage, type OscArg } from "./osc.ts";
import { NativeDecoder, METER_CHANNEL } from "./native.ts";
import { STRIP_KINDS } from "./strips.ts";

const HOST = process.env.SIM_HOST ?? "127.0.0.1";
const OSC_PORT = 2223;
const NATIVE_PORT = 2222;

type Kind = "int" | "lin" | "log" | "fader" | "list" | "string";
interface Def {
  type: Kind;
  min?: number;
  max?: number;
  unit?: string;
  steps?: number;
  options?: string[];
  maxLength?: number;
  /** Casas decimais no texto (como a WING mostra: "-6.0", "3.19"). */
  digits?: number;
}

const DEFS: Record<string, Def> = {
  name: { type: "string", maxLength: 16 },
  col: { type: "int", min: 1, max: 18 },
  mute: { type: "int", min: 0, max: 1 },
  $solo: { type: "int", min: 0, max: 1 },
  fdr: { type: "fader", min: -144, max: 10, unit: "dB", steps: 1024 },
  pan: { type: "lin", min: -100, max: 100, steps: 201 },
  on: { type: "int", min: 0, max: 1 },
  lvl: { type: "fader", min: -144, max: 10, unit: "dB", steps: 1024 },
  mode: { type: "list", options: ["PRE", "POST", "GRP"] },
  pre: { type: "int", min: 0, max: 1 },
  g: { type: "lin", min: -2, max: 45.5, unit: "dB", steps: 20 },
  $g: { type: "lin", min: -2, max: 45.5, unit: "dB", steps: 20 },
  altsrc: { type: "int", min: 0, max: 1 },
  grp: { type: "list", options: ["OFF", "LCL", "AUX", "A", "B", "C", "SC", "USB", "CRD", "MOD", "PLAY", "AES", "USR", "OSC"] },
  in: { type: "int", min: 1, max: 64 },
  altgrp: { type: "list", options: ["OFF", "LCL", "AUX", "A", "B", "C", "SC", "USB", "CRD", "MOD", "PLAY", "AES", "USR", "OSC"] },
  altin: { type: "int", min: 1, max: 64 },
  // EQ (/ch/N/eq) e filtro (/ch/N/flt), faixas da WING real (fixtures ch_1_eq, ch_1_flt).
  "eq/on": { type: "int", min: 0, max: 1 },
  "eq/mdl": { type: "list", options: ["STD", "SOUL", "E88", "E84", "F110", "PULSAR", "MACH4"] },
  mix: { type: "lin", min: 0, max: 125, unit: "%", steps: 126 },
  leq: { type: "list", options: ["PEQ", "SHV"] },
  heq: { type: "list", options: ["PEQ", "SHV"] },
  lc: { type: "int", min: 0, max: 1 },
  lcf: { type: "log", min: 20, max: 2000, unit: "Hz", steps: 641, digits: 1 },
  lcs: { type: "list", options: ["6", "12", "18", "24"] },
  hc: { type: "int", min: 0, max: 1 },
  hcf: { type: "log", min: 50, max: 20000, unit: "Hz", steps: 833, digits: 1 },
  hcs: { type: "list", options: ["6", "12"] },
  tf: { type: "int", min: 0, max: 1 },
  "flt/mdl": { type: "list", options: ["TILT", "MAX", "AP1", "AP2"] },
  tilt: { type: "lin", min: -6, max: 6, unit: "dB", steps: 49, digits: 2 },
  // Gate (/ch/N/gate) e compressor (/ch/N/dyn): estrutura PLAUSÍVEL, ainda não capturada da
  // WING real (o painel monta os controles pela descrição, então se adapta ao que vier).
  "gate/mdl": { type: "list", options: ["GATE", "DUCK"] },
  "gate/thr": { type: "lin", min: -80, max: 0, unit: "dB", steps: 161, digits: 1 },
  "gate/range": { type: "lin", min: 3, max: 60, unit: "dB", steps: 58, digits: 1 },
  "gate/att": { type: "lin", min: 0, max: 120, unit: "ms", steps: 121, digits: 1 },
  "gate/hld": { type: "log", min: 0.5, max: 2000, unit: "ms", steps: 101, digits: 1 },
  "gate/rel": { type: "log", min: 4, max: 4000, unit: "ms", steps: 101, digits: 1 },
  "gate/acc": { type: "lin", min: 0, max: 100, unit: "%", steps: 101 },
  "gate/ratio": { type: "list", options: ["1:1.5", "1:2", "1:3", "1:4", "GATE"] },
  "dyn/mdl": { type: "list", options: ["COMP", "EXP"] },
  "dyn/mix": { type: "lin", min: 0, max: 100, unit: "%", steps: 101 },
  "dyn/gain": { type: "lin", min: -6, max: 12, unit: "dB", steps: 37, digits: 1 },
  "dyn/thr": { type: "lin", min: -60, max: 0, unit: "dB", steps: 121, digits: 1 },
  "dyn/ratio": { type: "list", options: ["1.1", "1.3", "1.5", "2.0", "2.5", "3.0", "4.0", "5.0", "7.0", "10", "20", "50", "100"] },
  "dyn/knee": { type: "lin", min: 0, max: 5, steps: 6 },
  "dyn/det": { type: "list", options: ["PEAK", "RMS"] },
  "dyn/att": { type: "lin", min: 0, max: 120, unit: "ms", steps: 121, digits: 1 },
  "dyn/hld": { type: "log", min: 1, max: 200, unit: "ms", steps: 101, digits: 1 },
  "dyn/rel": { type: "log", min: 4, max: 4000, unit: "ms", steps: 101, digits: 1 },
  "dyn/env": { type: "list", options: ["LIN", "LOG"] },
  "dyn/auto": { type: "int", min: 0, max: 1 },
};
for (const b of ["l", "1", "2", "3", "4", "h"]) {
  DEFS[`${b}g`] = { type: "lin", min: -15, max: 15, unit: "dB", steps: 301, digits: 1 };
  DEFS[`${b}f`] = { type: "log", min: 20, max: 20000, unit: "Hz", steps: 961, digits: 1 };
  DEFS[`${b}q`] = { type: "log", min: 0.44, max: 10, steps: 181, digits: 2 };
}

/** Definição do parâmetro: primeiro "<nó>/<nome>" (mdl, on), depois só o nome. */
function defFor(path: string): Def | undefined {
  const parts = path.split("/");
  return DEFS[parts.slice(-2).join("/")] ?? DEFS[parts[parts.length - 1]!];
}

const values = new Map<string, string | number>();
const set = (path: string, v: string | number) => values.set(path, v);

// ---- estado inicial (nomes genéricos) ----
const CH_NAMES = ["Voz 1", "Voz 2", "Voz 3", "Voz 4", "Pregador", "Apoio", "Backing", "Teclado", "Guitarra 1", "Guitarra 2",
  "Violao", "Baixo", "Bumbo", "Caixa", "Caixa Bot", "Tom 1", "Surdo", "Chimbal", "Overhead", "Pads"];
for (const k of STRIP_KINDS) {
  for (let i = 1; i <= k.count; i++) {
    const b = `/${k.kind}/${i}`;
    const name = k.kind === "ch" ? (CH_NAMES[i - 1] ?? "") : k.kind === "bus" ? (i <= 6 ? `Retorno ${i}` : "") :
      k.kind === "main" ? ["PA", "Lobby", "Externo", "Live"][i - 1]! : k.kind === "mgrp" ? `MGRP.${i}` : "";
    set(`${b}/name`, name);
    set(`${b}/mute`, k.kind === "ch" && i > 20 ? 1 : 0);
    if (k.kind === "mgrp") continue;
    set(`${b}/col`, ((i - 1) % 18) + 1);
    set(`${b}/fdr`, k.kind === "ch" && i > 20 ? -144 : -5 - (i % 7) * 2);
    set(`${b}/$solo`, 0);
    if (k.kind !== "dca") set(`${b}/pan`, 0);
  }
}
for (let ch = 1; ch <= 40; ch++) {
  const local = ch <= 24;
  set(`/ch/${ch}/in/set/altsrc`, 0);
  set(`/ch/${ch}/in/conn/grp`, local ? "LCL" : "USB");
  set(`/ch/${ch}/in/conn/in`, ch);
  set(`/ch/${ch}/in/conn/altgrp`, "OFF");
  set(`/ch/${ch}/in/conn/altin`, 1);
  if (local) set(`/io/in/LCL/${ch}/g`, 20.5);
  set(`/ch/${ch}/in/set/$g`, local ? 20.5 : 0);
}
// EQ e filtro: canais de voz com cortes leves; o canal 40 usa outro modelo de EQ (não editável no painel).
for (let ch = 1; ch <= 40; ch++) {
  const e = `/ch/${ch}/eq`;
  const voice = ch <= 6;
  set(`${e}/on`, ch <= 20 ? 1 : 0);
  set(`${e}/mdl`, ch === 40 ? "SOUL" : "STD");
  set(`${e}/mix`, 100);
  const bands: [string, number, number, number][] = [
    ["l", 0, 80, 1], ["1", voice ? -3 : 0, 250, 2], ["2", voice ? -2.5 : 0, 500, 1.5],
    ["3", 0, 1500, 1], ["4", voice ? 2 : 0, 4000, 1], ["h", voice ? 1.5 : 0, 10000, 0.7],
  ];
  for (const [b, g, f, q] of bands) {
    set(`${e}/${b}g`, g);
    set(`${e}/${b}f`, f);
    set(`${e}/${b}q`, q);
  }
  set(`${e}/leq`, "SHV");
  set(`${e}/heq`, "SHV");
  const t = `/ch/${ch}/flt`;
  set(`${t}/lc`, ch <= 20 ? 1 : 0);
  set(`${t}/lcf`, ch === 13 ? 40 : 100);
  set(`${t}/lcs`, "24");
  set(`${t}/hc`, 0);
  set(`${t}/hcf`, 18000);
  set(`${t}/hcs`, "12");
  set(`${t}/tf`, 0);
  set(`${t}/mdl`, "TILT");
  set(`${t}/tilt`, 0);
}
// Gate e compressor: canais de voz com compressor ligado; bateria com gate ligado.
for (let ch = 1; ch <= 40; ch++) {
  const g = `/ch/${ch}/gate`;
  const drum = ch >= 13 && ch <= 17;
  set(`${g}/on`, drum ? 1 : 0);
  set(`${g}/mdl`, "GATE");
  set(`${g}/thr`, drum ? -28 : -60);
  set(`${g}/range`, 40);
  set(`${g}/att`, 0.5);
  set(`${g}/hld`, 20);
  set(`${g}/rel`, 150);
  set(`${g}/acc`, 0);
  set(`${g}/ratio`, "GATE");
  const d = `/ch/${ch}/dyn`;
  set(`${d}/on`, ch <= 12 ? 1 : 0);
  set(`${d}/mdl`, "COMP");
  set(`${d}/mix`, 100);
  set(`${d}/gain`, ch <= 6 ? 3 : 0);
  set(`${d}/thr`, ch <= 6 ? -24 : -18);
  set(`${d}/ratio`, ch <= 6 ? "3.0" : "2.0");
  set(`${d}/knee`, 2);
  set(`${d}/det`, "RMS");
  set(`${d}/att`, 10);
  set(`${d}/hld`, 10);
  set(`${d}/rel`, 120);
  set(`${d}/env`, "LOG");
  set(`${d}/auto`, 0);
}
// Envios: canais e aux -> buses 1..16 e MX1..8; bus e main -> MX1..8 (com pre em vez de mode).
for (const [kind, count] of [["ch", 40], ["aux", 8]] as const) {
  for (let i = 1; i <= count; i++) {
    for (const d of [...Array.from({ length: 16 }, (_, j) => String(j + 1)), ...Array.from({ length: 8 }, (_, j) => `MX${j + 1}`)]) {
      const b = `/${kind}/${i}/send/${d}`;
      const active = kind === "ch" && i <= 20 && Number(d) <= 6 && (i + Number(d)) % 3 !== 0;
      set(`${b}/on`, active ? 1 : 0);
      set(`${b}/lvl`, active ? -6 - ((i * 7 + Number(d) * 3) % 20) : -144);
      set(`${b}/mode`, d.startsWith("MX") ? "POST" : "PRE");
    }
  }
}
for (const [kind, count] of [["bus", 16], ["main", 4]] as const) {
  for (let i = 1; i <= count; i++) {
    for (let m = 1; m <= 8; m++) {
      const b = `/${kind}/${i}/send/MX${m}`;
      const active = kind === "main" && i === 1 && m <= 2;
      set(`${b}/on`, active ? 1 : 0);
      set(`${b}/lvl`, active ? 0 : -144);
      set(`${b}/pre`, 0);
    }
  }
}

// ---- formatação no estilo da WING ----
function fmtNumber(n: number, digits?: number): string {
  if (n <= -144) return "-oo";
  const abs = Math.abs(n);
  if (abs >= 1000) {
    return (n / 1000).toFixed(2).replace(".", "k"); // 10020 -> "10k02", como a WING
  }
  if (digits !== undefined) return n.toFixed(digits);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Como a mesa: limita à faixa e arredonda para o passo mais próximo (lin e log). */
function quantize(def: Def | undefined, v: number): number {
  if (!def || def.min === undefined || def.max === undefined || (def.type !== "lin" && def.type !== "log")) return v;
  const x = Math.min(def.max, Math.max(def.min, v));
  if (!def.steps || def.steps < 2) return x;
  const n = def.steps - 1;
  if (def.type === "log") return def.min * Math.pow(def.max / def.min, Math.round((Math.log(x / def.min) / Math.log(def.max / def.min)) * n) / n);
  return def.min + ((def.max - def.min) * Math.round(((x - def.min) / (def.max - def.min)) * n)) / n;
}

function reply(path: string, v: string | number): OscArg[] {
  const def = defFor(path);
  if (typeof v === "string") return [{ type: "s", value: v }];
  if (def?.type === "int") {
    const min = def.min ?? 0;
    const max = def.max ?? 1;
    // Igual à WING real: o inteiro é a posição na faixa.
    return [{ type: "s", value: String(v) }, { type: "f", value: (v - min) / (max - min || 1) }, { type: "i", value: v - min }];
  }
  const min = def?.min ?? -144;
  const max = def?.max ?? 10;
  return [{ type: "s", value: fmtNumber(v, def?.digits) }, { type: "f", value: Math.max(0, Math.min(1, (v - min) / (max - min))) }, { type: "f", value: v }];
}

function describeType(def: Def): string {
  switch (def.type) {
    case "list":
      return `list [${def.options!.join(", ")}]`;
    case "string":
      return `string [${def.maxLength}]`;
    case "int":
      return `int [${def.min} .. ${def.max}]`;
    default: {
      const min = def.type === "fader" ? "-oo" : fmtNumber(def.min!, def.digits);
      const max = def.type === "fader" ? "10.0" : def.max! > 0 && def.type === "lin" && def.min! < 0 ? `+${fmtNumber(def.max!, def.digits)}` : fmtNumber(def.max!, def.digits);
      return `${def.type} [${min} .. ${max}${def.unit ? " " + def.unit : ""}]${def.steps ? `, ${def.steps} steps` : ""}`;
    }
  }
}

/** Descrição de nó ("<nó> ,s #"): filhos diretos com valor e tipo; subnós como (node). */
function describe(node: string): string | null {
  const params: string[] = [];
  const nodes = new Set<string>();
  for (const [path, v] of values) {
    if (!path.startsWith(node + "/")) continue;
    const rest = path.slice(node.length + 1);
    const slash = rest.indexOf("/");
    if (slash >= 0) {
      nodes.add(rest.slice(0, slash));
      continue;
    }
    const def = defFor(path);
    if (!def) continue;
    const text = typeof v === "number" ? fmtNumber(v, def.digits) : v;
    params.push(`  ${rest.padEnd(15)}${text.padEnd(20)}${describeType(def)}`);
  }
  if (!params.length && !nodes.size) return null;
  return [...[...nodes].map((n) => `  ${n.padEnd(15)}(node)`), ...params].join("\n") + "\n";
}

// ---- OSC ----
const osc = dgram.createSocket("udp4");
let subscriber: { port: number; address: string; until: number } | null = null;

function send(path: string, args: OscArg[], port: number, address: string): void {
  osc.send(encodeMessage({ address: path, args }), port, address);
}

function notify(path: string): void {
  if (!subscriber || Date.now() > subscriber.until) return;
  const v = values.get(path);
  if (v !== undefined) send(path, reply(path, v), subscriber.port, subscriber.address);
}

osc.on("message", (buf, r) => {
  let m;
  try {
    m = decodeMessage(buf);
  } catch {
    return;
  }
  const a = m.args[0];
  if (m.address === "/?") {
    send("/*", [{ type: "s", value: `WING,${HOST},SIMULADOR,wing-sim,SIM000,3.1-simulado` }], r.port, r.address);
    return;
  }
  if (m.address === "/*s" || m.address === "/*S") {
    subscriber = { port: r.port, address: r.address, until: Date.now() + 10000 };
    return;
  }
  if (a?.type === "s" && (a.value === "#" || a.value === "?") && m.args.length === 1) {
    const d = describe(m.address);
    if (d) send(m.address, [{ type: "s", value: d }], r.port, r.address);
    return;
  }
  if (a) {
    // Escrita: só muda o estado simulado.
    if (!values.has(m.address) || a.type === "b") {
      send("/*", [{ type: "s", value: "NODE NOT FOUND" }], r.port, r.address);
      return;
    }
    const def = defFor(m.address);
    values.set(m.address, typeof a.value === "number" ? quantize(def, a.value) : (a.value as string));
    console.log(`[escrita simulada] ${m.address} = ${JSON.stringify(a.value)}`);
    const g = /^\/io\/in\/LCL\/(\d+)\/g$/.exec(m.address);
    if (g) {
      values.set(`/ch/${g[1]}/in/set/$g`, a.value as number);
      notify(`/ch/${g[1]}/in/set/$g`);
    }
    notify(m.address);
    return;
  }
  const v = values.get(m.address);
  if (v !== undefined) send(m.address, reply(m.address, v), r.port, r.address);
});

// ---- descoberta (UDP 2222) ----
const discovery = dgram.createSocket("udp4");
discovery.on("message", (buf, r) => {
  if (buf.toString("latin1") === "WING?") {
    discovery.send(`WING,${HOST},SIMULADOR,wing-sim,SIM000,3.1-simulado`, r.port, r.address);
  }
});

// ---- medidores (TCP 2222, canal nativo 3) ----
interface MeterClient {
  address: string;
  port: number | null;
  reportId: number;
  layout: { kind: string; index: number; words: number }[];
  until: number;
}
const TOKEN_KIND: Record<number, { kind: string; words: number }> = {
  0xa0: { kind: "ch", words: 8 }, 0xa1: { kind: "aux", words: 8 }, 0xa2: { kind: "bus", words: 8 },
  0xa3: { kind: "main", words: 8 }, 0xa4: { kind: "mtx", words: 8 }, 0xa5: { kind: "dca", words: 4 },
};
const meterClients = new Set<MeterClient>();

const tcp = net.createServer((sock) => {
  const client: MeterClient = { address: sock.remoteAddress?.replace("::ffff:", "") ?? HOST, port: null, reportId: 0, layout: [], until: 0 };
  meterClients.add(client);
  const bytes: number[] = [];
  const dec = new NativeDecoder((ch, b) => {
    if (ch === METER_CHANNEL) bytes.push(b);
  });
  sock.on("data", (d) => {
    dec.push(d);
    parseMeterTokens(bytes, client);
  });
  sock.on("error", () => {});
  sock.on("close", () => meterClients.delete(client));
});

/** Interpreta os tokens recebidos no canal 3 (Table 4. Meter Request Tokens). */
function parseMeterTokens(bytes: number[], client: MeterClient): void {
  let i = 0;
  while (i < bytes.length) {
    const t = bytes[i]!;
    if (t === 0xd3) {
      if (i + 3 > bytes.length) break;
      client.port = (bytes[i + 1]! << 8) | bytes[i + 2]!;
      i += 3;
    } else if (t === 0xd4) {
      if (i + 5 > bytes.length) break;
      client.reportId = ((bytes[i + 1]! << 24) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 8) | bytes[i + 4]!) >>> 0;
      client.until = Date.now() + 5000; // repetir o report id renova por 5 s
      i += 5;
    } else if (t === 0xdc) {
      const end = bytes.indexOf(0xde, i);
      if (end < 0) break;
      const layout: MeterClient["layout"] = [];
      let cur: { kind: string; words: number } | null = null;
      for (let j = i + 1; j < end; j++) {
        const b = bytes[j]!;
        if (TOKEN_KIND[b]) cur = TOKEN_KIND[b]!;
        else if (cur && b <= 0x7f) layout.push({ kind: cur.kind, index: b + 1, words: cur.words });
      }
      client.layout = layout; // um pedido novo substitui o anterior, como na WING real
      i = end + 1;
    } else {
      i++;
    }
  }
  bytes.splice(0, i);
}

/** Ganho do gate e do compressor simulados para um nível de entrada (dB). */
function dynGains(ch: number, input: number): [number, number] {
  const num = (p: string) => { const v = values.get(p); return typeof v === "number" ? v : 0; };
  const gateOn = num(`/ch/${ch}/gate/on`) === 1;
  const gate = gateOn && input < num(`/ch/${ch}/gate/thr`) ? -num(`/ch/${ch}/gate/range`) : 0;
  const ratio = Number(values.get(`/ch/${ch}/dyn/ratio`)) || 1;
  const over = input - num(`/ch/${ch}/dyn/thr`);
  const dyn = num(`/ch/${ch}/dyn/on`) === 1 && over > 0 ? -over * (1 - 1 / ratio) : 0;
  return [gate, dyn];
}

const meterUdp = dgram.createSocket("udp4");
let t = 0;
setInterval(() => {
  t += 0.05;
  for (const c of meterClients) {
    if (!c.port || !c.layout.length || Date.now() > c.until) continue;
    const words = c.layout.reduce((n, l) => n + l.words, 0);
    const pkt = Buffer.alloc(4 + words * 2);
    pkt.writeUInt32BE(c.reportId, 0);
    let off = 4;
    for (const l of c.layout) {
      const fdr = values.get(`/${l.kind}/${l.index}/fdr`);
      const mute = values.get(`/${l.kind}/${l.index}/mute`);
      const silent = mute === 1 || fdr === -144 || (l.kind === "ch" && l.index > 20);
      const level = silent ? -128 : -30 + 12 * Math.sin(t * 2 + l.index) + (typeof fdr === "number" ? fdr / 3 : 0);
      const words = Array.from({ length: l.words }, (_, w) => Math.max(-128, level - (w % 2) * 1.5));
      // Canal: palavra 5 = ganho do gate, 7 = ganho do compressor (Table 5), em dB (0 = sem redução).
      if (l.kind === "ch" && l.words >= 8) [words[5], words[7]] = dynGains(l.index, silent ? -128 : level + 10);
      words.forEach((v, w) => pkt.writeInt16BE(Math.round(v * 256), off + w * 2));
      off += l.words * 2;
    }
    meterUdp.send(pkt, c.port, c.address);
  }
}, 50);

osc.bind(OSC_PORT, HOST, () => {
  discovery.bind(NATIVE_PORT, HOST, () => {
    tcp.listen(NATIVE_PORT, HOST, () => {
      console.log(`Mesa simulada pronta em ${HOST} (OSC UDP ${OSC_PORT}, nativo UDP/TCP ${NATIVE_PORT}).`);
      console.log(`Em outro terminal: CONSOLE_HOST=${HOST} WING_ALLOW_WRITES=1 npm start`);
    });
  });
});
