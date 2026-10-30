// Servidor local: lê a WING e mostra o estado no navegador (http://localhost:PORT).
// Por padrão é SOMENTE LEITURA. Escritas só com WING_ALLOW_WRITES=1.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  FADER_MIN_DB,
  WingClient,
  describeMessage,
  gainAddress,
  gainMessage,
  isValidChannel,
  validateChannelName,
  validateFader,
  validateGain,
  writeParam,
} from "./wing.ts";
import { isSafePath, riskWarning } from "./schema.ts";
import { EqRequestError, readChannelEq, writeChannelEq } from "./eq.ts";
import { DynRequestError, readChannelDyn, writeChannelDyn } from "./dyn.ts";
import { STRIP_KINDS } from "./strips.ts";
import { buildSendRows, destKey, parseDest, sendPaths, writeSend } from "./sends.ts";
import { MOMENTS, SessionError, SessionRecorder } from "./recorder.ts";
import { ALERT_LIMITS, AlertEngine, MeterWindow, alertContext, type Alert } from "./alerts.ts";
import { STATIC_FILES } from "./static-files.ts";

const host = process.env.CONSOLE_HOST;
if (!host) {
  console.error("Defina CONSOLE_HOST com o IP da WING (ex.: CONSOLE_HOST=192.168.1.50 npm start).");
  console.error("Para descobrir o IP: npm run discover");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3000);
const indexPath = fileURLToPath(new URL("../public/index.html", import.meta.url));

const allowWrites = process.env.WING_ALLOW_WRITES === "1";
const wing = new WingClient(host, { allowWrites });
const clients = new Set<http.ServerResponse>();

// Gravação das sessões: só escuta a mesa e grava em disco (data/sessions, ou SESSIONS_DIR).
const sessionsDir = process.env.SESSIONS_DIR ?? fileURLToPath(new URL("../data/sessions", import.meta.url));
const recorder = new SessionRecorder({
  dir: sessionsDir,
  keep: Number(process.env.SESSIONS_KEEP ?? 60),
  maxBytes: Number(process.env.SESSIONS_MAX_MB ?? 500) * 1024 * 1024,
  strips: () => wing.strips,
  console: () => ({
    host,
    info: wing.status.consoleInfo,
    connected: wing.status.lastOscAt !== null && Date.now() - wing.status.lastOscAt < 15000,
  }),
  describe: (path) => wing.describeNode(path),
  onChange: (active) => {
    if (active && active.id !== sessionId) {
      // Sessão nova: histórico de alertas novo, e os alertas já na tela entram no registro.
      alerts.resetHistory();
      for (const a of alerts.list()) recorder.note(alertEntry("active", a));
      broadcastAlerts();
    }
    sessionId = active?.id ?? null;
    broadcast("session", active);
  },
});
let sessionId: string | null = null;
wing.on("osc", (path, value) => recorder.onOsc(path, value));
wing.on("meters", (strips) => recorder.onMeters(strips));

// Alertas ao vivo: só leem os medidores e o estado dos canais e avisam. Limites em ALERT_LIMITS (src/alerts.ts).
const alerts = new AlertEngine();
const meterWindow = new MeterWindow();
const startedAt = Date.now();
wing.on("meters", (strips) => meterWindow.push(Date.now(), strips));
const alertEntry = (action: string, a: Alert) =>
  ({ type: "alert", action, key: a.key, level: a.level, title: a.title, ...(a.channel ? { channel: a.channel } : {}) });
const alertState = () => ({ active: alerts.list(), history: alerts.history() });
function broadcastAlerts(): void {
  broadcast("alerts", alertState());
}
// Relógio próprio (como no automix): a queda da mesa só aparece pela falta de mensagens.
setInterval(() => {
  const t = Date.now();
  const ctx = alertContext(t, wing.strips, meterWindow, wing.status, startedAt, recorder.current?.moment ?? null);
  const { raised, cleared } = alerts.update(ctx);
  for (const a of raised) {
    recorder.note(alertEntry("raised", a));
    console.log(`Alerta (${a.level}): ${a.title}`);
  }
  for (const a of cleared) recorder.note(alertEntry("cleared", a));
  if (raised.length || cleared.length) broadcastAlerts();
}, 250);

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

wing.on("strip", (st) => broadcast("strip", st));
wing.on("status", (s) => broadcast("status", s));
wing.on("info", (info) => console.log(`Mesa respondeu: ${info}`));
wing.on("reply", (text) => console.log(`Mesa (/*): ${text}`));
// Qualquer valor vindo da mesa (GETs e eventos da assinatura /*s) vai para a página.
// Descrições de nó (texto com várias linhas) não entram nesse fluxo.
wing.on("osc", (path, value) => {
  if (value.kind === "string" && value.text.includes("\n")) return;
  broadcast("param", { path, value });
});

