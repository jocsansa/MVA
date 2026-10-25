// Servidor local: lê a WING e mostra o estado no navegador (http://localhost:PORT).
// Por padrão é SOMENTE LEITURA. Escritas só com WING_ALLOW_WRITES=1.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  FADER_MIN_DB,
  WingClient,
  isValidChannel,
  validateChannelName,
  validateFader,
  validateGain,
} from "./wing.ts";
import { isSafePath, riskWarning } from "./schema.ts";
import { STRIP_KINDS } from "./strips.ts";
import { buildSendRows, destKey, parseDest, sendPaths } from "./sends.ts";

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

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) throw new Error("corpo grande demais");
  }
  return JSON.parse(body);
}

function sendJson(res: http.ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * Diferença aceita entre o valor pedido e o lido de volta: a mesa arredonda para o passo
 * mais próximo (ex.: ganho AES50 em passos de 2,5 dB). Para log, meio passo relativo.
 */
function paramTolerance(min = 0, max = 0, steps = 0, type = "lin"): number {
  if (type === "int") return 0;
  // Fader: 1024 passos não lineares em dB (mais finos perto de 0 dB).
  if (type === "fader") return 0.5;
  if (!steps || steps < 2) return 0.01;
  if (type === "log" && min > 0) return max * (Math.pow(max / min, 1 / (steps - 1)) - 1);
  return (max - min) / (steps - 1) / 2 + 1e-6;
}

/** Estado completo para a página (channels mantido para compatibilidade). */
function snapshot() {
  return { status: wing.status, strips: wing.strips, kinds: STRIP_KINDS, channels: wing.channels };
}

const WRITE_ROUTE = /^\/api\/channels\/(\d+)\/(name|mute|fader|gain)$/;
const SOURCE_ROUTE = /^\/api\/channels\/(\d+)\/source$/;

async function handleWrite(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  if (!allowWrites) return sendJson(res, 403, { error: "Escrita desativada (WING_ALLOW_WRITES=1)" });
  // Exige JSON e origem local: impede que outro site no navegador dispare escritas.
  const origin = req.headers.origin;
  if (!req.headers["content-type"]?.startsWith("application/json") ||
      (origin && origin !== `http://localhost:${port}` && origin !== `http://127.0.0.1:${port}`)) {
    return sendJson(res, 403, { error: "Requisição recusada" });
  }
  if (url.pathname === "/api/param") {
    const body = (await readJson(req)) as { path?: unknown; value?: unknown };
    if (typeof body.path !== "string" || !isSafePath(body.path)) return sendJson(res, 400, { error: "Caminho inválido" });
    const { readBack, desc } = await wing.setParam(body.path, body.value);
    const ok = desc.type === "list" || desc.type === "string"
      ? readBack.text === body.value
      : readBack.kind !== "string" && typeof body.value === "number" &&
        Math.abs(readBack.value - body.value) <= paramTolerance(desc.min, desc.max, desc.steps, desc.type);
    return sendJson(res, 200, { ok, readBack });
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
  sendJson(res, 200, { ok: Math.abs(readBack - db) <= 1.25, readBack, source });
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "POST") {
    try {
      await handleWrite(req, res, url);
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
    return;
  }
  if (req.method !== "GET") {
    res.writeHead(405).end();
    return;
  }
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(await readFile(indexPath));
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
  } else if (SOURCE_ROUTE.test(url.pathname)) {
    // Só leitura: qual fonte alimenta o canal (para mostrar na confirmação de ganho).
    try {
      sendJson(res, 200, await wing.getChannelSource(Number(SOURCE_ROUTE.exec(url.pathname)![1])));
    } catch (e) {
      sendJson(res, 400, { error: (e as Error).message });
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
    clients.add(res);
    req.on("close", () => clients.delete(res));
  } else {
    res.writeHead(404).end("não encontrado");
  }
});

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
    wing.close();
    server.close();
    process.exit(0);
  });
}
