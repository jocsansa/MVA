// Acesso à página pela rede (ex.: celular no Wi-Fi da igreja).
// Padrão: o servidor só escuta em 127.0.0.1 e só aceita os nomes locais (localhost, 127.0.0.1, ::1).
// Modo rede (LISTEN_HOST=0.0.0.0 ou um IP da máquina): quem não está no próprio computador digita a
// senha ACCESS_PIN uma vez e o navegador guarda um cookie (sem a senha dentro). Pedidos do próprio
// computador (curl, Claude Code) não pedem senha.
// O cabeçalho Host é conferido sempre, contra "DNS rebinding" (outro site apontando o nome para cá).
// Este módulo não fala com a mesa: só decide se o pedido segue para as rotas do servidor.

import { createHmac, timingSafeEqual } from "node:crypto";
import os from "node:os";
import type http from "node:http";

export const PIN_MIN = 6;
const COOKIE = "mva_acesso";
const COOKIE_MAX_AGE_S = 90 * 24 * 3600;
const MAX_FAILS = 5;
const LOCK_MS = 10 * 60_000;
const LOCAL_NAMES = ["localhost", "127.0.0.1", "::1"];

export const isLoopbackHost = (h: string): boolean => LOCAL_NAMES.includes(h.toLowerCase());

/** Endereço do outro lado da conexão é o próprio computador. */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, "");
  return a === "::1" || a.startsWith("127.");
}

/** Configuração inválida para subir o servidor (mensagem) ou null. */
export function checkAccessConfig(listenHost: string, pin: string | undefined): string | null {
  if (isLoopbackHost(listenHost)) return null;
  if (!pin || pin.trim().length < PIN_MIN) {
    return `Modo rede (LISTEN_HOST=${listenHost}) exige ACCESS_PIN com pelo menos ${PIN_MIN} caracteres.`;
  }
  return null;
}

/** IPs e nomes desta máquina (para aceitar http://<ip>:porta e http://<nome>.local:porta). */
export function machineHosts(): string[] {
  const out = [...LOCAL_NAMES];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) out.push(i.address.toLowerCase());
  const name = os.hostname().toLowerCase();
  out.push(name, name.endsWith(".local") ? name.slice(0, -6) : `${name}.local`);
  return out;
}

/** Endereços para abrir no celular (IPv4 da rede e nome .local). */
export function lanUrls(port: number): string[] {
  const urls: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) urls.push(`http://${i.address}:${port}`);
  }
  const name = os.hostname();
  urls.push(`http://${name.endsWith(".local") ? name : `${name}.local`}:${port}`);
  return urls;
}

/** "nome:porta" ou "[v6]:porta" → partes, ou null se não for um Host simples. */
export function parseHost(header: string | undefined): { host: string; port: string } | null {
  if (!header) return null;
  try {
    const u = new URL(`http://${header}`);
    if (u.username || u.password || u.pathname !== "/" || u.search || u.hash) return null;
    return { host: u.hostname.replace(/^\[|\]$/g, "").toLowerCase(), port: u.port || "80" };
  } catch {
    return null;
  }
}

export interface AccessOptions {
  listenHost: string;
  port: number;
  pin?: string | null;
  /** Nomes e IPs aceitos no modo rede. Padrão: machineHosts() a cada pedido (o IP pode mudar). */
  hosts?: () => string[];
  /** Pedidos do próprio computador dispensam a senha (padrão true; os testes desligam). */
  trustLoopback?: boolean;
  now?: () => number;
}

export class Access {
  readonly lanMode: boolean;
  private readonly port: string;
  private readonly pin: string | null;
  private readonly cookieValue: string | null;
  private readonly hosts: () => string[];
  private readonly trustLoopback: boolean;
  private readonly now: () => number;
  private readonly fails = new Map<string, { count: number; until: number }>();

  constructor(opts: AccessOptions) {
    this.lanMode = !isLoopbackHost(opts.listenHost);
    this.port = String(opts.port);
    this.pin = opts.pin?.trim() || null;
    if (this.lanMode && (!this.pin || this.pin.length < PIN_MIN)) throw new Error(checkAccessConfig(opts.listenHost, opts.pin ?? undefined)!);
    // O cookie guarda uma derivação da senha, não a senha. Trocar a senha invalida os cookies.
    this.cookieValue = this.pin ? createHmac("sha256", this.pin).update("mva-acesso-v1").digest("hex") : null;
    this.hosts = this.lanMode ? (opts.hosts ?? machineHosts) : () => LOCAL_NAMES;
    this.trustLoopback = opts.trustLoopback ?? true;
    this.now = opts.now ?? Date.now;
  }

