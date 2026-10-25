// Cliente da WING.
// - OSC em UDP 2223: GETs (endereço sem argumentos) e assinatura de eventos /*s.
// - Medidores: requisição pelo protocolo nativo em TCP 2222 (canal 3), dados chegam em UDP.
// - Escrita: só pelo método privado write(), e só com allowWrites ligado.
// Portas e endereços: WING Remote Protocols (P.-G. Maillot).

import dgram from "node:dgram";
import net from "node:net";
import { EventEmitter } from "node:events";
import { decodeMessage, encodeMessage, parseWingValue, type OscMessage, type WingValue } from "./osc.ts";
import {
  encodeParamValue,
  isSafePath,
  parseNodeDescription,
  splitPath,
  type NodeChild,
  type ParamDesc,
} from "./schema.ts";
import {
  METER_CHANNEL,
  encodeChannelData,
  meterPortRequest,
  meterRenewRequest,
  meterRequestMulti,
} from "./native.ts";
import {
  STRIP_KINDS,
  applyStripValue,
  createStrips,
  METER_REPORT_ID,
  meterGroups,
  splitMeterPacket,
  stripPaths,
  type StripState,
  type Strips,
} from "./strips.ts";

export const OSC_PORT = 2223;
export const NATIVE_PORT = 2222;
export const CHANNEL_COUNT = 40;

const SUBSCRIBE_EVERY_MS = 8000; // assinatura morre após 10 s
const OSC_SILENCE_MS = 12000; // sem resposta OSC por esse tempo: recria o socket
const METER_RENEW_EVERY_MS = 3000; // medidores param após 5 s

/** Estado de um canal: mesmo formato de qualquer strip. */
export type ChannelState = StripState;

/** Endereços lidos por canal. */
export function channelAddresses(ch: number) {
  return {
    name: `/ch/${ch}/name`,
    mute: `/ch/${ch}/mute`,
    fader: `/ch/${ch}/fdr`,
    // Espelho do ganho do headamp da fonte conectada (depende do tipo de fonte).
    gain: `/ch/${ch}/in/set/$g`,
  };
}


export const NAME_MAX_LENGTH = 16; // "/ch/N/name  S  16 chars max"

/** Retorna a mensagem de erro, ou null se o nome é aceitável. */
export function isValidChannel(ch: number): boolean {
  return Number.isInteger(ch) && ch >= 1 && ch <= CHANNEL_COUNT;
}

export function validateChannelName(ch: number, name: string): string | null {
  if (!isValidChannel(ch)) return `Canal inválido: ${ch}`;
  if (name.length > NAME_MAX_LENGTH) return `Nome com mais de ${NAME_MAX_LENGTH} caracteres`;
  // ASCII imprimível: a WING trabalha com strings ASCII.
  if (!/^[\x20-\x7e]*$/.test(name)) return "Use só letras sem acento, números e símbolos ASCII";
  return null;
}

/** Mensagem OSC de renomear: /ch/N/name ,s "<nome>". */
export function renameMessage(ch: number, name: string): OscMessage {
  return { address: channelAddresses(ch).name, args: [{ type: "s", value: name }] };
}

/**
 * Mensagem de mute: /ch/N/mute ,i 0|1 ("I 0..1 Channel N mute").
 * Sempre valor explícito; o modo toggle (-1) da WING não é usado de propósito.
 */
export function muteMessage(ch: number, muted: boolean): OscMessage {
  return { address: channelAddresses(ch).mute, args: [{ type: "i", value: muted ? 1 : 0 }] };
}

// "/ch/N/fdr  F  -144..10" (−144 = −∞)
export const FADER_MIN_DB = -144;
export const FADER_MAX_DB = 10;

export function validateFader(ch: number, db: number): string | null {
  if (!isValidChannel(ch)) return `Canal inválido: ${ch}`;
  if (!Number.isFinite(db)) return "Valor de fader inválido";
  if (db < FADER_MIN_DB || db > FADER_MAX_DB) return `Fader deve ficar entre -144 (-∞) e +10 dB`;
  return null;
}

/** Mensagem de fader: /ch/N/fdr ,f <dB>. A WING interpreta o float em dB. */
export function faderMessage(ch: number, db: number): OscMessage {
  return { address: channelAddresses(ch).fader, args: [{ type: "f", value: Math.round(db * 10) / 10 }] };
}

// Ganho de entrada fica no headamp da fonte: "/io/in/<grp>/<n>/g  F  -3..45.5".
// A documentação só lista /g para estes grupos (LCL 1..24, AES50 A/B/C 1..48, SC 1..32).
export const GAIN_GROUPS: Record<string, number> = { LCL: 24, A: 48, B: 48, C: 48, SC: 32 };
export const GAIN_MIN_DB = -3;
export const GAIN_MAX_DB = 45.5;

