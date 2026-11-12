// Acesso pela rede: Host permitido (contra DNS rebinding), código de acesso, cookie e bloqueio
// de tentativas. Nada aqui fala com a mesa.

import { test } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import { Access, COOKIE, choosePin, loginPage } from "../src/access.ts";

const req = (host: string | undefined, remote: string, cookie?: string) =>
  ({ headers: { host, ...(cookie ? { cookie } : {}) }, socket: { remoteAddress: remote } }) as unknown as http.IncomingMessage;

test("PIN: do ambiente (4 a 12 dígitos) ou aleatório de 6 dígitos", () => {
  assert.equal(choosePin("4321"), "4321");
  assert.throws(() => choosePin("12"), /4 a 12/);
  assert.throws(() => choosePin("abcd"), /4 a 12/);
  assert.match(choosePin(undefined), /^\d{6}$/);
});

test("Host: só nomes deste computador e a porta certa", () => {
  const a = new Access({ lan: true, pin: "4321", port: 3000, extraHosts: ["192.168.0.10"] });
  assert.ok(a.hostOk("localhost:3000"));
  assert.ok(a.hostOk("127.0.0.1:3000"));
  assert.ok(a.hostOk("192.168.0.10:3000"));
  assert.ok(!a.hostOk("evil.com:3000"), "DNS rebinding");
  assert.ok(!a.hostOk("localhost:4000"), "outra porta");
  assert.ok(!a.hostOk(undefined));
});

test("este computador entra sem código; outro aparelho precisa do cookie certo", () => {
  const a = new Access({ lan: true, pin: "4321", port: 3000, extraHosts: ["192.168.0.10"] });
  assert.equal(a.check(req("localhost:3000", "127.0.0.1")), "ok");
  assert.equal(a.check(req("192.168.0.10:3000", "192.168.0.20")), "login");
  assert.equal(a.check(req("192.168.0.10:3000", "192.168.0.20", `${COOKIE}=errado`)), "login");
  assert.equal(a.check(req("evil.com:3000", "127.0.0.1")), "bad-host");
  // O cookie que setCookie grava é o que check aceita.
  let header = "";
  a.setCookie({ setHeader: (_: string, v: string) => (header = v) } as unknown as http.ServerResponse);
  const value = /mva_acesso=([^;]+)/.exec(header)![1];
  assert.match(header, /HttpOnly/);
  assert.equal(a.check(req("192.168.0.10:3000", "192.168.0.20", `x=1; ${COOKIE}=${value}`)), "ok");
});

test("código errado muitas vezes bloqueia aquele aparelho por um minuto (os outros não)", () => {
  const a = new Access({ lan: true, pin: "4321", port: 3000 });
  assert.equal(a.tryPin("4321", "10.0.0.2", 0), "ok");
  for (let i = 0; i < 10; i++) assert.equal(a.tryPin("0000", "10.0.0.9", 1000 + i), "wrong");
  assert.equal(a.tryPin("4321", "10.0.0.9", 2000), "blocked", "nem o certo passa enquanto bloqueado");
  assert.equal(a.tryPin("4321", "10.0.0.2", 2000), "ok", "outro aparelho continua entrando");
  assert.equal(a.tryPin("4321", "10.0.0.9", 62_000), "ok");
});

test("cookie é aleatório: não sai do código e muda a cada início", () => {
  const grab = (a: Access) => {
    let header = "";
    a.setCookie({ setHeader: (_: string, v: string) => (header = v) } as unknown as http.ServerResponse);
    return /mva_acesso=([^;]+)/.exec(header)![1];
  };
  const one = grab(new Access({ lan: true, pin: "4321", port: 3000 }));
  const two = grab(new Access({ lan: true, pin: "4321", port: 3000 }));
  assert.notEqual(one, two);
  assert.match(one!, /^[0-9a-f]{64}$/);
});

test("página de entrada escapa a mensagem", () => {
  assert.match(loginPage("<b>"), /&lt;b&gt;/);
  assert.doesNotMatch(loginPage(), /class="err"/);
});
