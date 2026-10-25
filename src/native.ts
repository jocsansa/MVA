// Protocolo nativo/binário da WING (TCP 2222), usado aqui só para pedir medidores.
// Fonte: WING Remote Protocols (P.-G. Maillot), "WING native / binary data interface"
// e "Channel 3: Metering". O OSC da WING não entrega medidores; eles vêm por este canal.

export const NRP_ESCAPE = 0xdf;
export const NRP_CHANNEL_BASE = 0xd0;
export const NRP_NUM_CHANNELS = 14;

/** Canal de requisição de medidores (ChID 3, selecionado com 0xdf 0xd3). */
export const METER_CHANNEL = 3;

/**
 * Codifica `data` para o canal `channel`, prefixando a troca de canal (0xdf 0xd<ch>)
 * e escapando 0xdf seguido de 0xd0..0xde, como na rotina de transmissão da documentação.
 */
export function encodeChannelData(channel: number, data: Uint8Array): Buffer {
  const out: number[] = [NRP_ESCAPE, NRP_CHANNEL_BASE + channel];
  let esc = false;
  for (let i = 0; i < data.length; i++) {
    const db = data[i]!;
    if (db === NRP_ESCAPE) {
      esc = true;
    } else if (esc && db >= NRP_CHANNEL_BASE && db <= NRP_CHANNEL_BASE + NRP_NUM_CHANNELS) {
      out.push(NRP_ESCAPE - 1);
      esc = false;
    } else {
      esc = false;
    }
    out.push(db);
  }
  if (esc) out.push(NRP_ESCAPE - 1);
  return Buffer.from(out);
}

/** Decodificador incremental do fluxo TCP (rotina de recepção da documentação). */
export class NativeDecoder {
  private escf = false;
  private channel = -1;
  private readonly onByte: (channel: number, byte: number) => void;
  constructor(onByte: (channel: number, byte: number) => void) {
    this.onByte = onByte;
  }

  push(chunk: Uint8Array): void {
    for (const b of chunk) this.rx(b);
  }

  private rx(input: number): void {
    let db = input;
    if (db === NRP_ESCAPE && !this.escf) {
      this.escf = true;
      return;
    }
    if (this.escf && db !== NRP_ESCAPE) {
      this.escf = false;
      if (db === NRP_ESCAPE - 1) {
        db = NRP_ESCAPE;
      } else if (db >= NRP_CHANNEL_BASE && db < NRP_CHANNEL_BASE + NRP_NUM_CHANNELS) {
        this.channel = db - NRP_CHANNEL_BASE;
        return;
      } else if (this.channel >= 0) {
        this.onByte(this.channel, NRP_ESCAPE);
      }
    }
    if (this.channel >= 0) this.onByte(this.channel, db);
  }
}

// Tokens de requisição de medidores (Table 4. Meter Request Tokens)
const TOK_UDP_PORT = 0xd3;
const TOK_REPORT_ID = 0xd4;
const TOK_COLLECTION_START = 0xdc;
const TOK_COLLECTION_END = 0xde;
const TOK_CHANNEL = 0xa0;

/** Valores por canal no relatório (Table 5. Meter Data, seção "channel"). */
export const CHANNEL_METER_WORDS = 8;

export function meterPortRequest(udpPort: number): Buffer {
  const b = Buffer.alloc(3);
  b[0] = TOK_UDP_PORT;
  b.writeUInt16BE(udpPort, 1);
  return b;
}

/** Define a coleção (canais 1..n) sob um report id. Índices 0x00..0x7f = 1..128. */
export function meterChannelsRequest(reportId: number, channels: number[]): Buffer {
  for (const ch of channels) if (ch < 1 || ch > 40) throw new Error(`canal fora da faixa: ${ch}`);
  return meterRequest(reportId, TOK_CHANNEL, channels);
}

/**
 * Coleção de um tipo de medidor (token 0xa0 canal, 0xa1 aux, 0xa2 bus, 0xa3 main,
 * 0xa4 matrix, 0xa5 dca) para os índices 1-based dados, sob um report id.
 */
export function meterRequest(reportId: number, token: number, indices: number[]): Buffer {
  return meterRequestMulti(reportId, [{ token, indices }]);
}

/**
 * Uma única coleção com vários tipos ("Meter collections are specified by using multiple
 * type/index elements"; exemplo da doc: dc a0 00 01 08 a6 04 de). Os valores voltam na
 * ordem do pedido. Na WING real, um pedido novo substitui o anterior na mesma conexão,
 * por isso tudo vai numa coleção só.
 */
export function meterRequestMulti(reportId: number, groups: { token: number; indices: number[] }[]): Buffer {
  const b: number[] = [TOK_REPORT_ID, ...u32(reportId), TOK_COLLECTION_START];
  for (const g of groups) {
    b.push(g.token);
    for (const i of g.indices) {
      if (!Number.isInteger(i) || i < 1 || i > 128) throw new Error(`índice de medidor fora da faixa: ${i}`);
      b.push(i - 1);
    }
  }
  b.push(TOK_COLLECTION_END);
  return Buffer.from(b);
}

/** Pacote de medidores genérico: report id + grupos de `words` valores (dB) por strip. */
export function parseMeterWords(packet: Buffer, words: number): { reportId: number; strips: number[][] } | null {
  if (packet.length < 4 || words < 1) return null;
  const reportId = packet.readUInt32BE(0);
  const n = Math.floor((packet.length - 4) / 2 / words);
  const strips: number[][] = [];
  for (let s = 0; s < n; s++) {
    const vals: number[] = [];
    for (let w = 0; w < words; w++) vals.push(packet.readInt16BE(4 + (s * words + w) * 2) / 256);
    strips.push(vals);
  }
  return { reportId, strips };
}

/** Repetir o report id renova o envio por mais 5 segundos. */
export function meterRenewRequest(reportId: number): Buffer {
  return Buffer.from([TOK_REPORT_ID, ...u32(reportId)]);
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

export interface ChannelMeter {
  inL: number;
  inR: number;
  outL: number;
  outR: number;
  gateKey: number;
  gateGain: number;
  dynKey: number;
  dynGain: number;
}

/** Pacote UDP: <report id 4 bytes><words int16 BE em 1/256 dB>. */
export function parseChannelMeters(
  packet: Buffer,
  channelCount: number,
): { reportId: number; meters: ChannelMeter[] } | null {
  if (packet.length < 4) return null;
  const reportId = packet.readUInt32BE(0);
  const words = (packet.length - 4) >> 1;
  const n = Math.min(channelCount, Math.floor(words / CHANNEL_METER_WORDS));
  const meters: ChannelMeter[] = [];
  const w = (i: number) => packet.readInt16BE(4 + i * 2) / 256;
  for (let c = 0; c < n; c++) {
    const o = c * CHANNEL_METER_WORDS;
    meters.push({
      inL: w(o),
      inR: w(o + 1),
      outL: w(o + 2),
      outR: w(o + 3),
      gateKey: w(o + 4),
      gateGain: w(o + 5),
      dynKey: w(o + 6),
      dynGain: w(o + 7),
    });
  }
  return { reportId, meters };
}