export interface InputSource {
  grp: string;
  in: number;
}

/** Número da entrada a partir da resposta de /conn/in: usa o texto (1-based). */
export function parseConnIndex(v: WingValue): number {
  const n = Number(v.text);
  if (!Number.isInteger(n)) throw new Error(`Número de entrada inválido: ${v.text}`);
  return n;
}

export function gainAddress(src: InputSource): string | null {
  const max = GAIN_GROUPS[src.grp];
  if (max === undefined || !Number.isInteger(src.in) || src.in < 1 || src.in > max) return null;
  return `/io/in/${src.grp}/${src.in}/g`;
}

export function validateGain(db: number): string | null {
  if (!Number.isFinite(db)) return "Valor de ganho inválido";
  if (db < GAIN_MIN_DB || db > GAIN_MAX_DB) return `Ganho deve ficar entre ${GAIN_MIN_DB} e ${GAIN_MAX_DB} dB`;
  return null;
}

export function gainMessage(src: InputSource, db: number): OscMessage {
  const address = gainAddress(src);
  if (!address) throw new Error(`A fonte ${src.grp} ${src.in} não tem ganho ajustável`);
  return { address, args: [{ type: "f", value: Math.round(db * 10) / 10 }] };
}

export function describeMessage(m: OscMessage): string {
  const args = m.args.map((a) => (a.type === "s" ? JSON.stringify(a.value) : String(a.value)));
  return `${m.address} ,${m.args.map((a) => a.type).join("")} ${args.join(" ")}`.trim();
}

export interface WingEvents {
  info: [string];
  reply: [string];
  strip: [StripState];
  meters: [Strips];
  status: [WingStatus];
  osc: [string, WingValue];
}

export interface WingStatus {
  host: string;
  writesEnabled: boolean;
  consoleInfo: string | null;
  lastOscAt: number | null;
  lastMeterAt: number | null;
  error: string | null;
}

export class WingClient extends EventEmitter<WingEvents> {
  readonly strips: Strips = createStrips();
  get channels(): StripState[] {
    return this.strips.ch;
  }
  readonly status: WingStatus;
  private osc!: dgram.Socket;
  private startedAt = 0;
  private reconnecting = false;
  private meterUdp = dgram.createSocket("udp4");
  private tcp: net.Socket | null = null;
  private timers: NodeJS.Timeout[] = [];
  private closed = false;

  readonly host: string;
  readonly allowWrites: boolean;
  private readonly ports: { osc: number; native: number };

  private readonly heartbeatMs: number;
  private readonly silenceMs: number;

  constructor(
    host: string,
    opts: {
      ports?: { osc: number; native: number };
      allowWrites?: boolean;
      timing?: { heartbeatMs: number; silenceMs: number };
    } = {},
  ) {
    super();
    this.heartbeatMs = opts.timing?.heartbeatMs ?? 5000;
    this.silenceMs = opts.timing?.silenceMs ?? OSC_SILENCE_MS;
    this.host = host;
    this.ports = opts.ports ?? { osc: OSC_PORT, native: NATIVE_PORT };
    this.allowWrites = opts.allowWrites ?? false;
    this.status = { host, writesEnabled: this.allowWrites, consoleInfo: null, lastOscAt: null, lastMeterAt: null, error: null };
  }

  private async bindOsc(): Promise<void> {
    const sock = dgram.createSocket("udp4");
    sock.on("message", (buf) => this.onOsc(buf));
    sock.on("error", (e) => this.setError(`OSC: ${e.message}`));
    await new Promise<void>((r) => sock.bind(0, r));
    this.osc = sock;
  }

  /**
   * Depois que a mesa reinicia, o socket antigo pode parar de receber respostas
   * (visto na prática com a WING real). Sem resposta por OSC_SILENCE_MS: abre um
   * socket novo, reassina e relê tudo. Só leituras.
   */
  private async checkOscAlive(): Promise<void> {
    const last = this.status.lastOscAt ?? this.startedAt;
    if (this.closed || this.reconnecting || Date.now() - last < this.silenceMs) return;
    this.reconnecting = true;
    try {
      const old = this.osc;
      await this.bindOsc();
      old.close();
      this.startedAt = Date.now();
      this.get("/?");
      this.get("/*s");
      await this.readAllStrips();
    } finally {
      this.reconnecting = false;
    }
  }

