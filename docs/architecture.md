# Código e arquitetura

## Stack

- Node.js ≥ 22.18 (testado no 24) rodando TypeScript direto (`erasableSyntaxOnly`: sem enums nem
  parameter properties). Sem build e sem dependências de execução.
- Desenvolvimento: TypeScript 5.9, ESLint 10 + typescript-eslint 8, testes com `node:test`.
- Página: HTML, CSS e JavaScript puros, sem framework.

## Mapa do código

| Arquivo | Papel |
|---|---|
| `src/server.ts` | Servidor HTTP local (127.0.0.1): rotas `/api/*`, SSE em `/api/events`, arquivos da página, liga gravador e alertas. Erro inesperado vira 500 genérico (detalhe só no log); corpo inválido vira 400 |
| `src/static-files.ts` | Rotas dos arquivos da página (`/app.css`, `/app.js`, `/eq-curve.js`) → arquivo em `public/` e tipo; separado para o teste conferir sem subir o servidor |
| `src/wing.ts` | Cliente da WING: OSC (UDP 2223), assinatura `/*s`, heartbeat, medidores; escrita só por `write()` privado e só com `allowWrites` |
| `src/osc.ts` | Codificação/decodificação OSC 1.0 |
| `src/native.ts` | Protocolo nativo (TCP 2222, canal 3) para pedir medidores |
| `src/schema.ts` | Descrição de nós (`<nó> ,s #`), validação de valores e avisos de risco |
| `src/strips.ts` | Tipos de strip, quantidades e decodificação dos pacotes de medidor |
| `src/eq.ts`, `src/dyn.ts`, `src/sends.ts` | EQ/filtro, gate/compressor e envios em cima da base genérica |
| `src/recorder.ts` | Gravação das sessões em JSONL (`data/sessions`), rotação e leitura |
| `src/alerts.ts` | Regras dos alertas ao vivo (`ALERT_LIMITS`), motor e janela de picos; funções puras |
| `src/simulator.ts` | Mesa WING simulada (OSC, descrição de nós, medidores) |
| `src/discover.ts` | Descoberta da WING na rede (UDP 2222) |
| `public/index.html` | Marcação da página e o bloco `mixer-lib` (funções puras, testadas em `test/ui.test.ts`) |
| `public/app.css` | Estilos da página |
| `public/app.js` | Comportamento da página: DOM, rede, SSE (script clássico, usa `MixerLib`) |
| `public/eq-curve.js` | Curva de resposta do EQ (módulo ES, também importado pelos testes) |
| `test/fake-wing.ts` | Mesa falsa dos testes: registra escritas e responde GETs |
| `scripts/ui-smoke.mjs` | Smoke da página num Chrome headless |
| `eslint-rules/`, `scripts/verify-quality-rules.mjs` | Regras de lint do toolkit (cópia) e autoteste |

## Fronteiras e fluxo

```
WING ──OSC UDP 2223──▶ wing.ts ──estado/eventos──▶ server.ts ──SSE──▶ página (app.js)
     ◀─nativo TCP 2222─┘   ▲  medidores via UDP         │  ├─▶ recorder.ts ─▶ data/sessions/*.jsonl
                           │                             │  └─▶ alerts.ts (a cada 250 ms)
                           └──── escrita (só allowWrites) ◀── POST /api/* ◀── página / curl
```

- **Escrita**: só passa por `WingClient` com `WING_ALLOW_WRITES=1`. Antes de escrever, o valor é
  conferido contra a descrição atual do nó; depois, lido de volta. `dryRun` devolve o comando exato.
- **POST** exige `content-type: application/json` e origem local (`isLocalJson`).
- **Gravação e alertas** recebem eventos e medidores; não têm acesso ao caminho de escrita.
- O servidor escuta só em `127.0.0.1`. Erro inesperado num pedido vira 500 sem derrubar o processo.

## Dados

- Sem banco. Sessões em JSONL, uma linha por evento, em `data/sessions/` (`SESSIONS_DIR`), fora do
  git; rotação por quantidade (`SESSIONS_KEEP`) e tamanho (`SESSIONS_MAX_MB`).

## Decisões

- Sem dependências de execução: facilita instalar em qualquer PC da igreja.
- A página continua sem bundler: `mixer-lib` fica embutido no HTML porque os testes o avaliam direto
  do arquivo; o resto do script fica em `public/app.js`.
- Medidores pelo protocolo nativo porque o OSC da WING não entrega medidores.

## Manutenção

Novo módulo, rota ou fronteira: atualize o mapa e o fluxo acima. Rotas e uso continuam no README.