/** Corpo do pedido inválido: erro do cliente (400), com mensagem para a página. */
class BodyError extends Error {}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) throw new BodyError("corpo grande demais");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new BodyError("JSON inválido");
  }
}

function sendJson(res: http.ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

/** Estado completo para a página (channels mantido para compatibilidade). */
function snapshot() {
  return { status: wing.status, strips: wing.strips, kinds: STRIP_KINDS, channels: wing.channels };
}

const WRITE_ROUTE = /^\/api\/channels\/(\d+)\/(name|mute|fader|gain)$/;
const SOURCE_ROUTE = /^\/api\/channels\/(\d+)\/source$/;
// Escrita de um parâmetro por seção do canal: EQ, filtro, gate e compressor.
const SECTION_WRITE_ROUTE = /^\/api\/channels\/(\d+)\/(eq|flt|gate|dyn)$/;
const EQ_READ_ROUTE = /^\/api\/channels\/(\d+)\/eq$/;
const DYN_READ_ROUTE = /^\/api\/channels\/(\d+)\/dyn$/;

/** Mesa sem resposta: 502. Pedido inválido ou recusado pela descrição: 400. */
const writeErrorCode = (msg: string) => (msg.startsWith("Sem resposta") ? 502 : 400);

/** Exige JSON e origem local: impede que outro site no navegador dispare pedidos POST. */
function isLocalJson(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  return !!req.headers["content-type"]?.startsWith("application/json") &&
    (!origin || origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`);
}

const SESSION_ROUTE = /^\/api\/sessions\/([\w-]+)$/;

/** Gravação: iniciar, marcar momento e encerrar. Não fala com a mesa, então vale também em somente leitura. */
async function handleSession(req: http.IncomingMessage, res: http.ServerResponse, action: string): Promise<void> {
  if (!isLocalJson(req)) return sendJson(res, 403, { error: "Requisição recusada" });
  const body = (await readJson(req)) as { operator?: unknown; moment?: unknown };
  try {
    if (action === "start") return sendJson(res, 200, { active: recorder.start(body.operator, body.moment) });
    if (action === "moment") return sendJson(res, 200, { active: recorder.setMoment(body.moment) });
    if (action === "stop") return sendJson(res, 200, { session: recorder.stop() });
    return sendJson(res, 404, { error: "não encontrado" });
  } catch (e) {
    return sendJson(res, e instanceof SessionError ? e.code : 500, { error: (e as Error).message });
  }
}

/** Dispensar um alerta: só some da tela (não fala com a mesa); volta se a condição sumir e aparecer de novo. */
async function handleDismiss(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!isLocalJson(req)) return sendJson(res, 403, { error: "Requisição recusada" });
  const body = (await readJson(req)) as { id?: unknown };
  const alert = typeof body.id === "string" ? alerts.dismiss(body.id) : undefined;
  if (!alert) return sendJson(res, 404, { error: "Alerta não está ativo" });
  recorder.note(alertEntry("dismissed", alert));
  broadcastAlerts();
  sendJson(res, 200, { dismissed: alert.id });
}

async function handleWrite(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  if (!allowWrites) return sendJson(res, 403, { error: "Escrita desativada (WING_ALLOW_WRITES=1)" });
  if (!isLocalJson(req)) return sendJson(res, 403, { error: "Requisição recusada" });
  if (url.pathname === "/api/param") {
    const body = (await readJson(req)) as { path?: unknown; value?: unknown };
    if (typeof body.path !== "string" || !isSafePath(body.path)) return sendJson(res, 400, { error: "Caminho inválido" });
    try {
      return sendJson(res, 200, await writeParam(wing, body.path, body.value));
    } catch (e) {
      const msg = (e as Error).message;
      return sendJson(res, writeErrorCode(msg), { error: msg });
    }
  }
  if (url.pathname === "/api/sends") {
    // Um parâmetro de envio por pedido: {src: "ch/5", dest: "bus/3", param: "lvl", value, dryRun?}.
    const body = (await readJson(req)) as { src?: unknown; dest?: unknown; param?: unknown; value?: unknown; dryRun?: unknown };
    try {
      return sendJson(res, 200, await writeSend(wing, body.src, body.dest, body.param, body.value, body.dryRun === true));
    } catch (e) {
      const msg = (e as Error).message;
      return sendJson(res, writeErrorCode(msg), { error: msg });
    }
  }
  const sec = SECTION_WRITE_ROUTE.exec(url.pathname);
  if (sec) {
    // Um parâmetro por pedido. dryRun: só valida na descrição da mesa e devolve o comando.
    const body = (await readJson(req)) as { param?: unknown; value?: unknown; dryRun?: unknown };
    const write = sec[2] === "gate" || sec[2] === "dyn" ? writeChannelDyn : writeChannelEq;
    try {
      return sendJson(res, 200, await write(wing, Number(sec[1]), sec[2]!, body.param, body.value, body.dryRun === true));
    } catch (e) {
      const msg = (e as Error).message;
      return sendJson(res, writeErrorCode(msg), { error: msg });
    }
  }
  const m = WRITE_ROUTE.exec(url.pathname);
  if (!m) return sendJson(res, 404, { error: "não encontrado" });
  const ch = Number(m[1]);
  const body = (await readJson(req)) as { name?: unknown; mute?: unknown; db?: unknown };
  if (m[2] === "name") {
    const name = typeof body.name === "string" ? body.name : "";
    const invalid = validateChannelName(ch, name);
    if (invalid) return sendJson(res, 400, { error: invalid });
    const { readBack } = await wing.setChannelName(ch, name);
    return sendJson(res, 200, { ok: readBack === name, readBack });
  }
  if (!isValidChannel(ch)) return sendJson(res, 400, { error: `Canal inválido: ${ch}` });
  if (m[2] === "mute") {
    if (typeof body.mute !== "boolean") return sendJson(res, 400, { error: "mute deve ser true ou false" });
    const { readBack } = await wing.setChannelMute(ch, body.mute);
    return sendJson(res, 200, { ok: readBack === body.mute, readBack });
  }
  if (typeof body.db !== "number") return sendJson(res, 400, { error: "db deve ser um número" });
  const db = body.db;
  if (m[2] === "fader") {
    const invalid = validateFader(ch, db);
    if (invalid) return sendJson(res, 400, { error: invalid });
    const { readBack } = await wing.setChannelFader(ch, db);
    const ok = db <= FADER_MIN_DB ? readBack <= FADER_MIN_DB : Math.abs(readBack - db) <= 0.5;
    return sendJson(res, 200, { ok, readBack });
  }
  const invalid = validateGain(db);
  if (invalid) return sendJson(res, 400, { error: invalid });
  const { readBack, source } = await wing.setChannelGain(ch, db);
  // Pré locais andam em passos de 2,5 dB: a mesa arredonda para o passo mais próximo.
  sendJson(res, 200, {
    ok: Math.abs(readBack - db) <= 1.25, readBack, source,
    command: describeMessage(gainMessage(source, db)), risk: riskWarning(gainAddress(source)!),
  });
}

// Medidores chegam em alta taxa; repassa ao navegador no máximo ~15x por segundo.
let meterPending = false;
wing.on("meters", () => {
  if (meterPending) return;
  meterPending = true;
  setTimeout(() => {
    meterPending = false;
    // { ch: [{l, r} | null, ...], aux: [...], ... }
    const out: Record<string, unknown> = {};
    for (const [kind, list] of Object.entries(wing.strips)) out[kind] = list.map((s) => s.meter);
    broadcast("meters", out);
  }, 66);
});

// Erro inesperado num pedido vira 500; sem o catch a rejeição derrubaria o servidor no meio do culto.
// O detalhe (caminhos de arquivo, pilha) fica só no log; a página recebe uma mensagem genérica.
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((e: unknown) => {
    const bodyError = e instanceof BodyError;
    if (!bodyError) console.error("Erro no pedido", req.method, req.url, e);
    if (res.headersSent) res.end();
    else sendJson(res, bodyError ? 400 : 500, { error: bodyError ? e.message : "Erro interno no servidor" });
  });
});

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "POST") {
    // Erros que os handlers não tratam caem no catch do createServer.
    const ses = SESSION_ROUTE.exec(url.pathname);
    if (ses) await handleSession(req, res, ses[1]!);
    else if (url.pathname === "/api/alerts/dismiss") await handleDismiss(req, res);
    else await handleWrite(req, res, url);
    return;
  }
  if (req.method !== "GET") {
    res.writeHead(405).end();
    return;
  }
  if (url.pathname === "/") {
    const body = await readFile(indexPath); // antes do writeHead: arquivo faltando vira 500
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  } else if (url.pathname === "/api/describe") {
    // Só leitura: descrição do nó (",s #") com os valores atuais e avisos de risco.
    const path = url.searchParams.get("path") ?? "/";
    if (path !== "/" && !isSafePath(path)) return sendJson(res, 400, { error: "Caminho inválido" });
    try {
      const children = await wing.describeNode(path);
      const base = path === "/" ? "" : path;
      sendJson(res, 200, {
        path,
        children: children.map((c) => {
          const p = `${base}/${c.name}`;
          // Somente leitura não tem risco: a mesa não deixa escrever.
          return { ...c, path: p, risk: c.kind === "param" && !c.readOnly ? riskWarning(p) : null };
        }),
      });
    } catch (e) {
      sendJson(res, 502, { error: (e as Error).message });
    }
  } else if (url.pathname === "/api/sends") {
    // Só leitura: envios de todas as fontes para um destino (ex.: ?dest=bus/3, ?dest=mtx/2).
    const dest = parseDest(url.searchParams.get("dest") ?? "");
    if (!dest) return sendJson(res, 400, { error: "Destino inválido (use bus/1..16 ou mtx/1..8)" });
    try {
      const values = await wing.readMany(sendPaths(dest));
      sendJson(res, 200, { dest, key: destKey(dest), rows: buildSendRows(dest, values) });
    } catch (e) {
      sendJson(res, 502, { error: (e as Error).message });
    }
  } else if (url.pathname === "/api/risk") {
    // Aviso extra mostrado na confirmação da página (não fala com a mesa).
    const path = url.searchParams.get("path") ?? "";
    if (!isSafePath(path)) return sendJson(res, 400, { error: "Caminho inválido" });
    sendJson(res, 200, { path, risk: riskWarning(path) });
  } else if (url.pathname === "/api/param") {
    const path = url.searchParams.get("path") ?? "";
    if (!isSafePath(path)) return sendJson(res, 400, { error: "Caminho inválido" });
    try {
      sendJson(res, 200, { path, value: await wing.getParam(path) });
    } catch (e) {
      sendJson(res, 502, { error: (e as Error).message });
    }
  } else if (STATIC_FILES.has(url.pathname)) {
    const file = STATIC_FILES.get(url.pathname)!;
    const body = await readFile(file.path);
    res.writeHead(200, { "content-type": `${file.type}; charset=utf-8` });
    res.end(body);
  } else if (DYN_READ_ROUTE.test(url.pathname)) {
    // Só leitura: gate e compressor do canal, com tudo o que a descrição da mesa traz.
    try {
      sendJson(res, 200, await readChannelDyn(wing, Number(DYN_READ_ROUTE.exec(url.pathname)![1])));
    } catch (e) {
      sendJson(res, e instanceof DynRequestError ? 400 : 502, { error: (e as Error).message });
    }
  } else if (EQ_READ_ROUTE.test(url.pathname)) {
    // Só leitura: EQ e filtro do canal, com faixas e valores da descrição da mesa.
    try {
      sendJson(res, 200, await readChannelEq(wing, Number(EQ_READ_ROUTE.exec(url.pathname)![1])));
    } catch (e) {
      sendJson(res, e instanceof EqRequestError ? 400 : 502, { error: (e as Error).message });
    }
  } else if (SOURCE_ROUTE.test(url.pathname)) {
    // Só leitura: qual fonte alimenta o canal (para mostrar na confirmação de ganho).
    try {
      sendJson(res, 200, await wing.getChannelSource(Number(SOURCE_ROUTE.exec(url.pathname)![1])));
    } catch (e) {
      sendJson(res, 400, { error: (e as Error).message });
    }
  } else if (url.pathname === "/api/alerts") {
    sendJson(res, 200, { ...alertState(), limits: ALERT_LIMITS });
  } else if (url.pathname === "/api/sessions") {
    sendJson(res, 200, { active: recorder.current, moments: MOMENTS, dir: sessionsDir, sessions: recorder.list() });
  } else if (SESSION_ROUTE.test(url.pathname)) {
    // Registro bruto da sessão (JSONL), uma linha por evento.
    try {
      const text = recorder.read(SESSION_ROUTE.exec(url.pathname)![1]!);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(text);
    } catch (e) {
      sendJson(res, e instanceof SessionError ? e.code : 500, { error: (e as Error).message });
    }
  } else if (url.pathname === "/api/state") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(snapshot()));
  } else if (url.pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    res.write(`event: session\ndata: ${JSON.stringify(recorder.current)}\n\n`);
    res.write(`event: alerts\ndata: ${JSON.stringify(alertState())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
  } else {
    res.writeHead(404).end("não encontrado");
  }
}

// Só escuta em localhost: a interface não fica exposta na rede.
server.listen(port, "127.0.0.1", () => {
  const mode = allowWrites ? "ESCRITA LIBERADA" : "somente leitura";
  console.log(`WING ${host} — interface em http://localhost:${port} (${mode})`);
});

setInterval(() => {
  if (wing.status.lastOscAt === null || Date.now() - wing.status.lastOscAt > 15000) {
    wing.status.error = `Sem resposta OSC de ${host}:2223`;
    broadcast("status", wing.status);
  }
}, 5000);

await wing.start();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    recorder.close();
    wing.close();
    server.close();
    process.exit(0);
  });
}