  async start(): Promise<void> {
    await this.bindOsc();

    this.meterUdp.on("message", (buf) => this.onMeterPacket(buf));
    this.meterUdp.on("error", (e) => this.setError(`medidores UDP: ${e.message}`));
    await new Promise<void>((r) => this.meterUdp.bind(0, r));

    this.startedAt = Date.now();
    this.get("/?");
    await this.readAllStrips();

    this.get("/*s");
    // Heartbeat: "/?" é só leitura e mantém lastOscAt atualizado.
    this.timers.push(
      setInterval(() => {
        this.get("/?");
        void this.checkOscAlive();
      }, this.heartbeatMs),
    );
    this.timers.push(setInterval(() => this.get("/*s"), SUBSCRIBE_EVERY_MS));
    // Releitura periódica: cobre eventos perdidos (UDP) e serve de keep-alive.
    this.timers.push(setInterval(() => void this.readAllStrips(), 30000));

    this.connectMeters();
  }

  /** Envia um GET OSC: endereço sem argumentos. Não altera nada na mesa. */
  private get(address: string): void {
    if (this.closed) return;
    this.osc.send(encodeMessage({ address, args: [] }), this.ports.osc, this.host);
  }

  /**
   * ESCRITA na mesa. Único ponto do app que envia mensagens com argumento.
   * Bloqueada a menos que o cliente tenha sido criado com allowWrites.
   */
  private assertWritable(): void {
    if (!this.allowWrites) throw new Error("Escrita desativada (inicie com WING_ALLOW_WRITES=1)");
    if (this.closed) throw new Error("Cliente fechado");
  }

  private write(message: OscMessage): void {
    this.assertWritable();
    const buf = encodeMessage(message);
    console.log(`[ESCRITA] ${describeMessage(message)}  bytes=${buf.toString("hex")}`);
    this.osc.send(buf, this.ports.osc, this.host);
  }

  /** Renomeia o canal e confirma lendo o nome de volta (a WING não ecoa escritas). */
  async setChannelName(ch: number, name: string): Promise<{ readBack: string }> {
    const error = validateChannelName(ch, name);
    if (error) throw new Error(error);
    const address = channelAddresses(ch).name;
    this.write(renameMessage(ch, name));
    await new Promise((r) => setTimeout(r, 100));
    const readBack = (await this.readValue(address)).text;
    return { readBack };
  }

  /** Muta (true) ou desmuta (false) o canal e confirma lendo de volta. */
  async setChannelMute(ch: number, muted: boolean): Promise<{ readBack: boolean }> {
    if (!isValidChannel(ch)) throw new Error(`Canal inválido: ${ch}`);
    if (typeof muted !== "boolean") throw new Error("mute deve ser true ou false");
    this.write(muteMessage(ch, muted));
    await new Promise((r) => setTimeout(r, 100));
    return { readBack: (await this.readNumber(channelAddresses(ch).mute)) === 1 };
  }

  /** Ajusta o fader (dB) e confirma lendo de volta. */
  async setChannelFader(ch: number, db: number): Promise<{ readBack: number }> {
    const error = validateFader(ch, db);
    if (error) throw new Error(error);
    this.write(faderMessage(ch, db));
    await new Promise((r) => setTimeout(r, 100));
    return { readBack: await this.readNumber(channelAddresses(ch).fader) };
  }

  /**
   * Fonte que alimenta o canal (só leitura). Se a entrada alternativa estiver
   * ativa (/ch/N/in/set/altsrc = 1), a fonte é altgrp/altin.
   */
  async getChannelSource(ch: number): Promise<InputSource & { alt: boolean; gainAddress: string | null }> {
    if (!isValidChannel(ch)) throw new Error(`Canal inválido: ${ch}`);
    const base = `/ch/${ch}/in`;
    const alt = (await this.readNumber(`${base}/set/altsrc`)) === 1;
    const grp = (await this.readValue(`${base}/conn/${alt ? "altgrp" : "grp"}`)).text;
    // Atenção: em /conn/in a WING responde ',sfi' com o TEXTO 1-based ("5") e o INTEIRO
    // 0-based (4). O número da entrada (/io/in/<grp>/<n>) é o do texto. Verificado na mesa.
    const idx = parseConnIndex(await this.readValue(`${base}/conn/${alt ? "altin" : "in"}`));
    const src = { grp, in: idx };
    return { ...src, alt, gainAddress: gainAddress(src) };
  }

