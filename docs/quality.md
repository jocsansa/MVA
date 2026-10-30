# Qualidade

## Comandos

| Comando | O que faz |
|---|---|
| `npm run typecheck` | `tsc --noEmit` (strict, `noUncheckedIndexedAccess`, `erasableSyntaxOnly`) |
| `npm run lint` | ESLint 10 + typescript-eslint 8, com regras de tipo (`eslint.config.mjs`) |
| `npm run verify:rules` | Autoteste das regras copiadas do toolkit (`eslint-rules/`) |
| `npm test` | `node:test` em `test/**/*.test.ts` (mesa falsa em `test/fake-wing.ts`) |
| `npm run check` | Os quatro acima, em sequência. Não publica nem fala com a mesa real |
| `npm run smoke` | Página num Chrome headless, desktop e 390 px (servidor rodando, de preferência no simulador) |

Não há build nem CI. No Windows use `npm.cmd`.

## Regras de lint

- `@typescript-eslint/no-floating-promises` e `no-misused-promises` em **error** (src e test).
  `test()` do `node:test` é isento porque o runner aguarda a promessa.
- `quality/max-lines` (350 linhas, do toolkit) em **warn**. Contagem na adoção (29/10/2026):
  5 arquivos — `public/app.js` 2307, `src/wing.ts` 581, `src/recorder.ts` 480,
  `src/simulator.ts` 465, `src/server.ts` 415 (contagem do lint). Plano: dividir por responsabilidade quando o arquivo
  for mexido por outro motivo (o `app.js` primeiro, por aba). Quando zerar, passa para error.
- `typescript-eslint` recommended + `@eslint/js` recommended. Não baixar severidade nem usar ignores
  amplos para esconder aviso; `eslint-rules/` é cópia do toolkit e não se edita aqui.

## Estratégia de testes

- Lógica pura (OSC, descrição de nós, medidores, alertas, gravador, `mixer-lib`) com testes diretos.
- Cliente da WING contra a mesa falsa: toda leitura e todo `dryRun` conferem `fake.writes.length === 0`;
  escritas conferem a mensagem exata e a leitura de volta.
- Página: `test/ui.test.ts` lê `index.html`, `app.css` e `app.js` (estrutura, ids, rotas usadas) e
  roda o `mixer-lib`; o comportamento real fica no `npm run smoke` e em testes manuais no simulador.
- Correção de bug: reproduzir primeiro e deixar teste de regressão quando der.

## Teste na mesa real

Só com o usuário presente e autorizando cada comando. Um comando por vez, num canal sem entrada,
mostrando o comando exato antes e revertendo depois. O que foi confirmado vai para "Testado na mesa
real" no README. Pendências: escrita de ganho, palavras 0/1 do medidor, limites dos alertas.

## Revisão depois de implementar ou corrigir

Escolha o escopo pelo risco do diff: comportamento e regressões; segurança da escrita na mesa e das
rotas; integração com a WING (protocolo, firmware 3.1); UX no celular. Mudança não trivial ganha
revisão independente (subagente só leitura ou `/code-review`), lendo também chamadores, contratos e
testes afetados. Termina quando os achados relevantes estão resolvidos ou com decisão registrada e
`npm run check` passa. Mais rodadas só com evidência nova ou pedido explícito.

## Revisão de segurança

Prompt reutilizável em [security-review.md](security-review.md) (repositório inteiro ou diff),
copiado do toolkit na revisão `790a895`. Atalho para o diff atual: `/security-review` no Claude Code.
Relatório privado fora do repositório; a revisão nunca envia comando para a mesa.

## Avaliação do harness (Harness2, adaptação nativa)

Modo: adaptação nativa do método do Harness2 (não executa o framework nem reproduz seus resultados).
Quando reavaliar: mudança material em AGENTS.md/CLAUDE.md, plugins, versão do cliente ou política de
modelos, ou falha observada de um agente seguindo as instruções.

Como rodar (toolkit em `docs/07-harness-evaluation.md` e `docs/prompts/14-harness-evaluation.md`):

1. Clonar o toolkit numa pasta temporária fora do projeto e anotar a revisão.
2. Copiar `templates/harness-evaluation/` para uma pasta descartável por caso e confirmar a falha
   da linha de base com `node <toolkit>/scripts/validate-harness.mjs <cópia>`.
3. Dar a tarefa a um agente de contexto limpo (correção de fronteira, handoff desatualizado,
   revisão só leitura) e conferir de forma independente: avaliador, diff, arquivos preservados.
4. Caso do projeto: pedir a um agente novo, só leitura, os comandos e as regras da mesa real
   "a partir dos arquivos do projeto" e conferir as citações.
5. Falha observada: uma comparação de candidato (mudança mínima nas instruções, mesmo caso, mesmo
   avaliador). Sem falha, não inventar mudança. Registrar em docs/setup.md.

## Handoff entre sessões

Trabalho que não termina numa sessão: handoff curto no próprio pedido/plano com objetivo, estado
verificado, checagens, pendências, bloqueios, processos em execução e próxima ação. Ao retomar,
conferir arquivos, `git status` e processos antes de confiar no handoff.