  /** Host do pedido é um nome desta máquina, na porta do servidor. */
  allowedHost(header: string | undefined): boolean {
    const h = parseHost(header);
    return !!h && h.port === this.port && this.hosts().includes(h.host);
  }

  /** Origin ausente (curl) ou a própria página (http, nome desta máquina, mesma porta). */
  sameOrigin(origin: string | undefined): boolean {
    if (origin === undefined) return true;
    if (!origin.startsWith("http://")) return false;
    return this.allowedHost(origin.slice("http://".length));
  }

  /**
   * Roda antes de qualquer rota. Devolve true se já respondeu (recusa ou tela de senha);
   * false para o pedido seguir normalmente.
   */
  async guard(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    if (!this.allowedHost(req.headers.host)) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Host não permitido");
      return true;
    }
    if (!this.lanMode || (this.trustLoopback && isLoopbackAddress(req.socket.remoteAddress))) return false;
    if (url.pathname === "/acesso" && req.method === "POST") {
      await this.login(req, res);
      return true;
    }
    if (this.hasCookie(req)) return false;
    if (req.method === "GET" && url.pathname === "/") {
      this.page(res, 200, "");
    } else if (url.pathname.startsWith("/api/")) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "Senha de acesso necessária" }));
    } else {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" }).end("Senha de acesso necessária");
    }
    return true;
  }

  private hasCookie(req: http.IncomingMessage): boolean {
    const raw = req.headers.cookie ?? "";
    for (const part of raw.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === COOKIE) return this.cookieValue !== null && safeEqual(v.join("="), this.cookieValue);
    }
    return false;
  }

  private async login(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.sameOrigin(req.headers.origin)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("Requisição recusada");
      return;
    }
    const ip = (req.socket.remoteAddress ?? "?").replace(/^::ffff:/, "");
    const f = this.fails.get(ip);
    if (f && f.until > this.now()) return this.page(res, 429, "Muitas tentativas erradas. Espere 10 minutos.");
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 512) return this.page(res, 400, "Pedido inválido.");
    }
    const pin = (new URLSearchParams(body).get("pin") ?? "").trim();
    if (this.pin && safeEqual(pin, this.pin)) {
      this.fails.delete(ip);
      console.log(`Acesso pela rede liberado para ${ip}`);
      res.writeHead(303, {
        location: "/",
        "set-cookie": `${COOKIE}=${this.cookieValue}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Strict`,
      }).end();
      return;
    }
    // Bloqueio vencido recomeça a contagem; sem bloqueio, as tentativas erradas se acumulam.
    const count = (f && f.until === 0 ? f.count : 0) + 1;
    this.fails.set(ip, { count, until: count >= MAX_FAILS ? this.now() + LOCK_MS : 0 });
    console.log(`Senha de acesso errada de ${ip} (${count}/${MAX_FAILS})`);
    this.page(res, 401, count >= MAX_FAILS ? "Muitas tentativas erradas. Espere 10 minutos." : "Senha errada.");
  }

  private page(res: http.ServerResponse, code: number, message: string): void {
    const numeric = this.pin !== null && /^\d+$/.test(this.pin);
    res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(loginPage(message, numeric));
  }
}

/** Compara sem vazar pelo tempo onde a diferença está. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", "mva").update(a).digest();
  const hb = createHmac("sha256", "mva").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Tela de senha (mensagens fixas deste módulo; nada vindo do pedido entra no HTML). */
function loginPage(message: string, numeric: boolean): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>WING Remote — acesso</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#08090b;color:#f4f6f8;
font:16px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
form{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;width:min(320px,calc(100% - 32px))}
h1{margin:0 0 8px;font-size:18px;font-weight:800;letter-spacing:.08em}
label{color:#c3c9d1;font-size:14px}
input,button{font:inherit;min-height:48px;border-radius:8px}
input{width:100%;padding:0 12px;background:#191c21;color:#f4f6f8;border:1px solid #3a404a;font-size:22px;letter-spacing:.2em;text-align:center}
input:focus-visible,button:focus-visible{outline:2px solid #ffa31a;outline-offset:2px}
button{background:#ffa31a;color:#111;border:0;font-weight:700}
p{margin:0;color:#ff5a52}
</style></head><body>
<form method="post" action="/acesso">
<h1>WING REMOTE</h1>
<label for="pin">Senha de acesso</label>
<input id="pin" name="pin" type="password"${numeric ? ' inputmode="numeric"' : ""} autocomplete="current-password" required autofocus>
${message ? `<p role="alert">${message}</p>` : ""}
<button type="submit">Entrar</button>
</form></body></html>`;
}
