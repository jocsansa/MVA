// Acesso pela rede: Host conferido sempre, senha só no modo rede, cookie sem a senha dentro.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Access, checkAccessConfig, isLoopbackAddress, parseHost, type AccessOptions } from "../src/access.ts";

const PIN = "482913";
const LAN_HOSTS = () => ["localhost", "127.0.0.1", "::1", "192.168.1.5", "mac-da-igreja.local"];

/** Servidor de teste: o guard na frente e uma rota "ok" atrás (como no server.ts). */
async function withServer(opts: Omit<AccessOptions, "port">, fn: (port: number) => Promise<void>): Promise<void> {
  let access: Access | null = null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void access!.guard(req, res, url).then((done) => {
      if (!done) res.writeHead(200, { "content-type": "text/plain" }).end(`ok ${req.method} ${url.pathname}`);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  access = new Access({ ...opts, port });
  try {
    await fn(port);
  } finally {
    server.close();
  }
}

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(port: number, path: string, o: { method?: string; host?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path, method: o.method ?? "GET",
      headers: { host: o.host ?? `192.168.1.5:${port}`, ...o.headers },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(o.body);
  });
}

const form = (pin: string) => ({ method: "POST", body: `pin=${pin}`, headers: { "content-type": "application/x-www-form-urlencoded" } });

test("acesso: modo rede sem senha (ou senha curta) não sobe; localhost não precisa", () => {
  assert.equal(checkAccessConfig("127.0.0.1", undefined), null);
  assert.equal(checkAccessConfig("localhost", undefined), null);
  assert.match(checkAccessConfig("0.0.0.0", undefined)!, /ACCESS_PIN/);
  assert.match(checkAccessConfig("0.0.0.0", "12345")!, /pelo menos 6/);
  assert.equal(checkAccessConfig("0.0.0.0", "123456"), null);
  assert.throws(() => new Access({ listenHost: "0.0.0.0", port: 3000 }), /ACCESS_PIN/);
});

test("acesso: Host e endereço local", () => {
  assert.deepEqual(parseHost("[::1]:3000"), { host: "::1", port: "3000" });
  assert.deepEqual(parseHost("Mac.Local:3000"), { host: "mac.local", port: "3000" });
  assert.equal(parseHost("a@b:3000"), null);
  assert.equal(parseHost(undefined), null);
  assert.ok(isLoopbackAddress("::ffff:127.0.0.1"));
  assert.ok(isLoopbackAddress("::1"));
  assert.ok(!isLoopbackAddress("192.168.1.20"));

  const local = new Access({ listenHost: "127.0.0.1", port: 3000 });
  for (const h of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) assert.ok(local.allowedHost(h), h);
  for (const h of ["192.168.1.5:3000", "evil.example:3000", "localhost:3001", undefined]) assert.ok(!local.allowedHost(h), String(h));

  const lan = new Access({ listenHost: "0.0.0.0", port: 3000, pin: PIN, hosts: LAN_HOSTS });
  assert.ok(lan.allowedHost("192.168.1.5:3000"));
  assert.ok(lan.allowedHost("mac-da-igreja.local:3000"));
  assert.ok(!lan.allowedHost("evil.example:3000"));
});

test("acesso: origem dos POSTs é a própria página (comportamento antigo mantido no localhost)", () => {
  const local = new Access({ listenHost: "127.0.0.1", port: 3000 });
  assert.ok(local.sameOrigin(undefined));
  assert.ok(local.sameOrigin("http://localhost:3000"));
  assert.ok(local.sameOrigin("http://127.0.0.1:3000"));
  for (const o of ["null", "http://evil.example:3000", "https://localhost:3000", "http://localhost:3001", "http://192.168.1.5:3000"]) {
    assert.ok(!local.sameOrigin(o), o);
  }
  const lan = new Access({ listenHost: "0.0.0.0", port: 3000, pin: PIN, hosts: LAN_HOSTS });
  assert.ok(lan.sameOrigin("http://192.168.1.5:3000"));
  assert.ok(!lan.sameOrigin("http://evil.example:3000"));
});

test("acesso: localhost segue sem senha e recusa Host de outro site", async () => {
  await withServer({ listenHost: "127.0.0.1" }, async (port) => {
    assert.equal((await request(port, "/api/state", { host: `localhost:${port}` })).status, 200);
    const bad = await request(port, "/api/state", { host: `evil.example:${port}` });
    assert.equal(bad.status, 400);
    assert.doesNotMatch(bad.body, /^ok/);
  });
});

test("acesso: modo rede pede a senha, libera com cookie e o cookie não contém a senha", async () => {
  await withServer({ listenHost: "0.0.0.0", pin: PIN, hosts: LAN_HOSTS, trustLoopback: false }, async (port) => {
    const page = await request(port, "/");
    assert.equal(page.status, 200);
    assert.match(page.body, /<form method="post" action="\/acesso">/);
    assert.match(page.body, /inputmode="numeric"/);

    const api = await request(port, "/api/state");
    assert.equal(api.status, 401);
    assert.match(api.body, /Senha de acesso/);
    assert.equal((await request(port, "/app.js")).status, 401);
    assert.equal((await request(port, "/api/channels/1/mute", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status, 401);

    const wrong = await request(port, "/acesso", form("000000"));
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers["set-cookie"], undefined);

    const ok = await request(port, "/acesso", form(PIN));
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.location, "/");
    const cookie = ok.headers["set-cookie"]![0]!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.ok(!cookie.includes(PIN));

    const pair = cookie.split(";")[0]!;
    const withCookie = await request(port, "/api/state", { headers: { cookie: `outro=1; ${pair}` } });
    assert.equal(withCookie.status, 200);
    assert.equal(withCookie.body, "ok GET /api/state");
    assert.equal((await request(port, "/api/state", { headers: { cookie: "mva_acesso=falso" } })).status, 401);

    // Host de outro site é recusado mesmo com cookie válido.
    assert.equal((await request(port, "/api/state", { host: `evil.example:${port}`, headers: { cookie: pair } })).status, 400);
    // Formulário de senha vindo de outro site: recusado.
    const cross = await request(port, "/acesso", { ...form(PIN), headers: { ...form(PIN).headers, origin: "http://evil.example" } });
    assert.equal(cross.status, 403);
  });
});

test("acesso: 5 senhas erradas bloqueiam por 10 minutos (até a certa)", async () => {
  let t = 1_000_000;
  await withServer({ listenHost: "0.0.0.0", pin: PIN, hosts: LAN_HOSTS, trustLoopback: false, now: () => t }, async (port) => {
    for (let i = 0; i < 5; i++) assert.equal((await request(port, "/acesso", form("111111"))).status, 401);
    const locked = await request(port, "/acesso", form(PIN));
    assert.equal(locked.status, 429);
    assert.equal(locked.headers["set-cookie"], undefined);
    t += 10 * 60_000 + 1;
    assert.equal((await request(port, "/acesso", form(PIN))).status, 303);
  });
});

test("acesso: no modo rede, pedidos do próprio computador não pedem senha", async () => {
  await withServer({ listenHost: "0.0.0.0", pin: PIN, hosts: LAN_HOSTS }, async (port) => {
    assert.equal((await request(port, "/api/state", { host: `localhost:${port}` })).status, 200);
  });
});
