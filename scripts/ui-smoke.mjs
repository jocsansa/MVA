// Smoke da página num Chrome headless (via CDP, sem dependências): carrega a página, confere que
// estilos e script rodaram, que OSC e medidores estão conectados, que as abas trocam e que não há
// erro no console nem rolagem horizontal no desktop e no celular.
// Só olha a página: não clica em mute, fader nem em nada que escreva na mesa.
//
// Uso (com o servidor rodando, de preferência na mesa simulada):
//   node scripts/ui-smoke.mjs [url]          padrão http://localhost:3000/
//   CHROME_PATH=<caminho do chrome> se o Chrome não estiver no lugar padrão.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_ = process.argv[2] || "http://localhost:3000/";
const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => p && existsSync(p));
if (!CHROME) {
  console.error("Chrome não encontrado. Defina CHROME_PATH.");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FALHA"} ${msg}`); if (!ok) failures.push(msg); };
/** Promessa com prazo: em vez de travar, falha com o nome do que não respondeu. */
const within = (promise, ms, what) => {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`tempo esgotado: ${what}`)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
};

/** O Chrome escolhe uma porta livre (--remote-debugging-port=0) e grava em DevToolsActivePort no perfil.
 *  Assim o script nunca se conecta a outro Chrome que já esteja escutando numa porta fixa. */
async function debugPort(profile) {
  const file = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    if (existsSync(file)) {
      const port = Number(readFileSync(file, "utf8").split(/\r?\n/)[0]);
      if (port > 0) return port;
    }
    await sleep(200);
  }
  throw new Error(`Chrome não abriu a porta de depuração (${CHROME})`);
}

async function run(width, height) {
  const profile = mkdtempSync(join(tmpdir(), "mva-smoke-"));
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--disable-extensions", "about:blank"], { stdio: "ignore" });
  let ws;
  try {
    const port = await debugPort(profile);
    const list = await within((await fetch(`http://127.0.0.1:${port}/json/list`)).json(), 5000, "lista de abas do Chrome");
    const target = list.find((t) => t.type === "page");
    if (!target) throw new Error("Chrome sem aba de página para controlar");
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await within(new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", () => reject(new Error("conexão com o Chrome falhou")));
    }), 10000, "conexão com o Chrome");
    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
    });
    const send = (method, params = {}) => within(new Promise((r) => {
      const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
    }), 10000, method);
    const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.result?.value;
    /** Repete a expressão até dar verdadeiro ou vencer o prazo (PC lento, conexão OSC ainda subindo). */
    const until = async (expr, ms = 20000) => {
      for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(250)) if (await ev(expr)) return true;
      return Boolean(await ev(expr));
    };

    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    await send("Page.navigate", { url: URL_ });

    const tag = `[${width}px]`;
    // A folha /app.css carregada com regras (a página de erro do Chrome também tem cor de fundo).
    const loaded = await until(`document.readyState === "complete" && [...document.styleSheets].some((s) => s.href?.endsWith("/app.css") && s.cssRules.length > 0)`);
    check(loaded, `${tag} app.css aplicado`);
    if (!loaded) return; // página não carregou: o resto só esperaria o prazo e falharia junto
    check(await until(`typeof MixerLib === "object" && document.querySelectorAll("#strips .strip").length >= 8`), `${tag} app.js rodou e desenhou os strips`);
    check(await until(`/\\bok\\b/.test(document.getElementById("osc")?.className)`), `${tag} OSC conectado`);
    check(await until(`/\\bok\\b/.test(document.getElementById("mtr")?.className)`), `${tag} medidores chegando`);
    const tabs = (await ev(`[...document.querySelectorAll('[role=tab][data-tab]')].map((b) => b.dataset.tab)`)) ?? [];
    check(tabs.length > 0, `${tag} abas encontradas`);
    for (const t of tabs) {
      const ok = await ev(`(() => { document.querySelector('[role=tab][data-tab="${t}"]').click(); return document.body.dataset.tab; })()`);
      check(ok === t, `${tag} aba ${t}`);
      await sleep(300);
    }
    check(!(await ev(`document.documentElement.scrollWidth > innerWidth`)), `${tag} sem rolagem horizontal`);
    check(errors.length === 0, `${tag} sem erro no console${errors.length ? ": " + errors.join(" | ") : ""}`);
  } catch (e) {
    check(false, `[${width}px] ${e.message}`);
  } finally {
    ws?.close();
    chrome.kill();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

await run(1366, 860);
await run(390, 844);
console.log(failures.length ? `\n${failures.length} falha(s)` : "\nTudo certo");
process.exit(failures.length ? 1 : 0);