  /** Ajusta o ganho do headamp da fonte do canal e confirma lendo de volta. */
  async setChannelGain(ch: number, db: number): Promise<{ readBack: number; source: InputSource }> {
    this.assertWritable();
    const error = validateGain(db);
    if (error) throw new Error(error);
    const src = await this.getChannelSource(ch);
    if (!src.gainAddress) throw new Error(`O canal ${ch} usa a fonte ${src.grp} ${src.in}, sem ganho ajustável`);
    // Trava: o ganho atual da fonte tem que ser igual ao espelho $g do canal.
    // Se não for, a fonte foi identificada errado e nada é escrito.
    const sourceGain = await this.readNumber(src.gainAddress);
    const mirror = await this.readNumber(channelAddresses(ch).gain);
    if (Math.abs(sourceGain - mirror) > 0.05) {
      throw new Error(
        `Fonte não confere: ${src.gainAddress} = ${sourceGain} dB, mas o canal ${ch} mostra ${mirror} dB. Nada foi enviado.`,
      );
    }
    // Faixa real da fonte segundo a própria mesa (ex.: AES50 vai de -2.0 a 45.5 dB).
    const { parent, name } = splitPath(src.gainAddress);
    const gDesc = (await this.describeNode(parent)).find((c) => c.name === name);
    if (gDesc?.kind === "param") {
      const check = encodeParamValue(gDesc, db);
      if ("error" in check) throw new Error(check.error);
    }
    this.write(gainMessage(src, db));
    await new Promise((r) => setTimeout(r, 100));
    const readBack = await this.readNumber(src.gainAddress);
    this.get(channelAddresses(ch).gain); // atualiza o espelho $g na interface
    return { readBack, source: { grp: src.grp, in: src.in } };
  }

  private async readNumber(address: string): Promise<number> {
    const v = await this.readValue(address);
    if (v.kind === "string") throw new Error(`Resposta inesperada em ${address}: ${v.text}`);
    return v.value;
  }

