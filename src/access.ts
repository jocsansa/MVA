// Acesso à página pela rede da igreja (celular, tablet, notebook do voluntário).
// - Sem LAN=1 o servidor só escuta em 127.0.0.1 (como antes).
// - Com LAN=1 escuta na rede; quem não é o próprio computador precisa do CÓDIGO DE ACESSO (PIN)
//   uma vez por aparelho (vira um cookie). O computador do servidor nunca precisa.
// - Em qualquer modo, o cabeçalho Host tem que ser um nome deste computador: impede que um site
//   de fora use o navegador de alguém (DNS rebinding) para falar com o servidor.

import os from "node:os";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type http from "node:http";

export const COOKIE = "mva_acesso";
const MAX_FAILS_PER_MIN = 10;

export function isLoopback(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** Endereços IPv4 deste computador na rede (para mostrar o link e aceitar o Host). */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out;
}

/** PIN do ambiente (4 a 12 dígitos) ou um aleatório de 6 dígitos. */
export function choosePin(env: string | undefined): string {
  if (env !== undefined) {
    if (!/^\d{4,12}$/.test(env)) throw new Error("MVA_PIN deve ter de 4 a 12 dígitos");
    return env;
  }
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function cookieValue(req: http.IncomingMessage): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type Gate = "ok" | "login" | "bad-host";

export class Access {
  readonly lan: boolean;
  readonly pin: string;
  readonly port: number;
  private readonly token: string;
  private readonly hosts: Set<string>;
  /** Tentativas erradas por aparelho (endereço), para um não bloquear todos. */
  private fails = new Map<string, number[]>();

  constructor(opts: { lan: boolean; pin: string; port: number; extraHosts?: string[] }) {
    this.lan = opts.lan;
    this.pin = opts.pin;
    this.port = opts.port;
    // Cookie aleatório, sem relação com o código: não dá para adivinhar o cookie a partir do PIN.
    // Muda a cada início do servidor (os aparelhos digitam o código de novo).
    this.token = randomBytes(32).toString("hex");
    const name = os.hostname().toLowerCase();
    this.hosts = new Set(["localhost", "127.0.0.1", "[::1]", name, name.endsWith(".local") ? name : `${name}.local`,
      ...(opts.extraHosts ?? [])].map((h) => h.toLowerCase()));
  }

  /** Links para abrir no celular (com o código, para não precisar digitar). */
  urls(): string[] {
    return lanAddresses().map((ip) => `http://${ip}:${this.port}/?pin=${this.pin}`);
  }

  hostOk(host: string | undefined): boolean {
    if (!host) return false;
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host.toLowerCase());
    if (!m) return false;
    if (m[2] !== undefined && Number(m[2]) !== this.port) return false;
    // IPs da rede lidos a cada pedido: o computador pode trocar de IP (DHCP) com o servidor rodando.
    return this.hosts.has(m[1]!) || lanAddresses().includes(m[1]!);
  }

  check(req: http.IncomingMessage): Gate {
    if (!this.hostOk(req.headers.host)) return "bad-host";
    if (isLoopback(req.socket.remoteAddress)) return "ok";
    if (!this.lan) return "login"; // não deveria acontecer: sem LAN=1 só escuta em 127.0.0.1
    const c = cookieValue(req);
    return c && sameText(c, this.token) ? "ok" : "login";
  }

  /** Confere o PIN digitado. Muitas tentativas erradas por minuto bloqueiam aquele aparelho. */
  tryPin(pin: unknown, from = "?", t = Date.now()): "ok" | "wrong" | "blocked" {
    for (const [k, list] of this.fails) {
      const recent = list.filter((x) => t - x < 60_000);
      if (recent.length) this.fails.set(k, recent);
      else this.fails.delete(k);
    }
    const mine = this.fails.get(from) ?? [];
    if (mine.length >= MAX_FAILS_PER_MIN) return "blocked";
    if (typeof pin === "string" && sameText(pin.trim(), this.pin)) return "ok";
    mine.push(t);
    this.fails.set(from, mine);
    return "wrong";
  }

  setCookie(res: http.ServerResponse): void {
    res.setHeader("set-cookie", `${COOKIE}=${this.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 60}`);
  }
}

/** Página de entrada (sem o app): só o campo do código. */
export function loginPage(message = ""): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>MVA — entrar</title>
<style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0d;color:#fff;font:16px system-ui,sans-serif}
form{display:flex;flex-direction:column;gap:12px;padding:24px;width:min(320px,calc(100vw - 32px));background:#16161a;border:1px solid #2a2a30;border-radius:12px}
h1{margin:0;font-size:20px}p{margin:0;color:#b9b9c3;font-size:14px}.err{color:#ff6b6b}
input{font-size:24px;letter-spacing:.2em;text-align:center;padding:12px;border-radius:8px;border:1px solid #3a3a42;background:#0b0b0d;color:#fff}
button{min-height:48px;font-size:16px;font-weight:700;border:0;border-radius:8px;background:#f5a524;color:#1b1203}
input:focus-visible,button:focus-visible{outline:2px solid #f5a524;outline-offset:2px}
</style></head><body><form method="post" action="/entrar">
<h1>MVA · WING</h1><p>Digite o código de acesso que aparece no computador da mesa.</p>
${message ? `<p class="err" role="alert">${esc(message)}</p>` : ""}
<input name="pin" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required autofocus aria-label="Código de acesso">
<button type="submit">Entrar</button></form></body></html>`;
}
