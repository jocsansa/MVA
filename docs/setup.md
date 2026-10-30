# Setup e evidências

## Origem e contexto

- Toolkit: [Vibe Coding Toolkit](https://github.com/soumatheusgomes/vibe-coding-toolkit), revisão
  `790a895` (18/10/2026), prompt 12 ("existing project setup"). Clonado numa pasta temporária fora
  do projeto; todos os guias e templates vêm dessa revisão.
- Execução: 28–29/10/2026, Claude Code 2.1.293 no Windows 10 (Git Bash + PowerShell 5.1), modelo
  principal Claude Opus 5.5. Node 24.19, npm 11.17.
- Ponto de partida: commit `b956dee` (etapas 4–6), árvore limpa. Linha de base: typecheck ok,
  115/115 testes; sem lint, build ou CI.
- Decisões do Jocsan: commitar as etapas antes (feito por ele), instalar Superpowers/Ponytail/Caveman,
  adotar lint e dividir o `index.html`, documentos em português. Sem commit, sem push, sem comando na
  mesa real.

## Componentes

| Componente | Ação e motivo | Escopo | Estado e evidência |
|---|---|---|---|
| AGENTS.md / CLAUDE.md | Criados: comandos, regras da mesa real, combinados, mapa. CLAUDE.md importa AGENTS.md | Projeto | Validado: agente novo achou comandos e regras citando as linhas |
| PRODUCT.md, docs/architecture.md, docs/design.md, docs/quality.md | Criados só com fatos observados; pendências marcadas | Projeto | Escritos |
| docs/onboarding.md | **Não criado**: o README já é o guia de instalação e uso (equivalente canônico) | — | Mapeado no README |
| Superpowers 7.0.0 | Instalado (`claude plugin install superpowers@claude-plugins-official`) | Usuário | Instalado e habilitado; **carregamento numa sessão nova não observado** |
| Ponytail 5.3.3 | Instalado; opções de webhook/ledger ficaram sem valor (externas, opcionais) | Usuário | Instalado e habilitado; carregamento não observado |
| Caveman 4.0.1 | Instalado; hooks conferidos (scripts Node locais, sem rede) | Usuário | Instalado e habilitado; carregamento não observado |
| Context7 | Aprovado pelo Jocsan: `claude mcp add --transport http --scope project context7 https://mcp.context7.com/mcp` gerou `.mcp.json`; `enabledMcpjsonServers` em `.claude/settings.local.json` (local, no `.gitignore`) | Projeto | Configurado; `claude mcp get` ainda mostra "Pending approval" nesta sessão. **Ativo só depois de reabrir o Claude Code** e conferir com `/mcp` |
| RTK | Não instalado: sem brew no Windows e o hook altera configuração global; ganho pequeno aqui | — | Bloqueado por pré-requisito da máquina |
| Graphify | Não aplicado: 14 arquivos de código, mapa em docs/architecture.md basta | — | Inaplicável por ora |
| Skills Vercel, next-dev-loop, next-bundle-optimizer, shadcn | Projeto não usa Next/React nem shadcn | — | Inaplicável |
| supabase-postgres, Sentry MCP, gh-fix-ci | Sem banco (JSONL), sem Sentry, sem GitHub Actions/Codex | — | Inaplicável |
| Revisão de segurança | Prompt 13 copiado em docs/security-review.md; `/security-review` do cliente reaproveitado | Projeto | Configurado; caso de avaliação só leitura passou |
| differential-review | Coberto pelo item acima | — | Não instalado |
| Navegador | Driver CDP próprio vira `scripts/ui-smoke.mjs` (`npm run smoke`); dispensa agent-browser e Chrome DevTools MCP | Projeto | Validado (28/28 ok; URL sem servidor dá FALHA em ~45 s, sem travar) |
| Memória | Memória nativa do Claude, índice curto com 3 preferências do Jocsan | Cliente | Escrita em `~/.claude/projects/c--users-jocsa-documents-mva/memory/`; recuperação numa sessão nova não observada |
| Harness2 | Adaptação nativa (não executa o framework); procedimento em docs/quality.md | Projeto | 4 casos rodados (abaixo) |
| ESLint + regras do toolkit | ESLint 10.13, typescript-eslint 8.72, `@eslint/js` 10, `globals` 17; `quality/max-lines` copiada do toolkit com autoteste | Projeto | `npm run lint` 0 erros / 5 avisos; `verify:rules` ok |
| Limite de 350 linhas | `index.html` dividido em `app.css` e `app.js`; demais arquivos em warn com contagem | Projeto | `index.html` 3075 → 333 linhas |
| CI | Não criado: não há Actions e o pedido exclui push | — | Pendente se for desejado |
| Hooks, Codex, aia-harness, plugins extras, Obsidian | Sem necessidade concreta | — | Inaplicável |

## Mudanças no código

- `public/index.html` dividido sem alterar conteúdo (script em `scratchpad`): estilos em
  `public/app.css`, comportamento em `public/app.js`; `mixer-lib` continua embutido (os testes o
  avaliam do HTML).
- `src/server.ts`: entrega `/app.css` e `/app.js` (mapa `STATIC_FILES` em `src/static-files.ts`,
  junto com `/eq-curve.js`).
  O lint achou o handler `async` passado ao `createServer`: um erro num GET (ex.: arquivo da página
  ausente) virava rejeição sem tratamento e derrubava o processo. Agora vira 500 e o servidor segue.
- `test/ui.test.ts`: checagens de estrutura leem HTML + CSS + JS; teste novo para o carregamento dos
  dois arquivos e as rotas do servidor.
- `package.json`: scripts `lint`, `verify:rules`, `smoke`; `check` inclui lint e regras.
- README: `check` atualizado (o agente de descoberta achou a descrição antiga), smoke e mapa dos docs.

## Checagens

| Item | Estado | Evidência |
|---|---|---|
| `npm run check` | Validado | typecheck ok, lint 0 erros, regras ok, 116/116 testes |
| Regras de promessa pegam erro real | Validado | código de teste via stdin: 1 floating + 1 misused; `test()` do node:test não acusa |
| `npm audit` | Validado | 0 vulnerabilidades |
| Página no simulador | Validado | `npm run smoke` 28/28 (1366 px e 390 px); GET `/app.css`, `/app.js`, `/eq-curve.js` 200 com tipo certo; rota inexistente 404 |
| Servidor em somente leitura no teste | Validado | servidor reiniciado sem `WING_ALLOW_WRITES`; nenhum comando para a mesa real |
| Plugins numa sessão nova | Não executado | precisa reiniciar o Claude Code e conferir os skills |

## Avaliação do harness (29/10/2026)

Toolkit `790a895`; avaliador `scripts/validate-harness.mjs` sha256 `ebc2cdd0…5b8c`. Subagentes de
contexto limpo no mesmo cliente (**não** é um cliente reiniciado). Linha de base confirmada: 5/7, com
as falhas esperadas (tenant cruzado e identidade inválida).

| Caso | Modelo | Resultado | Observação independente |
|---|---|---|---|
| Correção de fronteira | Sonnet | Passou | avaliador 7/7; AGENTS.md e notas preservados; diff mínimo |
| Handoff desatualizado | Sonnet | Passou | rejeitou o "7/7" falso, corrigiu, avaliador 7/7, handoff atualizado. Não rodou a linha de base antes de editar (inferiu pelo código) |
| Revisão só leitura | Sonnet | Passou | hashes da fixture iguais antes/depois; relatório privado com tenant cruzado, ator/registro concretos, local e impacto |
| Descoberta das instruções do MVA | Haiku | Passou | achou `npm run check`, `npm.cmd`, regra da mesa real, simulador e `ALERT_LIMITS` com linhas; **apontou o README desatualizado** → corrigido |

Falha observada: só a inconsistência do README (documentação, não comportamento do agente); corrigida
direto, sem comparação de candidato. Uma passada é teste de fumaça, não taxa de confiabilidade.
Casos não rodados: reaplicar setup, conflito de recursos, bloqueio parcial, pausar/retomar.

## Revisão independente do diff

Revisor só leitura (Opus, contexto limpo) sobre o diff contra `b956dee`. Sem achados graves; a
divisão do `index.html` foi conferida byte a byte (só os comentários de cabeçalho são novos).
Achados baixos corrigidos: arquivo da página faltando agora vira 500 (lido antes do `writeHead`), a
checagem do teste sobre `STATIC_FILES` confere rota e tipo, e o smoke dá mensagem clara se o Chrome
não responder. Mantido: o smoke usa `localhost:3000` por padrão e, se o servidor estiver na mesa real,
só lê (não clica em controles). Depois das correções: `npm run check` ok (116/116) e smoke 26/26.

Segunda revisão (`/code-review`, 29/10/2026, 24 arquivos pendentes), 9 achados, todos aplicados:

- Smoke: o Chrome escolhe a porta de depuração (`--remote-debugging-port=0` + `DevToolsActivePort`),
  então não se conecta a outro Chrome; todas as esperas têm prazo e erro vira FALHA em vez de travar;
  as checagens repetem até 20 s em vez de esperar 4 s fixos. Achado ao testar: "app.css aplicado"
  passava na página de erro do Chrome; agora confere a folha `/app.css` carregada.
- Servidor: mapa dos arquivos da página em `src/static-files.ts` (sem `!`); um só tratamento de erro
  (o catch do `createServer`); erro inesperado devolve "Erro interno no servidor" e o detalhe vai só
  para o log; JSON inválido ou corpo grande demais vira 400 (antes 500 com a mensagem crua).
- Teste: confere que cada rota do mapa abre o arquivo certo de `public/` com o tipo certo.
- `scripts/verify-quality-rules.mjs`: cabeçalho em português com o uso real; corpo igual ao toolkit.
- `docs/quality.md`: contagem do `server.ts` atualizada.

Resultado: `npm run check` ok (tipos, lint 0 erros / 5 avisos, regras, 116/116); smoke 28/28 no
simulador com servidor só leitura; POST de escrita recusado (403, somente leitura).

## Delegação

Subagentes só quando isolar contexto ou paralelizar compensa. Modelos usados: Haiku (descoberta só
leitura), Sonnet (casos de fixture), Opus (revisão do diff). Um escritor por arquivo; o coordenador
confere diff e checagens.

## Pendências e próxima ação

1. **Context7**: reabrir o Claude Code, aceitar o servidor se o aviso aparecer e conferir em `/mcp`.
2. **Plugins**: abrir uma sessão nova e conferir que Superpowers, Ponytail e Caveman carregam
   (`/plugin` ou a lista de skills).
3. **Tamanho de arquivos**: 5 avisos de `max-lines`; dividir `public/app.js` por aba quando for mexer.
4. **Mesa real** (com o Jocsan presente): palavras 0/1 do medidor, limites dos alertas, escrita de ganho.

## Repetir o setup

Clonar o toolkit numa pasta temporária, anotar a revisão e rodar o prompt 12 de novo. Preservar
AGENTS.md, CLAUDE.md e os docs (mesclar, não sobrescrever); `eslint-rules/` e
`scripts/verify-quality-rules.mjs` se atualizam copiando da revisão nova e rodando
`npm run verify:rules`. Não reinstalar plugins já habilitados (`claude plugin list`).
