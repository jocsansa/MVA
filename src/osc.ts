// Codificação/decodificação de mensagens OSC 1.0 (sem bundles: a WING não usa).
// Fonte: WING Remote Protocols (P.-G. Maillot), capítulo "OSC Data Types".

export type OscArg =
  | { type: "i"; value: number }
  | { type: "f"; value: number }
  | { type: "s"; value: string }
  | { type: "b"; value: Buffer };

export interface OscMessage {
  address: string;
  args: OscArg[];
}

function pad4(n: number): number {
  return (n + 3) & ~3;
}

function encodeString(s: string): Buffer {
  const raw = Buffer.from(s, "latin1");
  const out = Buffer.alloc(pad4(raw.length + 1));
  raw.copy(out);
  return out;
}

export function encodeMessage(msg: OscMessage): Buffer {
  const parts: Buffer[] = [encodeString(msg.address)];
  parts.push(encodeString("," + msg.args.map((a) => a.type).join("")));
  for (const arg of msg.args) {
    switch (arg.type) {
      case "i": {
        const b = Buffer.alloc(4);
        b.writeInt32BE(arg.value);
        parts.push(b);
        break;
      }
      case "f": {
        const b = Buffer.alloc(4);
        b.writeFloatBE(arg.value);
        parts.push(b);
        break;
      }
      case "s":
        parts.push(encodeString(arg.value));
        break;
      case "b": {
        const b = Buffer.alloc(4 + pad4(arg.value.length));
        b.writeInt32BE(arg.value.length);
        arg.value.copy(b, 4);
        parts.push(b);
        break;
      }
    }
  }
  return Buffer.concat(parts);
}

function readString(buf: Buffer, offset: number): [string, number] {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  if (end >= buf.length) throw new Error("OSC: string sem terminador");
  return [buf.toString("latin1", offset, end), pad4(end + 1)];
}

export function decodeMessage(buf: Buffer): OscMessage {
  const [address, afterAddr] = readString(buf, 0);
  if (!address.startsWith("/")) throw new Error("OSC: endereço inválido");
  // Implementações antigas podem omitir a type tag string; a WING aceita isso.
  if (afterAddr >= buf.length || buf[afterAddr] !== 0x2c) {
    return { address, args: [] };
  }
  const [tags, afterTags] = readString(buf, afterAddr);
  let off = afterTags;
  const args: OscArg[] = [];
  for (const t of tags.slice(1)) {
    switch (t) {
      case "i":
        args.push({ type: "i", value: buf.readInt32BE(off) });
        off += 4;
        break;
      case "f":
        args.push({ type: "f", value: buf.readFloatBE(off) });
        off += 4;
        break;
      case "s": {
        const [s, next] = readString(buf, off);
        args.push({ type: "s", value: s });
        off = next;
        break;
      }
      case "b": {
        const len = buf.readInt32BE(off);
        args.push({ type: "b", value: Buffer.from(buf.subarray(off + 4, off + 4 + len)) });
        off += 4 + pad4(len);
        break;
      }
      default:
        throw new Error(`OSC: type tag não suportada '${t}'`);
    }
  }
  return { address, args };
}

/**
 * Interpreta a resposta de um GET da WING. Segundo a documentação, a mesa responde
 * ',s' (strings/enums), ',sff' (texto, valor bruto 0..1, valor em unidade) para floats
 * e ',sfi' (texto, valor bruto, inteiro) para ints. Com assinatura /*S chega só ',f'/',i'.
 */
export type WingValue =
  | { kind: "string"; text: string }
  | { kind: "float"; text: string; raw: number | null; value: number }
  | { kind: "int"; text: string; raw: number | null; value: number };

export function parseWingValue(args: OscArg[]): WingValue | null {
  const [a0, a1, a2] = args;
  if (a0?.type === "s" && a1?.type === "f" && a2?.type === "f") {
    return { kind: "float", text: a0.value, raw: a1.value, value: a2.value };
  }
  if (a0?.type === "s" && a1?.type === "f" && a2?.type === "i") {
    // Na WING real o inteiro é a POSIÇÃO na faixa (valor - mínimo), não o valor:
    // /ch/N/col (1..18) responde ["5", 0.235, 4]; /ch/N/in/conn/in responde ["5", ..., 4].
    // O texto traz o valor real, então ele vale quando é um inteiro.
    const fromText = Number(a0.value);
    const value = a0.value.trim() !== "" && Number.isInteger(fromText) ? fromText : a2.value;
    return { kind: "int", text: a0.value, raw: a1.value, value };
  }
  if (a0?.type === "s" && args.length === 1) return { kind: "string", text: a0.value };
  if (a0?.type === "f" && args.length === 1) {
    return { kind: "float", text: String(a0.value), raw: null, value: a0.value };
  }
  if (a0?.type === "i" && args.length === 1) {
    return { kind: "int", text: String(a0.value), raw: null, value: a0.value };
  }
  return null;
}