  /**
   * Consulta de descrição de nó ("<nó> ,s #"): só leitura, segundo a documentação.
   * É a única mensagem com argumento que não passa por write(); o argumento é fixo.
   */
  async describeNode(path: string, timeoutMs = 2000): Promise<NodeChild[]> {
    if (!isSafePath(path) && path !== "/") throw new Error(`Caminho inválido: ${path}`);
    if (this.closed) throw new Error("Cliente fechado");
    const text = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("osc", onOsc);
        reject(new Error(`Sem resposta à descrição de ${path}`));
      }, timeoutMs);
      const onOsc = (addr: string, value: WingValue) => {
        // A resposta vem no mesmo endereço, como uma string com uma linha por filho.
        if (addr !== path || value.kind !== "string" || !value.text.includes("\n")) return;
        clearTimeout(timer);
        this.off("osc", onOsc);
        resolve(value.text);
      };
      this.on("osc", onOsc);
      this.osc.send(encodeMessage({ address: path, args: [{ type: "s", value: "#" }] }), this.ports.osc, this.host);
    });
    return parseNodeDescription(text);
  }

  /** Lê um parâmetro qualquer (GET). */
  async getParam(path: string): Promise<WingValue> {
    if (!isSafePath(path)) throw new Error(`Caminho inválido: ${path}`);
    return this.readValue(path);
  }

  /**
   * Escreve um parâmetro qualquer. Antes, consulta a descrição atual do nó pai na mesa
   * (tipo, faixa, opções, somente leitura) e recusa o que não couber. Depois lê de volta.
   */
  async setParam(path: string, value: unknown): Promise<{ readBack: WingValue; desc: ParamDesc }> {
    this.assertWritable();
    if (!isSafePath(path)) throw new Error(`Caminho inválido: ${path}`);
    const { parent, name } = splitPath(path);
    const child = (await this.describeNode(parent)).find((c) => c.name === name);
    if (!child) throw new Error(`Parâmetro não existe na mesa: ${path}`);
    if (child.kind !== "param") throw new Error(`${path} é um nó, não um parâmetro`);
    const encoded = encodeParamValue(child, value);
    if ("error" in encoded) throw new Error(encoded.error);
    this.write({ address: path, args: [encoded.arg] });
    await new Promise((r) => setTimeout(r, 100));
    return { readBack: await this.readValue(path), desc: child };
  }

  /** GETs aguardando resposta, por endereço (resolvidos em onOsc). */
  private pending = new Map<string, Array<(v: WingValue) => void>>();

  private readValue(address: string, timeoutMs = 1500): Promise<WingValue> {
    return new Promise((resolve, reject) => {
      const done = (v: WingValue) => {
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => {
        const list = this.pending.get(address);
        const i = list?.indexOf(done) ?? -1;
        if (list && i >= 0) list.splice(i, 1);
        if (list?.length === 0) this.pending.delete(address);
        reject(new Error(`Sem resposta ao ler ${address}`));
      }, timeoutMs);
      const list = this.pending.get(address);
      if (list) list.push(done);
      else this.pending.set(address, [done]);
      this.get(address);
    });
  }

  /**
   * Lê muitos parâmetros (só GETs), espaçando os pedidos para não estourar o buffer
   * UDP da mesa. Parâmetros sem resposta voltam como null.
   */
  async readMany(paths: string[], batch = 24): Promise<Map<string, WingValue | null>> {
    for (const p of paths) if (!isSafePath(p)) throw new Error(`Caminho inválido: ${p}`);
    const out = new Map<string, WingValue | null>();
    const promises: Promise<void>[] = [];
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i]!;
      promises.push(this.readValue(p, 2000).then((v) => void out.set(p, v), () => void out.set(p, null)));
      if (i % batch === batch - 1) await new Promise((r) => setTimeout(r, 5));
    }
    await Promise.all(promises);
    return out;
  }

  private async readAllStrips(): Promise<void> {
    for (const k of STRIP_KINDS) {
      for (let i = 1; i <= k.count; i++) {
        for (const p of stripPaths(k.kind, i)) this.get(p);
        // Espaça os pedidos para não estourar o buffer UDP da mesa.
        await new Promise((r) => setTimeout(r, 5));
      }
    }
  }

  private onOsc(buf: Buffer): void {
    let msg;
    try {
      msg = decodeMessage(buf);
    } catch {
      return;
    }
    this.status.lastOscAt = Date.now();
    if (this.status.error?.startsWith("Sem resposta")) this.status.error = null;
    // O firmware 3.1 responde ao "/?" no endereço "/*"; o mesmo endereço traz
    // status de comandos ("OK", "VALUE ERROR", ...).
    if (msg.address === "/?" || msg.address === "/*") {
      const v = msg.args[0];
      if (v?.type === "s" && v.value.startsWith("WING,")) {
        if (this.status.consoleInfo !== v.value) this.emit("info", v.value);
        this.status.consoleInfo = v.value;
        this.emit("status", this.status);
      } else if (v?.type === "s") {
        this.emit("reply", v.value);
      }
      return;
    }
    const value = parseWingValue(msg.args);
    if (!value) return;
    const waiting = this.pending.get(msg.address);
    if (waiting) {
      this.pending.delete(msg.address);
      for (const resolve of waiting) resolve(value);
    }
    this.emit("osc", msg.address, value);
    const st = applyStripValue(this.strips, msg.address, value);
    if (st) this.emit("strip", st);
  }

  private connectMeters(): void {
    if (this.closed) return;
    const sock = net.createConnection({ host: this.host, port: this.ports.native });
    this.tcp = sock;
    let renew: NodeJS.Timeout | null = null;
    sock.on("connect", () => {
      const port = this.meterUdp.address().port;
      sock.write(encodeChannelData(METER_CHANNEL, meterPortRequest(port)));
      // Uma coleção só com todos os tipos: na WING real, cada pedido novo substitui o anterior.
      sock.write(encodeChannelData(METER_CHANNEL, meterRequestMulti(METER_REPORT_ID, meterGroups())));
      renew = setInterval(
        () => sock.write(encodeChannelData(METER_CHANNEL, meterRenewRequest(METER_REPORT_ID))),
        METER_RENEW_EVERY_MS,
      );
    });
    sock.on("data", () => {
      // Nada a fazer: só pedimos medidores, que chegam por UDP.
    });
    sock.on("error", (e) => this.setError(`TCP ${this.ports.native}: ${e.message}`));
    sock.on("close", () => {
      if (renew) clearInterval(renew);
      if (!this.closed) setTimeout(() => this.connectMeters(), 3000);
    });
  }

  private onMeterPacket(buf: Buffer): void {
    const parsed = splitMeterPacket(buf);
    if (!parsed) return;
    this.status.lastMeterAt = Date.now();
    for (const m of parsed) {
      const st = this.strips[m.kind][m.index - 1];
      if (st) st.meter = m.meter;
    }
    this.emit("meters", this.strips);
  }

  private setError(msg: string): void {
    this.status.error = msg;
    this.emit("status", this.status);
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.tcp?.destroy();
    this.osc?.close();
    this.meterUdp.close();
  }
}


/** Resposta ao 'WING?': 'WING,<ip>,<nome>,<modelo>,<serial>,<firmware>'. */
export function parseDiscoveryReply(text: string) {
  const [tag, ip, name, model, serial, firmware] = text.split(",");
  if (tag !== "WING" || !ip) return null;
  return { ip, name: name ?? "", model: model ?? "", serial: serial ?? "", firmware: firmware ?? "" };
}
